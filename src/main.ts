import { Actor, type KeyValueStore, log } from 'apify';

import { detailUrl, fetchBoard, isValidSlug, srDetailDescription } from './ats.js';
import { DuplicateTracker, mergeRoles } from './dedupe.js';
import { discoverCompany, domainOf, parseBoardUrl, registrableDomain, seedLookup } from './discovery.js';
import { Emitter } from './emitter.js';
import { compileFilters, matches } from './filters.js';
import { AtsClient, CareersFetcher, HostGate, HttpError } from './http.js';
import { scrubPII } from './normalize.js';
import { buildClosedRow, buildJobRow, jobFingerprint, type RowContext } from './rows.js';
import { SEED_BOARDS } from './seed.js';
import { applyHistory, type BoardState, type DiscoveryCacheEntry, discoveryKey, stateKey } from './state.js';
import {
    type ActorInput,
    type Ats,
    ATS_API_HOSTS,
    ATS_LIST,
    BOARD_CONCURRENCY,
    type BoardRef,
    type BoardRow,
    CHARGE_EVENTS,
    type CompanyRow,
    type DedupeMode,
    DISCOVERY_CACHE_DAYS,
    type ErrorRow,
    type JobRow,
    LIMITS,
    PRICES_USD,
    SCHEMA_VERSION,
} from './types.js';

await Actor.init();

const startedAt = new Date().toISOString();
const emitter = new Emitter();
const stop = { aborting: false, reason: '' as string };
Actor.on('aborting', async () => {
    stop.aborting = true;
    stop.reason = 'aborted';
    await emitter.flush();
    log.warning('Aborting: will stop after the current board.');
});

const raw = ((await Actor.getInput<ActorInput>()) ?? {}) as ActorInput;
const clampInt = (v: unknown, def: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
    return Math.max(min, Math.min(max, n));
};
const strList = (v: unknown): string[] =>
    Array.isArray(v)
        ? v
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.trim())
              .filter(Boolean)
        : [];

const input = {
    companies: strList(raw.companies),
    boards: Array.isArray(raw.boards) ? raw.boards : [],
    useSeedList: raw.useSeedList === true,
    discover: raw.discover !== false,
    dedupe: (['none', 'exact', 'role'].includes(String(raw.dedupe)) ? raw.dedupe : 'exact') as DedupeMode,
    includeDescription: raw.includeDescription === 'text' ? 'text' : 'none',
    scrubPII: raw.scrubPII !== false,
    confirmOpen: raw.confirmOpen === 'detail' ? 'detail' : 'none',
    maxOpenChecks: clampInt(raw.maxOpenChecks, 200, 1, LIMITS.maxOpenChecks),
    maxJobs: clampInt(raw.maxJobs, 5000, 1, LIMITS.maxJobs),
    maxJobsPerBoard: clampInt(raw.maxJobsPerBoard, 10_000, 1, LIMITS.maxJobsPerBoard),
    longOpenDays: clampInt(raw.longOpenDays, 60, 1, 3650),
    trackChanges: raw.trackChanges !== false,
    emitClosed: raw.emitClosed !== false,
    stateStoreName:
        typeof raw.stateStoreName === 'string' && raw.stateStoreName.trim()
            ? raw.stateStoreName.trim()
            : 'fairquery-jobs-feed-state',
};
const { filters, errors: filterErrors } = compileFilters(raw);
if (filters.onlyNew && !input.trackChanges) input.trackChanges = true;

const counters = {
    companies_requested: input.companies.length,
    boards_requested: input.boards.length,
    companies_discovered: 0,
    companies_from_cache: 0,
    companies_from_seed: 0,
    companies_unresolved: 0,
    boards_scanned: 0,
    boards_failed: 0,
    jobs_listed: 0,
    jobs_matched: 0,
    jobs_emitted: 0,
    jobs_merged: 0,
    jobs_exact_duplicates: 0,
    closed_emitted: 0,
    reposts_detected: 0,
    long_open: 0,
    open_checks: 0,
    open_checks_closed: 0,
    errors: 0,
};

const gate = new HostGate();
const client = new AtsClient(gate);
const careers = new CareersFetcher(gate);
const dupes = new DuplicateTracker();
const emittedKeys = new Set<string>();
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : NaN;
const shouldStop = (): boolean => {
    if (stop.aborting || emitter.limitReached) {
        stop.reason ||= emitter.limitReached ? 'max_cost_per_run' : 'aborted';
        return true;
    }
    if (counters.jobs_emitted >= input.maxJobs) {
        stop.reason ||= 'max_jobs';
        return true;
    }
    if (Number.isFinite(timeoutAt) && timeoutAt - Date.now() < 25_000) {
        stop.reason ||= 'run_timeout';
        return true;
    }
    return false;
};

let store: KeyValueStore | null = null;

// ---------------- validate ----------------
for (const msg of filterErrors)
    await pushError({ code: 'INVALID_INPUT', message: msg, retryable: false, source_url: null });
if (filterErrors.length) await finish({ exitCode: 1, statusMessage: `INVALID_INPUT: ${filterErrors[0]}` });
if (!/^[a-zA-Z0-9-]{3,63}$/.test(input.stateStoreName)) {
    await pushError({
        code: 'INVALID_INPUT',
        message: 'stateStoreName must be 3-63 letters, digits or hyphens.',
        retryable: false,
        source_url: null,
    });
    await finish({ exitCode: 1, statusMessage: 'INVALID_INPUT: stateStoreName' });
}
if (!input.companies.length && !input.boards.length && !input.useSeedList) {
    await pushError({
        code: 'INPUT_EMPTY',
        message: 'Provide companies (names, domains or board URLs), boards ([{ats, slug}]) or set useSeedList: true.',
        retryable: false,
        source_url: null,
    });
    // Fail fast: never fall back to sample input; error rows are not charged.
    await finish({ exitCode: 1, statusMessage: 'INPUT_EMPTY: provide companies, boards or useSeedList' });
}
if (input.companies.length > LIMITS.companies) {
    await pushError({
        code: 'INPUT_CAPPED',
        message: `${input.companies.length} companies given; only the first ${LIMITS.companies} are used.`,
        retryable: false,
        source_url: null,
    });
    input.companies = input.companies.slice(0, LIMITS.companies);
}
if (input.boards.length > LIMITS.boards) {
    await pushError({
        code: 'INPUT_CAPPED',
        message: `${input.boards.length} boards given; only the first ${LIMITS.boards} are used.`,
        retryable: false,
        source_url: null,
    });
    input.boards = input.boards.slice(0, LIMITS.boards);
}

if (input.trackChanges || input.discover) {
    try {
        store = await Actor.openKeyValueStore(input.stateStoreName);
    } catch (e) {
        await pushError({ code: 'STATE_STORE_UNAVAILABLE', message: errMsg(e), retryable: true, source_url: null });
    }
}

// ---------------- resolve boards ----------------
const boardMap = new Map<string, BoardRef>();
const addBoard = (b: BoardRef) => {
    const k = `${b.ats}:${b.slug.toLowerCase()}`;
    const prev = boardMap.get(k);
    if (!prev) boardMap.set(k, b);
    else boardMap.set(k, { ...prev, company: prev.company ?? b.company, domain: prev.domain ?? b.domain });
};

for (const [i, b] of input.boards.entries()) {
    let ref: BoardRef | null = null;
    if (typeof b === 'string') {
        const p = parseBoardUrl(b);
        if (p) ref = { ...p, discovered_via: 'board_url', input: b };
    } else if (b && typeof b === 'object') {
        const ats = String(b.ats ?? '').toLowerCase() as Ats;
        const slug = String(b.slug ?? b.token ?? '').trim();
        if (ATS_LIST.includes(ats) && isValidSlug(slug)) {
            ref = {
                ats,
                slug,
                company: b.company?.trim() || undefined,
                domain: b.domain ? (domainOf(b.domain) ?? undefined) : undefined,
                discovered_via: 'input',
            };
        }
    }
    if (ref) {
        const r0 = ref;
        const seed = SEED_BOARDS.find((s) => s.ats === r0.ats && s.slug.toLowerCase() === r0.slug.toLowerCase());
        if (seed) ref = { ...ref, company: ref.company ?? seed.company, domain: ref.domain ?? seed.domain };
        addBoard(ref);
    } else {
        await pushError({
            code: 'INVALID_BOARD',
            message: `boards[${i}] must be {ats: greenhouse|lever|ashby|smartrecruiters, slug} or a board URL. Workday, Workable, Recruitee and LinkedIn are not supported.`,
            retryable: false,
            source_url: null,
            context: { index: i, value: typeof b === 'string' ? b.slice(0, 200) : b },
        });
    }
}

if (input.useSeedList) {
    for (const s of SEED_BOARDS)
        addBoard({ ats: s.ats, slug: s.slug, company: s.company, domain: s.domain, discovered_via: 'seed_list' });
}

await pool(input.companies, 4, async (c) => {
    if (shouldStop()) return;
    await resolveCompany(c);
});

const boards = [...boardMap.values()];
log.info('Company Jobs Feed starting', { boards: boards.length, companies: input.companies.length });
if (!boards.length) {
    await finish({ exitCode: 0, statusMessage: 'No job boards resolved; see error rows.' });
}

// ---------------- scan boards ----------------
let openChecksLeft = input.maxOpenChecks;
await pool(boards, BOARD_CONCURRENCY, async (b) => {
    if (shouldStop()) {
        await pushError({
            code: 'BOARD_SKIPPED',
            message: `Not scanned: run stopped (${stop.reason}).`,
            retryable: true,
            ats: b.ats,
            board: b.slug,
            source_url: null,
        });
        return;
    }
    await scanBoard(b);
});

log.info('Company Jobs Feed finished', counters);
await finish();

// =====================================================================================================

async function resolveCompany(rawInput: string): Promise<void> {
    const asBoard = parseBoardUrl(rawInput);
    if (asBoard) {
        const seed = SEED_BOARDS.find(
            (s) => s.ats === asBoard.ats && s.slug.toLowerCase() === asBoard.slug.toLowerCase(),
        );
        addBoard({
            ...asBoard,
            company: seed?.company,
            domain: seed?.domain,
            discovered_via: 'board_url',
            input: rawInput,
        });
        return;
    }
    const seeds = seedLookup(rawInput);
    if (seeds.length) {
        counters.companies_from_seed++;
        for (const s of seeds)
            addBoard({
                ats: s.ats,
                slug: s.slug,
                company: s.company,
                domain: s.domain,
                discovered_via: 'seed_list',
                input: rawInput,
            });
        return;
    }
    const dom = domainOf(rawInput);
    const label = dom ? undefined : rawInput;
    if (store) {
        const cached = await store.getValue<DiscoveryCacheEntry>(discoveryKey(rawInput)).catch(() => null);
        if (cached && Date.now() - Date.parse(cached.at) < DISCOVERY_CACHE_DAYS * 86_400_000) {
            counters.companies_from_cache++;
            await emitter.emit(companyRow(rawInput, cached.company, cached.domain, cached.boards, [], 0, true), []);
            if (!cached.boards.length) {
                counters.companies_unresolved++;
                await pushError({
                    code: 'NO_BOARD_FOUND',
                    message: `No supported job board found for "${rawInput}" (cached result from ${cached.at.slice(0, 10)}).`,
                    retryable: false,
                    input: rawInput,
                    source_url: null,
                });
            }
            for (const b of cached.boards)
                addBoard({
                    ats: b.ats,
                    slug: b.slug,
                    company: cached.company ?? label,
                    domain: cached.domain ?? undefined,
                    discovered_via: 'cache',
                    input: rawInput,
                });
            return;
        }
    }
    if (!input.discover) {
        counters.companies_unresolved++;
        await pushError({
            code: 'COMPANY_NOT_RESOLVED',
            message: `"${rawInput}" is not a board URL or a seeded company. Set discover: true or pass boards [{ats, slug}].`,
            retryable: false,
            input: rawInput,
            source_url: null,
        });
        return;
    }
    const d = await discoverCompany(rawInput, client, careers, { shouldStop });
    for (const n of d.notes)
        await pushError({
            code: n.code,
            message: n.message,
            retryable: n.code === 'HOST_BLOCKED' || n.code === 'NETWORK_ERROR',
            input: rawInput,
            host: n.host,
            source_url: null,
        });
    const company = d.company ?? label ?? null;
    const domain = d.domain ? registrableDomain(d.domain) : null;
    const found = d.boards.map((b) => ({ ats: b.ats, slug: b.slug, via: b.via, confidence: b.confidence }));
    const transient = d.notes.some((n) => n.code === 'HOST_BLOCKED' || n.code === 'NETWORK_ERROR');
    if (store && (found.length || !transient)) {
        const entry: DiscoveryCacheEntry = {
            v: 1,
            input: rawInput,
            at: new Date().toISOString(),
            company,
            domain,
            boards: found,
        };
        await store.setValue(discoveryKey(rawInput), entry).catch(() => undefined);
    }
    if (!found.length) {
        counters.companies_unresolved++;
        await pushError({
            code: 'NO_BOARD_FOUND',
            message: `No Greenhouse, Lever, Ashby or SmartRecruiters board found for "${rawInput}" (${d.pagesFetched.length} careers pages, ${d.probes} API probes).`,
            retryable: transient,
            input: rawInput,
            source_url: null,
        });
        return;
    }
    counters.companies_discovered++;
    const ok = await emitter.emit(companyRow(rawInput, company, domain, found, d.pagesFetched, d.probes, false), [
        CHARGE_EVENTS.companyDiscovered,
    ]);
    if (!ok) return;
    for (const b of found)
        addBoard({
            ats: b.ats,
            slug: b.slug,
            company: company ?? undefined,
            domain: domain ?? undefined,
            discovered_via: b.via === 'careers_page' ? 'careers_page' : 'slug_probe',
            input: rawInput,
        });
}

function companyRow(
    inputStr: string,
    company: string | null,
    domain: string | null,
    found: CompanyRow['boards'],
    pages: string[],
    probes: number,
    cached: boolean,
): CompanyRow {
    return {
        schema_version: SCHEMA_VERSION,
        type: 'company',
        input: inputStr,
        company,
        domain,
        boards: found,
        careers_pages_fetched: pages,
        probes,
        cached,
        source_url: pages[0] ?? (found[0] ? `https://${ATS_API_HOSTS[found[0].ats]}` : ''),
        checked_at: new Date().toISOString(),
    };
}

async function scanBoard(b: BoardRef): Promise<void> {
    const host = ATS_API_HOSTS[b.ats];
    if (gate.isKilled(host)) {
        counters.boards_failed++;
        await pushError({
            code: 'HOST_BLOCKED',
            message: `${host} was stopped earlier in this run (403/429 kill switch); board not scanned.`,
            retryable: true,
            ats: b.ats,
            board: b.slug,
            host,
            source_url: null,
        });
        return;
    }
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    let fetched;
    try {
        fetched = await fetchBoard(client, b.ats, b.slug, {
            maxJobs: input.maxJobsPerBoard,
            withDescription: input.includeDescription === 'text',
            companyHint: b.company,
            shouldStop,
        });
    } catch (e) {
        counters.boards_failed++;
        const he = e instanceof HttpError ? e : null;
        await pushError({
            code: he?.code ?? 'BOARD_FETCH_FAILED',
            message: errMsg(e),
            retryable: he?.retryable ?? true,
            ats: b.ats,
            board: b.slug,
            host,
            source_url: null,
            context: he?.status ? { status: he.status } : undefined,
        });
        return;
    }
    if (fetched.notFound) {
        counters.boards_failed++;
        await pushError({
            code: 'BOARD_NOT_FOUND',
            message: `No published ${b.ats} board "${b.slug}" (or it has no public postings).`,
            retryable: false,
            ats: b.ats,
            board: b.slug,
            source_url: fetched.sourceUrl,
        });
        return;
    }
    const company = b.company ?? fetched.company ?? b.slug;
    const domain = b.domain ?? null;
    for (const j of fetched.jobs)
        if (!b.company && fetched.company && j.company === b.slug) j.company = fetched.company;
    counters.jobs_listed += fetched.jobs.length;

    const fps = new Map(fetched.jobs.map((j) => [j.job_id, jobFingerprint(j, domain)]));
    const ctx: RowContext = {
        nowIso,
        nowMs,
        domain,
        sourceUrl: fetched.sourceUrl,
        longOpenDays: input.longOpenDays,
        scrub: input.scrubPII,
    };

    let hist: ReturnType<typeof applyHistory> | null = null;
    const key = stateKey(b.ats, b.slug);
    if (input.trackChanges && store) {
        const prev = await store.getValue<BoardState>(key).catch(() => null);
        hist = applyHistory(prev?.v === 1 ? prev : null, b.ats, b.slug, fetched.jobs, fps, nowIso, fetched.complete);
        hist.state.company = company;
    }

    let rows: JobRow[] = fetched.jobs.map((j) =>
        buildJobRow(j, hist?.perJob.get(j.job_id) ?? null, fps.get(j.job_id)!, ctx),
    );
    counters.long_open += rows.filter((r) => r.long_open).length;
    counters.reposts_detected += hist?.counts.reposted ?? 0;
    rows = rows.filter((r) => matches(r, filters, nowMs));
    const matched = rows.length;
    counters.jobs_matched += matched;

    if (input.dedupe !== 'none') {
        const before = rows.length;
        rows = rows.filter((r) => !emittedKeys.has(r.job_key) && (emittedKeys.add(r.job_key), true));
        counters.jobs_exact_duplicates += before - rows.length;
    }
    if (input.dedupe === 'role') {
        const before = rows.length;
        rows = mergeRoles(rows);
        counters.jobs_merged += before - rows.length;
    }
    dupes.register(rows);

    let emitted = 0;
    let truncated = false;
    for (let r of rows) {
        if (shouldStop()) {
            truncated = true;
            break;
        }
        r = dupes.annotate(r);
        const events: string[] = [CHARGE_EVENTS.job];
        if (input.confirmOpen === 'detail' && openChecksLeft > 0) {
            const checked = await confirmOpen(r);
            r = checked.row;
            if (checked.charged) events.push(CHARGE_EVENTS.openConfirmed);
            if (r.status === 'closed') events.splice(events.indexOf(CHARGE_EVENTS.job), 1);
        }
        const ok = await emitter.emit(r, events);
        if (!ok) {
            truncated = true;
            break;
        }
        if (r.status === 'open') {
            emitted++;
            counters.jobs_emitted++;
        }
    }

    // closed rows (free): only from a complete fetch in a tracked run that isn't the baseline
    if (hist && input.emitClosed && !truncated) {
        for (const c of hist.closed) {
            const row = buildClosedRow(c, { ats: b.ats, board: b.slug, company }, ctx);
            const f = {
                ...filters,
                countries: [],
                remote: 'any' as const,
                departments: [],
                employmentTypes: [],
                postedWithinDays: null,
                maxAgeDays: null,
                hasSalary: false,
                excludeStale: false,
                onlyNew: false,
            };
            if (!matches(row, f, nowMs)) continue;
            await emitter.emit(row, []);
            counters.closed_emitted++;
        }
    }

    // Persist history only when this board's output was delivered in full, so "onlyNew" never loses jobs.
    if (hist && store && !truncated) {
        await store.setValue(key, hist.state).catch(async (e: unknown) => {
            await pushError({
                code: 'STATE_SAVE_FAILED',
                message: errMsg(e),
                retryable: true,
                ats: b.ats,
                board: b.slug,
                source_url: null,
            });
        });
    }

    const boardRow: BoardRow = {
        schema_version: SCHEMA_VERSION,
        type: 'board',
        ats: b.ats,
        board: b.slug,
        company,
        company_domain: domain,
        discovered_via: b.discovered_via,
        source_url: fetched.sourceUrl,
        checked_at: nowIso,
        jobs_total: fetched.total,
        jobs_matched: matched,
        jobs_emitted: emitted,
        complete: fetched.complete && !truncated,
        new: hist ? hist.counts.new : null,
        updated: hist ? hist.counts.updated : null,
        closed: hist ? hist.counts.closed : null,
        reposted: hist ? hist.counts.reposted : null,
        requests: fetched.requests,
    };
    if (await emitter.emit(boardRow, [CHARGE_EVENTS.board])) counters.boards_scanned++;
    if (!fetched.complete) {
        await pushError({
            code: 'BOARD_TRUNCATED',
            message: `${b.ats}/${b.slug} lists ${fetched.total} jobs; read ${fetched.jobs.length} (maxJobsPerBoard or run stop). Closed-job detection skipped for this board.`,
            retryable: false,
            ats: b.ats,
            board: b.slug,
            source_url: fetched.sourceUrl,
        });
    }
}

async function confirmOpen(r: JobRow): Promise<{ row: JobRow; charged: boolean }> {
    const url = detailUrl(r.ats, r.board, r.job_id);
    if (!url) return { row: { ...r, open_check: 'detail_not_supported' }, charged: false };
    openChecksLeft--;
    try {
        const res = await client.getJson<unknown>(url);
        counters.open_checks++;
        if (res.status === 404 || res.status === 410) {
            counters.open_checks_closed++;
            return {
                row: { ...r, status: 'closed', open_check: 'detail_closed', verified_open_at: null, change: r.change },
                charged: true,
            };
        }
        let desc = r.description_text;
        if (r.ats === 'smartrecruiters' && input.includeDescription === 'text' && !desc) {
            desc = srDetailDescription(res.json);
            if (desc && input.scrubPII) desc = scrubPII(desc).text;
        }
        return {
            row: {
                ...r,
                open_check: 'detail_open',
                verified_open_at: new Date().toISOString(),
                description_text: desc,
            },
            charged: true,
        };
    } catch {
        return { row: { ...r, open_check: 'detail_failed' }, charged: false };
    }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

async function finish(exitOptions?: { exitCode: number; statusMessage: string }): Promise<never> {
    await emitter.flush();
    const { charged } = emitter;
    const estUsd = Object.entries(charged).reduce(
        (s, [e, n]) => s + n * (PRICES_USD[e as keyof typeof PRICES_USD] ?? 0),
        0,
    );
    await Actor.setValue('RUN_SUMMARY', {
        schema_version: SCHEMA_VERSION,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        stopped_early: stop.reason || null,
        ...counters,
        events: charged,
        event_charges_usd_at_list_price: Math.round(estUsd * 1e6) / 1e6,
        requests_total: gate.totalRequests(),
        requests_per_host: Object.fromEntries(gate.requests),
        careers_pages_fetched: careers.pagesFetched,
        hosts_stopped: Object.fromEntries(gate.killed),
        state_store: store ? input.stateStoreName : null,
        input: { ...input, filters: { ...filters, titleRegex: filters.titleRegex?.source ?? null } },
    });
    const groups = dupes.multiGroups();
    if (Object.keys(groups).length) await Actor.setValue('DUPLICATE_GROUPS', groups);
    if (!exitOptions && stop.reason && stop.reason !== 'aborted') {
        await Actor.exit({
            exitCode: 0,
            statusMessage: `Stopped early: ${stop.reason}. ${counters.jobs_emitted} jobs from ${counters.boards_scanned} boards.`,
        });
    } else if (!exitOptions) {
        await Actor.exit({
            exitCode: 0,
            statusMessage: `${counters.jobs_emitted} jobs from ${counters.boards_scanned} boards (${counters.errors} error rows).`,
        });
    } else await Actor.exit(exitOptions);
    return undefined as never;
}

async function pushError(partial: Omit<ErrorRow, 'schema_version' | 'type' | 'checked_at'>): Promise<void> {
    counters.errors += 1;
    const row: ErrorRow = {
        schema_version: SCHEMA_VERSION,
        type: 'error',
        checked_at: new Date().toISOString(),
        ...partial,
    };
    await emitter.emit(row, []); // error rows are never charged
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
