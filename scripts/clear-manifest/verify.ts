/**
 * Live verifier for CLEAR boards.
 * Public documented GETs only, from this process (not a Cloudflare Worker).
 * 429 pauses the host; the third 429 stops that host for the run. No proxy, no second IP.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { crawlDelayMs, isAllowed, parseRobots } from '../../src/robots.js';
import { ROBOTS_AGENT, excludedHost } from '../../src/types.js';

import {
    BACKOFF_CAP_MS,
    type ClearAts,
    LEVER_MIN_INTERVAL_MS,
    type ManifestRow,
    MAX_429_STRIKES,
    USER_AGENT,
    aggregatorBoardReason,
    backoffMs,
    boardTitleUrl,
    companyFromBoardTitle,
    companyMatches,
    countTitleKeyword,
    jobsApiUrl,
    leverEuJobsApiUrl,
    leverEuTitleUrl,
    manifestLine,
    parseAtsJson,
    parseRetryAfter,
    publishedBoard,
    titleFromHtml,
    urlUsesEmbed,
} from './board.js';
import { type DirectCandidate, type NameProbe, slugsFromCareersHtml } from './candidates.js';

const JSON_MAX = 40_000_000;
const TITLE_MAX = 12_000;
const CAREERS_MAX = 200_000;

class HostStopped extends Error {
    constructor(readonly host: string, readonly reason: string) {
        super(`${host} stopped (${reason})`);
    }
}

class Lane {
    active = 0;
    strikes = 0;
    stopped = false;
    stopReason = '';
    private next = 0;
    private waiters: (() => void)[] = [];

    constructor(
        readonly name: string,
        private gapMs: number,
        private readonly concurrency: number,
    ) {}

    async acquire(): Promise<void> {
        if (this.stopped) throw new HostStopped(this.name, this.stopReason);
        while (this.active >= this.concurrency) {
            await new Promise<void>((r) => {
                this.waiters.push(r);
            });
            if (this.stopped) throw new HostStopped(this.name, this.stopReason);
        }
        this.active++;
        try {
            const now = Date.now();
            const start = Math.max(now, this.next);
            this.next = start + this.gapMs;
            if (start > now) await sleep(start - now);
            if (this.stopped) throw new HostStopped(this.name, this.stopReason);
        } catch (e) {
            this.release();
            throw e;
        }
    }

    release(): void {
        this.active = Math.max(0, this.active - 1);
        const w = this.waiters.shift();
        if (w) w();
    }

    note429(retryAfterMs: number | null): { waitMs: number; stopped: boolean } {
        this.strikes++;
        const waitMs = backoffMs(this.strikes, retryAfterMs);
        this.next = Math.max(this.next, Date.now() + waitMs);
        if (this.strikes >= MAX_429_STRIKES) {
            this.stopped = true;
            this.stopReason = `HTTP 429 x${this.strikes}; hard stop, no other IP`;
            const pending = this.waiters.splice(0);
            for (const w of pending) w();
        }
        return { waitMs, stopped: this.stopped };
    }

    kill(reason: string): void {
        this.stopped = true;
        this.stopReason = reason;
        const pending = this.waiters.splice(0);
        for (const w of pending) w();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => {
        setTimeout(r, ms);
    });
}

function laneFor(ats: ClearAts, lanes: Lanes): Lane {
    if (ats === 'greenhouse') return lanes.greenhouse;
    if (ats === 'ashby') return lanes.ashbyApi;
    return lanes.lever;
}

interface Lanes {
    greenhouse: Lane;
    ashbyApi: Lane;
    ashbyHtml: Lane;
    lever: Lane;
}

function makeLanes(): Lanes {
    return {
        greenhouse: new Lane('boards-api.greenhouse.io', 200, 4),
        ashbyApi: new Lane('api.ashbyhq.com', 200, 3),
        ashbyHtml: new Lane('jobs.ashbyhq.com', 200, 3),
        lever: new Lane('lever', LEVER_MIN_INTERVAL_MS, 1),
    };
}

interface Fetched {
    status: number;
    text: string;
    truncated: boolean;
    url: string;
}

async function readBody(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const reader = res.body?.getReader();
    if (!reader) {
        const text = await res.text();
        return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (bytes + value.byteLength > maxBytes) {
            const room = maxBytes - bytes;
            if (room > 0) chunks.push(value.subarray(0, room));
            bytes = maxBytes;
            truncated = true;
            await reader.cancel();
            break;
        }
        chunks.push(value);
        bytes += value.byteLength;
    }
    const buf = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
        buf.set(c, offset);
        offset += c.byteLength;
    }
    return { text: new TextDecoder().decode(buf), truncated };
}

async function request(url: string, lane: Lane, maxBytes: number): Promise<Fetched> {
    if (urlUsesEmbed(url)) throw new Error(`refusing embed URL ${url}`);
    let netTries = 0;
    while (true) {
        await lane.acquire();
        try {
            const res = await fetch(url, {
                redirect: 'manual',
                headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/html;q=0.8' },
                signal: AbortSignal.timeout(25_000),
            });
            if (res.status === 429) {
                const retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now());
                const decision = lane.note429(retryAfter);
                await res.body?.cancel();
                console.log(`429 ${lane.name} backoff ${decision.waitMs}ms strike ${lane.strikes}/${MAX_429_STRIKES}`);
                if (decision.stopped) throw new HostStopped(lane.name, lane.stopReason);
                continue;
            }
            if (res.status === 403) {
                lane.kill(`HTTP 403; host stopped, no other IP`);
                await res.body?.cancel();
                throw new HostStopped(lane.name, lane.stopReason);
            }
            if (res.status >= 500 && netTries < 2) {
                netTries++;
                await res.body?.cancel();
                await sleep(1000 * 2 ** netTries);
                continue;
            }
            const body = await readBody(res, maxBytes);
            return { status: res.status, text: body.text, truncated: body.truncated, url };
        } catch (e) {
            if (e instanceof HostStopped) throw e;
            netTries++;
            if (netTries > 2) throw e;
            await sleep(1000 * 2 ** netTries);
        } finally {
            lane.release();
        }
    }
}

export interface RejectSample {
    ats: string;
    slug: string;
    reason: string;
    company?: string;
    observed?: string;
}

export interface VerifyStats {
    started_at: string;
    verified: number;
    by_ats: Record<ClearAts, number>;
    checked: number;
    rejected: Record<string, number>;
    unlisted_dropped_boards: number;
    host_stops: { host: string; reason: string }[];
    samples: RejectSample[];
    target: number;
    rate_per_s: number;
}

export interface SpotCheck {
    ats: ClearAts;
    slug: string;
    url: string;
    http_status: number;
    jobs: number;
    company: string | null;
    title_sample: string[];
    title_keyword: string;
    title_keyword_hits: number;
    used_embed: false;
    used_content_param: false;
    elapsed_ms: number;
    error?: string;
}

function emptyStats(): VerifyStats {
    return {
        started_at: new Date().toISOString(),
        verified: 0,
        by_ats: { greenhouse: 0, ashby: 0, lever: 0 },
        checked: 0,
        rejected: {},
        unlisted_dropped_boards: 0,
        host_stops: [],
        samples: [],
        target: 8854,
        rate_per_s: 0,
    };
}

function bump(stats: VerifyStats, reason: string, sample?: RejectSample): void {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
    if (sample && stats.samples.length < 40) stats.samples.push(sample);
}

export interface VerifyPaths {
    manifest: string;
    progress: string;
    spot: string;
}

export function loadVerifiedKeys(manifest: string): Map<string, ManifestRow> {
    const out = new Map<string, ManifestRow>();
    let text = '';
    try {
        text = readFileSync(manifest, 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\n/)) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as ManifestRow;
            if (row.ats && row.slug && row.jobs > 0 && row.http_status === 200) {
                out.set(`${row.ats}:${row.slug.toLowerCase()}`, row);
            }
        } catch {
            /* skip a torn line */
        }
    }
    return out;
}

function recount(rows: Map<string, ManifestRow>, stats: VerifyStats): void {
    stats.verified = rows.size;
    stats.by_ats = { greenhouse: 0, ashby: 0, lever: 0 };
    for (const row of rows.values()) stats.by_ats[row.ats]++;
}

async function readCompanyTitle(ats: ClearAts, slug: string, lanes: Lanes, eu: boolean): Promise<string | null> {
    const url = eu ? leverEuTitleUrl(slug) : boardTitleUrl(ats, slug);
    if (!url) return null;
    const lane = ats === 'lever' ? lanes.lever : lanes.ashbyHtml;
    const res = await request(url, lane, TITLE_MAX);
    if (res.status !== 200) return null;
    const title = titleFromHtml(res.text);
    if (!title) return null;
    return companyFromBoardTitle(title);
}

export async function verifyOne(
    item: { ats: ClearAts; slug: string; company?: string; sources: string[] },
    lanes: Lanes,
    verifiedAt: string,
): Promise<{ row?: ManifestRow; reason?: string; observed?: string }> {
    const lane = laneFor(item.ats, lanes);
    let url = jobsApiUrl(item.ats, item.slug);
    let res: Fetched;
    try {
        res = await request(url, lane, JSON_MAX);
    } catch (e) {
        if (e instanceof HostStopped) return { reason: 'host_stopped' };
        return { reason: 'network' };
    }
    if (item.ats === 'lever' && (res.status === 404 || res.status === 410)) {
        try {
            url = leverEuJobsApiUrl(item.slug);
            res = await request(url, lanes.lever, JSON_MAX);
        } catch (e) {
            if (e instanceof HostStopped) return { reason: 'host_stopped' };
            return { reason: 'network' };
        }
    }
    if (res.status !== 200) return { reason: res.status === 404 || res.status === 410 ? 'not_found' : `http_${res.status}` };
    if (res.truncated) return { reason: 'too_large' };
    let body: unknown;
    try {
        body = parseAtsJson(res.text);
    } catch {
        return { reason: 'non_json' };
    }
    const published = publishedBoard(item.ats, body, 5);
    if (item.ats === 'ashby') {
        const root = body && typeof body === 'object' && !Array.isArray(body) ? (body as { jobs?: { isListed?: boolean }[] }) : null;
        const raw = root?.jobs?.length ?? 0;
        if (raw > published.jobs) {
            /* counted by caller via reason path; the row simply omits unlisted */
        }
    }
    if (published.jobs < 1) return { reason: 'no_jobs' };
    let company = published.company;
    let companyMatch: ManifestRow['company_match'] = 'api_company_name';
    if (item.ats === 'greenhouse') {
        if (!company) return { reason: 'company_missing' };
        if (item.company && !companyMatches(item.company, company)) {
            return { reason: 'company_mismatch', observed: company };
        }
    } else {
        let fromTitle: string | null = null;
        try {
            fromTitle = await readCompanyTitle(item.ats, item.slug, lanes, url.includes('api.eu.lever.co'));
        } catch (e) {
            if (e instanceof HostStopped) return { reason: 'host_stopped' };
            return { reason: 'company_missing' };
        }
        if (!fromTitle) return { reason: 'company_missing' };
        if (item.company && !companyMatches(item.company, fromTitle)) {
            return { reason: 'company_mismatch', observed: fromTitle };
        }
        company = fromTitle;
        companyMatch = 'board_title';
    }
    const aggregator = aggregatorBoardReason(item.slug, company);
    if (aggregator) return { reason: aggregator, observed: company ?? undefined };
    const row: ManifestRow = {
        ats: item.ats,
        slug: item.slug,
        company: company ?? undefined,
        jobs: published.jobs,
        http_status: 200,
        verified_at: verifiedAt,
        verified_by: 'api_live_probe',
        company_match: companyMatch,
        source_url: url,
        sources: item.sources,
    };
    return { row };
}

export async function spotCheck(lanes: Lanes): Promise<SpotCheck[]> {
    const targets: { ats: ClearAts; slug: string; keyword: string }[] = [
        { ats: 'greenhouse', slug: 'andurilindustries', keyword: 'engineer' },
        { ats: 'greenhouse', slug: 'spacex', keyword: 'engineer' },
        { ats: 'lever', slug: 'veeva', keyword: 'manager' },
    ];
    const out: SpotCheck[] = [];
    for (const t of targets) {
        const url = jobsApiUrl(t.ats, t.slug);
        const started = Date.now();
        const base: SpotCheck = {
            ats: t.ats,
            slug: t.slug,
            url,
            http_status: 0,
            jobs: 0,
            company: null,
            title_sample: [],
            title_keyword: t.keyword,
            title_keyword_hits: 0,
            used_embed: false,
            used_content_param: url.includes('content='),
            elapsed_ms: 0,
        };
        try {
            const res = await request(url, laneFor(t.ats, lanes), JSON_MAX);
            base.http_status = res.status;
            base.elapsed_ms = Date.now() - started;
            if (res.status === 200 && !res.truncated) {
                const body = parseAtsJson(res.text);
                const published = publishedBoard(t.ats, body, 50_000);
                base.jobs = published.jobs;
                base.company = published.company;
                base.title_sample = published.titles.slice(0, 5);
                base.title_keyword_hits = countTitleKeyword(published.titles, t.keyword);
            } else if (res.truncated) {
                base.error = 'too_large';
            }
        } catch (e) {
            base.elapsed_ms = Date.now() - started;
            base.error = e instanceof Error ? e.message : String(e);
        }
        out.push(base);
        console.log(
            `SPOT ${t.ats}/${t.slug} http=${base.http_status} jobs=${base.jobs} ${t.keyword}_titles=${base.title_keyword_hits} ${base.error ?? 'ok'}`,
        );
    }
    return out;
}

async function pool(items: DirectCandidate[], limit: number, fn: (item: DirectCandidate) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

export function loadSkipKeys(file: string): Set<string> {
    const out = new Set<string>();
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\n/)) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as { ats?: string; slug?: string };
            if (row.ats && row.slug) out.add(`${row.ats}:${row.slug.toLowerCase()}`);
        } catch {
            /* torn line */
        }
    }
    return out;
}

export async function verifyAll(
    direct: DirectCandidate[],
    probes: NameProbe[],
    paths: VerifyPaths,
    opts: { limit: number | null; skip?: Set<string> },
): Promise<{ stats: VerifyStats; spots: SpotCheck[] }> {
    mkdirSync(path.dirname(paths.manifest), { recursive: true });
    const verifiedAt = new Date().toISOString().slice(0, 10);
    const have = loadVerifiedKeys(paths.manifest);
    const resumed = have.size;
    const stats = emptyStats();
    recount(have, stats);
    const lanes = makeLanes();
    const spots = await spotCheck(lanes);
    writeFileSync(paths.spot, JSON.stringify({ verified_count: have.size, target: 8854, spots }, null, 2) + '\n');
    const started = Date.now();
    let sinceLog = 0;

    const writeProgress = () => {
        const sec = Math.max(1, (Date.now() - started) / 1000);
        stats.rate_per_s = Number((stats.checked / sec).toFixed(2));
        const queueTotal = opts.limit ?? direct.length;
        const remainingQueue = Math.max(0, queueTotal - stats.checked);
        const etaQueueMin = stats.rate_per_s > 0 ? Math.round(remainingQueue / stats.rate_per_s / 60) : null;
        const freshVerified = Math.max(0, stats.verified - resumed);
        const passRate = stats.checked > 0 ? freshVerified / stats.checked : 0;
        const projected = Math.min(8854, Math.round(stats.verified + Math.max(0, queueTotal - stats.checked - resumed) * passRate));
        const gap = Math.max(0, 8854 - stats.verified);
        const etaTargetMin = stats.rate_per_s > 0 ? Math.round(gap / stats.rate_per_s / 60) : null;
        const body = {
            verified_count: stats.verified,
            target: 8854,
            ratio: `${stats.verified}/8854`,
            by_ats: stats.by_ats,
            parity_by_ats: { greenhouse: 5243, ashby: 3355, lever: 256 },
            checked: stats.checked,
            rate_per_s: stats.rate_per_s,
            eta_remaining_queue_min: etaQueueMin,
            eta_to_8854_at_this_rate_min: etaTargetMin,
            eta_to_8854_note:
                'Divides the gap to 8854 by the check rate. That reaches 8854 only if later checks keep passing and more slugs exist. Use eta_remaining_queue_min and projected_verified_if_pass_rate_holds for this queue.',
            pass_rate: Number(passRate.toFixed(3)),
            projected_verified_if_pass_rate_holds: projected,
            rejected: stats.rejected,
            host_stops: lanesStopped(lanes),
            backoff_cap_ms: BACKOFF_CAP_MS,
            updated_at: new Date().toISOString(),
        };
        writeFileSync(paths.progress, JSON.stringify(body, null, 2) + '\n');
    };

    const consider = async (item: DirectCandidate) => {
        const key = `${item.ats}:${item.slug.toLowerCase()}`;
        if (have.has(key) || opts.skip?.has(key)) return;
        const lane = laneFor(item.ats, lanes);
        if (lane.stopped) {
            bump(stats, 'host_stopped');
            stats.checked++;
            return;
        }
        const result = await verifyOne(item, lanes, verifiedAt);
        stats.checked++;
        sinceLog++;
        if (result.row) {
            have.set(key, result.row);
            appendFileSync(paths.manifest, manifestLine(result.row) + '\n');
            recount(have, stats);
        } else {
            bump(stats, result.reason ?? 'unknown', {
                ats: item.ats,
                slug: item.slug,
                reason: result.reason ?? 'unknown',
                ...(item.company ? { company: item.company } : {}),
                ...(result.observed ? { observed: result.observed } : {}),
            });
        }
        if (sinceLog >= 25) {
            sinceLog = 0;
            writeProgress();
            console.log(
                `CLEAR verified ${stats.verified}/8854 checked=${stats.checked} gh=${stats.by_ats.greenhouse} ashby=${stats.by_ats.ashby} lever=${stats.by_ats.lever} ${stats.rate_per_s}/s`,
            );
        }
    };

    const queue = opts.limit == null ? direct : direct.slice(0, opts.limit);
    const gh = queue.filter((c) => c.ats === 'greenhouse');
    const ash = queue.filter((c) => c.ats === 'ashby');
    const lever = queue.filter((c) => c.ats === 'lever');
    await Promise.all([pool(gh, 4, consider), pool(ash, 3, consider), pool(lever, 1, consider)]);

    if (opts.limit == null) {
        for (const probe of probes) {
            for (const step of probe.plan) {
                const key = `${step.ats}:${step.slug.toLowerCase()}`;
                if (have.has(key)) continue;
                await consider({
                    ats: step.ats,
                    slug: step.slug,
                    company: probe.company,
                    sources: [probe.source],
                });
            }
        }
    }

    writeProgress();
    stats.host_stops = lanesStopped(lanes);
    // Another pass may have appended while this one ran. Keep those rows.
    for (const [key, row] of loadVerifiedKeys(paths.manifest)) {
        if (!have.has(key)) have.set(key, row);
    }
    const ordered = [...have.values()].sort((a, b) => a.ats.localeCompare(b.ats) || a.slug.localeCompare(b.slug));
    writeFileSync(paths.manifest, ordered.map((r) => manifestLine(r)).join('\n') + (ordered.length ? '\n' : ''));
    recount(have, stats);
    writeFileSync(
        paths.spot,
        JSON.stringify({ verified_count: stats.verified, target: 8854, ratio: `${stats.verified}/8854`, spots }, null, 2) + '\n',
    );
    return { stats, spots };
}

function lanesStopped(lanes: Lanes): { host: string; reason: string }[] {
    return [lanes.greenhouse, lanes.ashbyApi, lanes.ashbyHtml, lanes.lever]
        .filter((l) => l.stopped)
        .map((l) => ({ host: l.name, reason: l.stopReason }));
}

export async function harvestCareers(
    rows: { company: string; domain?: string; source: string }[],
    mapAdd: (hit: { ats: ClearAts; slug: string; company: string; source: string }) => void,
): Promise<{ fetched: number; slugs: number; skipped: string[] }> {
    let fetched = 0;
    let slugs = 0;
    const skipped: string[] = [];
    for (const row of rows) {
        if (!row.domain) continue;
        let host = row.domain.toLowerCase().replace(/\.$/, '');
        if (excludedHost(host)) {
            skipped.push(`${host} excluded`);
            continue;
        }
        const origin = `https://${host}`;
        let robotsText = '';
        try {
            const res = await fetch(`${origin}/robots.txt`, {
                redirect: 'manual',
                headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
                signal: AbortSignal.timeout(12_000),
            });
            if (res.status === 200) robotsText = (await res.text()).slice(0, 200_000);
            else await res.body?.cancel();
        } catch {
            skipped.push(`${host} robots unreachable`);
            continue;
        }
        const robots = parseRobots(robotsText);
        const delay = Math.min(crawlDelayMs(robots, ROBOTS_AGENT), 5_000);
        for (const pagePath of ['/', '/careers']) {
            if (!isAllowed(robots, ROBOTS_AGENT, pagePath)) {
                skipped.push(`${host}${pagePath} disallowed`);
                continue;
            }
            if (delay) await sleep(delay);
            try {
                const res = await fetch(`${origin}${pagePath === '/' ? '' : pagePath}`, {
                    redirect: 'manual',
                    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
                    signal: AbortSignal.timeout(12_000),
                });
                fetched++;
                if (res.status !== 200) {
                    await res.body?.cancel();
                    continue;
                }
                const body = await readBody(res, CAREERS_MAX);
                for (const hit of slugsFromCareersHtml(body.text)) {
                    mapAdd({ ...hit, company: row.company, source: 'careers_page' });
                    slugs++;
                }
            } catch {
                skipped.push(`${host}${pagePath} fetch failed`);
            }
        }
    }
    return { fetched, slugs, skipped };
}
