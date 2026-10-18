#!/usr/bin/env node
/**
 * Fairquery Company Jobs Feed stdio MCP server.
 * Free tools run on your machine against the documented public ATS APIs (no token, no Fairquery servers):
 *   jobs_get_board, jobs_find_board, jobs_check_open, jobs_list_seed_boards
 * Paid tool runs the Apify Actor fairquery/company-jobs-feed with your APIFY_TOKEN: jobs_search_companies
 * initialize and tools/list work without any token. Never contacts LinkedIn.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { compact, errorResult, getToken, MISSING_TOKEN_MESSAGE, paged, pagedOutputSchema, READ_ONLY_LOCAL, READ_ONLY_OPEN_WORLD, runActor } from './common.js';
import { detailUrl, fetchBoard, isValidSlug, listUrl } from './shared/ats.js';
import { discoverCompany, parseBoardUrl, seedLookup } from './shared/discovery.js';
import { compileFilters, matches } from './shared/filters.js';
import { AtsClient, CareersFetcher, HostGate, HttpError } from './shared/http.js';
import { buildJobRow, jobFingerprint, type RowContext } from './shared/rows.js';
import { SEED_BOARDS } from './shared/seed.js';
import type { Ats } from './shared/types.js';

export const VERSION = '1.0.5';
const ATS = ['greenhouse', 'lever', 'ashby'] as const;

const atsSchema = z
    .enum(ATS)
    .describe('Required. The applicant-tracking system hosting the board: "greenhouse" | "lever" | "ashby". Example: "ashby"');
const slugSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .describe('Required. Board slug as it appears in the public board URL (case-insensitive): boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}; 1-100 chars: a letter or digit, then letters, digits, ".", "_" or "-". Example: "ramp" or "palantir"');
const limitSchema = z.number().int().min(1).max(500).optional().describe('Optional page size, integer 1-500, default 50');
const offsetSchema = z.number().int().min(0).optional().describe('Optional items to skip, integer >= 0, default 0; pass nextOffset from the previous response');
const terms = (what: string, ex: string) => z.array(z.string().min(1).max(100)).max(50).optional().describe(`Optional, 0-50 strings, any-of. ${what} Example: ${ex}`);

function createServer(): McpServer {
    const server = new McpServer({ name: 'fairquery-jobs-feed', version: VERSION });
    const gate = new HostGate();
    const client = new AtsClient(gate);

    server.registerTool(
        'jobs_get_board',
        {
            title: 'Get live jobs from one ATS board (free)',
            description: [
                'WHAT: Fetch every job currently published on ONE company board from its official public ATS API (Greenhouse, Lever or Ashby), normalize it and filter it locally.',
                'WHEN: You know the board (ats + slug), e.g. from jobs_find_board or a careers-page link, and want its live openings now.',
                'WHEN NOT: Many companies at once, history (new/closed/reposted since last run), or careers-page discovery at scale: use jobs_search_companies (paid). Unknown board: use jobs_find_board first. SmartRecruiters, LinkedIn, Workday, Workable and Recruitee are not supported and never contacted.',
                'BEHAVIOR: Runs on your machine; one GET to the documented API host only (very large Greenhouse boards: a second, lighter GET). No token, nothing stored, no history: first_seen_at = now and change = null. Any HTTP 403/429 stops that host for the session (kill switch, HOST_BLOCKED error). Lever requests are spaced 1 s apart (its robots.txt Crawl-delay).',
                'COST: Free.',
                'RETURNS: Paged "job" rows. compensation only when the ATS publishes it; posted_at is the ATS date or null (never guessed); age_basis says how age_days was derived. meta: jobs_total, jobs_matched, requests, complete.',
                'PARAMETERS: All filters are AND-ed; values inside one filter are OR-ed. titleIncludes/titleExcludes match whole words ("engineer" does not match "Engineering"). countries uses the ATS\'s structured country where present (Lever, Ashby) and a place-name list otherwise; rows without any country are dropped when countries is set. postedWithinDays drops rows with posted_at = null. Paging re-fetches the board, so pages from different calls can shift if the employer edits the board in between.',
                'EXAMPLE: {"ats":"ashby","slug":"ramp","titleIncludes":["engineer"],"remote":"only"} -> remote engineering roles at Ramp with salary ranges.',
            ].join('\n'),
            inputSchema: {
                ats: atsSchema,
                slug: slugSchema,
                titleIncludes: terms('Keep titles containing any of these whole words/phrases, case-insensitive.', '["engineer","data scientist"]'),
                titleExcludes: terms('Drop titles containing any of these.', '["intern","manager"]'),
                locations: terms('Substring match on location text; "remote" also matches ATS remote flags.', '["new york","berlin"]'),
                countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(50).optional().describe('Optional ISO-3166 alpha-2 codes, any-of, case-insensitive. Example: ["US","DE"]'),
                remote: z.enum(['any', 'only', 'exclude']).optional().describe('Optional, "any" | "only" | "exclude", default "any"'),
                postedWithinDays: z.number().int().min(1).max(3650).optional().describe('Optional integer 1-3650: keep jobs whose ATS publish date is at most this many days old. Example: 14'),
                longOpenDays: z.number().int().min(1).max(3650).optional().describe('Optional integer, default 60: rows older than this get long_open = true (a heuristic, not proof of a ghost job)'),
                includeDescription: z.boolean().optional().describe('Optional boolean, default false. true adds description_text (plain text, <= 20,000 chars, e-mails/phones removed)'),
                limit: limitSchema,
                offset: offsetSchema,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Get live jobs from one ATS board (free)', ...READ_ONLY_OPEN_WORLD },
        },
        async (a) => {
            const { filters, errors } = compileFilters({ titleIncludes: a.titleIncludes, titleExcludes: a.titleExcludes, locations: a.locations, countries: a.countries, remote: a.remote, postedWithinDays: a.postedWithinDays });
            if (errors.length) return errorResult('INVALID_INPUT', errors.join(' '));
            try {
                const f = await fetchBoard(client, a.ats, a.slug, { maxJobs: 20_000, withDescription: a.includeDescription === true, companyHint: seedFor(a.ats, a.slug)?.company });
                if (f.notFound) return errorResult('BOARD_NOT_FOUND', `No published ${a.ats} board "${a.slug}" (or it has no public postings). Try jobs_find_board.`);
                const nowIso = new Date().toISOString();
                const seed = seedFor(a.ats, a.slug);
                const domain = seed?.domain ?? null;
                const ctx: RowContext = { nowIso, nowMs: Date.parse(nowIso), domain, sourceUrl: f.sourceUrl, longOpenDays: a.longOpenDays ?? 60, scrub: true };
                const rows = f.jobs
                    .map((j) => buildJobRow(j, null, jobFingerprint(j, domain), ctx))
                    .map((r) => ({ ...r, change: null }))
                    .filter((r) => matches(r, filters, ctx.nowMs));
                return paged(rows, a.limit ?? 50, a.offset ?? 0, { ats: a.ats, board: a.slug, jobs_total: f.total, jobs_matched: rows.length, complete: f.complete, requests: f.requests, cost_usd: 0 });
            } catch (e) {
                return httpErr(e);
            }
        },
    );

    server.registerTool(
        'jobs_find_board',
        {
            title: 'Find which ATS board a company uses (free)',
            description: [
                'WHAT: Resolve a company name, domain or careers/board URL to its public job board(s) on Greenhouse, Lever or Ashby.',
                'WHEN: Before jobs_get_board when you only know the company ("Ramp", "sentry.io", "https://stripe.com/jobs").',
                'WHEN NOT: You already have ats + slug (call jobs_get_board). For many companies plus their jobs in one step use jobs_search_companies (paid). It cannot find Workday, Workable, Recruitee or LinkedIn pages.',
                'BEHAVIOR: Runs on your machine. Order: board-URL parsing -> verified starter list -> the company\'s own website (only for a domain/URL input; robots.txt respected, <= 3 pages, private/internal IPs refused) -> at most 6 GETs against the documented ATS APIs with slug guesses. Stops at the first hit. Nothing is cached or stored. Rate limits: max 2 parallel requests per host, Lever spaced 1 s apart, 15 s timeout per GET; ATS API network errors and HTTP 5xx are retried at most twice with backoff (0.5-1.6 s). Any HTTP 403/429 (or an HTML block page from an ATS API) stops that host for the session (kill switch, never retried, also for the other free tools): the call does not fail but adds a HOST_BLOCKED note to meta.notes, stops the careers-page step when the company site is blocked, and skips later slug probes on a stopped ATS host without sending them.',
                'COST: No APIFY_TOKEN and no billing; worst case about 4 website requests (robots.txt + 3 pages) and 6 ATS API GETs per call.',
                'RETURNS: Items of type "board": {ats, slug, company, domain, via (board_url | seed_list | careers_page | slug_probe), confidence (high | medium), board_url}. A slug_probe hit is "medium": the slug exists but may belong to a different company with the same name; check the jobs or pass the URL from the careers page. meta.notes lists robots/blocked/network notes.',
                'PARAMETERS: company accepts three forms with different behavior: a board URL is parsed with no network call; a domain or https URL enables the careers-page step; a plain name only uses the starter list and slug probes.',
                'EXAMPLE: {"company":"ramp.com"} -> [{"ats":"ashby","slug":"ramp","via":"seed_list","confidence":"high"}].',
            ].join('\n'),
            inputSchema: {
                company: z.string().min(2).max(300).describe('Required. Company name, domain or URL, 2-300 chars. Examples: "Ramp", "sentry.io", "https://jobs.lever.co/palantir"'),
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Find which ATS board a company uses (free)', ...READ_ONLY_OPEN_WORLD },
        },
        async ({ company }) => {
            const direct = parseBoardUrl(company);
            const boardUrl = (ats: Ats, slug: string) => listUrl(ats, slug);
            if (direct) return paged([{ type: 'board', ...direct, company: null, domain: null, via: 'board_url', confidence: 'high', board_url: boardUrl(direct.ats, direct.slug) }], 50, 0);
            const seeds = seedLookup(company);
            if (seeds.length) return paged(seeds.map((s) => ({ type: 'board', ats: s.ats, slug: s.slug, company: s.company, domain: s.domain, via: 'seed_list', confidence: 'high', board_url: boardUrl(s.ats, s.slug), verified_at: s.verified_at })), 50, 0);
            const d = await discoverCompany(company, client, new CareersFetcher(gate));
            const items = d.boards.map((b) => ({ type: 'board', ats: b.ats, slug: b.slug, company: d.company, domain: d.domain, via: b.via, confidence: b.confidence, board_url: boardUrl(b.ats, b.slug) }));
            if (!items.length) items.push({ type: 'error', code: 'NO_BOARD_FOUND', message: `No supported public board found for "${company}" (${d.pagesFetched.length} pages, ${d.probes} probes). Pass the board URL from the company's careers page.`, retryable: false } as never);
            return paged(items, 50, 0, { careers_pages_fetched: d.pagesFetched, probes: d.probes, notes: d.notes, cost_usd: 0 });
        },
    );

    server.registerTool(
        'jobs_check_open',
        {
            title: 'Re-check whether one job is still published (free)',
            description: [
                'WHAT: Re-check ONE job on the employer\'s ATS right now and report open or closed.',
                'WHEN: Before applying, alerting or contacting about a specific job you got earlier (job_key or ats + slug + jobId).',
                'WHEN NOT: Listing jobs (jobs_get_board) or checking many jobs at once (jobs_search_companies with confirmOpen, paid).',
                'BEHAVIOR: Greenhouse, Lever: one GET to the documented per-job endpoint; HTTP 404 = closed. Ashby has no per-job endpoint, so the whole board is fetched once and searched for the id (method "board_listing"). "open" means currently published by the employer; it does not prove the role is still being filled.',
                'COST: Free.',
                'RETURNS: One item {type:"open_check", ats, slug, job_id, status: open | closed, method: detail_endpoint | board_listing, checked_at, source_url} or an error item (HOST_BLOCKED, NETWORK_ERROR: retryable).',
                'PARAMETERS: Give either jobKey alone, or ats + slug + jobId; jobKey wins when both are given. A malformed jobKey, or neither form complete, returns INVALID_INPUT without a request.',
                'EXAMPLE: {"jobKey":"greenhouse:stripe:8172503"} -> {"status":"open","method":"detail_endpoint"}.',
            ].join('\n'),
            inputSchema: {
                jobKey: z.string().max(250).optional().describe('Optional if ats + slug + jobId are given; wins when both are given. The job_key field of a job row, format "{ats}:{slug}:{job_id}" with ats in lowercase (greenhouse | lever | ashby); any other shape returns INVALID_INPUT. Examples: "greenhouse:stripe:8172503", "lever:palantir:10dfc8bc-99ad-4ca2-ab76-853cb90a92c2"'),
                ats: z.enum(ATS).optional().describe('Required unless jobKey is given. The applicant-tracking system hosting the board: "greenhouse" | "lever" | "ashby" (the first part of job_key). Example: "greenhouse"'),
                slug: z
                    .string()
                    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
                    .optional()
                    .describe('Required unless jobKey is given. Board slug from the public board URL (boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, jobs.ashbyhq.com/{slug}; the middle part of job_key), case-insensitive, 1-100 chars: a letter or digit, then letters, digits, ".", "_" or "-". Example: "stripe"'),
                jobId: z.string().min(1).max(100).optional().describe('Required unless jobKey is given. The ATS job id (job_id field, the last part of job_key), 1-100 chars: numeric on Greenhouse, a UUID on Lever and Ashby. Example: "8172503"'),
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Re-check whether one job is still published (free)', ...READ_ONLY_OPEN_WORLD },
        },
        async (a) => {
            let ats = a.ats as Ats | undefined;
            let slug = a.slug;
            let id = a.jobId;
            if (a.jobKey) {
                const m = /^(greenhouse|lever|ashby):([^:]+):(.+)$/.exec(a.jobKey.trim());
                if (!m) return errorResult('INVALID_INPUT', 'jobKey must look like "<ats>:<slug>:<job_id>".');
                [, ats, slug, id] = m as unknown as [string, Ats, string, string];
            }
            if (!ats || !slug || !id || !isValidSlug(slug)) return errorResult('INVALID_INPUT', 'Give jobKey, or ats + slug + jobId.');
            const checkedAt = new Date().toISOString();
            try {
                const url = detailUrl(ats, slug, id);
                if (url) {
                    const r = await client.getJson<unknown>(url);
                    if (r.status === 404 && (await boardMissing(ats, slug))) return errorResult('BOARD_NOT_FOUND', `Board ${ats}/${slug} not found.`);
                    return paged([{ type: 'open_check', ats, slug, job_id: id, status: r.status === 200 ? 'open' : 'closed', method: 'detail_endpoint', checked_at: checkedAt, source_url: url }], 1, 0, { cost_usd: 0 });
                }
                const f = await fetchBoard(client, ats, slug, { maxJobs: 20_000, withDescription: false });
                if (f.notFound) return errorResult('BOARD_NOT_FOUND', `Board ${ats}/${slug} not found.`);
                const open = f.jobs.some((j) => j.job_id === id);
                return paged([{ type: 'open_check', ats, slug, job_id: id, status: open ? 'open' : 'closed', method: 'board_listing', checked_at: checkedAt, source_url: f.sourceUrl }], 1, 0, { cost_usd: 0 });
            } catch (e) {
                return httpErr(e);
            }
        },
    );

    server.registerTool(
        'jobs_list_seed_boards',
        {
            title: 'List the verified starter boards (free, offline)',
            description: [
                'WHAT: List the bundled starter list of company job boards that Fairquery verified on their official ATS APIs (company, domain, ats, slug, verified_at, jobs_at_verification).',
                'WHEN: To pick companies to scan, or to know which names jobs_find_board resolves instantly.',
                'WHEN NOT: Live job data (jobs_get_board) or companies not in the list (jobs_find_board). The list is a starting point, not a global index of employers.',
                'BEHAVIOR: Offline: reads a static list compiled into the server; no network call. jobs_at_verification is a snapshot from verified_at and goes stale.',
                'COST: Free.',
                'RETURNS: Paged "seed_board" rows; meta.by_ats counts the whole list per ATS (unfiltered).',
                'PARAMETERS: ats narrows the list; omit it for all three systems. Feed ats + slug of any item straight into jobs_get_board.',
                'EXAMPLE: {"ats":"lever"} -> Palantir, Spotify, Zoox, Ro.',
            ].join('\n'),
            inputSchema: {
                ats: z.enum(ATS).optional().describe('Optional filter: "greenhouse" | "lever" | "ashby"; default all'),
                limit: limitSchema,
                offset: offsetSchema,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'List the verified starter boards (free, offline)', ...READ_ONLY_LOCAL },
        },
        async (a) => {
            const list = SEED_BOARDS.filter((s) => !a.ats || s.ats === a.ats).map((s) => ({ type: 'seed_board', ...s }));
            const byAts: Record<string, number> = {};
            for (const s of SEED_BOARDS) byAts[s.ats] = (byAts[s.ats] ?? 0) + 1;
            return paged(list, a.limit ?? 100, a.offset ?? 0, { by_ats: byAts });
        },
    );

    server.registerTool(
        'jobs_search_companies',
        {
            title: 'Search and monitor jobs across many companies (paid Apify Actor)',
            description: [
                'WHAT: Run the Fairquery Apify Actor fairquery/company-jobs-feed over many companies or boards: board discovery, search filters, per-board history (first_seen/last_seen, new/updated/closed, repost detection), optional per-job re-checks and descriptions.',
                'WHEN: Monitoring a company list ("what is new since yesterday?"), searching the verified starter list, or anything that needs history, closed/repost signals or more than a few boards.',
                'WHEN NOT: One board right now (jobs_get_board, free) or one job (jobs_check_open, free).',
                'BEHAVIOR: Read-only on job sites; requires APIFY_TOKEN and runs in YOUR Apify account (waits up to 300 s; history is kept in a named key-value store there). Same politeness rules as the free tools: documented ATS APIs only, 403/429 kill switch, robots.txt on careers pages.',
                'COST: Paid, pay-per-event, billed to your Apify account: $0.00099 per job row, $0.0005 per board scanned, $0.00029 per re-check (confirmOpen), $0.0019 per company found by discovery; no start fee. Error, closed and merged rows are free. Example: 3 boards, 300 jobs = about $0.30. maxJobs caps the job rows.',
                'RETURNS: Paged dataset rows: "job" rows (as jobs_get_board plus first_seen_at, last_seen_at, change, reposted, repost_of, stale_signal, duplicate_of), one "board" row per board (jobs_total, new, updated, closed), "company" rows for discovery, "error" rows (code, message, retryable).',
                'PARAMETERS: companies, boards and useSeedList: at least one is required although the schema marks all optional (none -> INPUT_EMPTY, not billed). onlyNew implies history and compares with the last run that used the same stateStoreName, so use one name per saved search; the first run returns everything as new. limit/offset page the returned rows locally; every call starts a new billed run, so fetch the pages you need from one result instead of re-calling.',
                'EXAMPLE: {"companies":["stripe.com","ramp.com"],"titleIncludes":["engineer"],"countries":["US"],"onlyNew":true}.',
            ].join('\n'),
            inputSchema: {
                companies: z.array(z.string().min(2).max(300)).max(200).optional().describe('Optional (see PARAMETERS). 0-200 names, domains or board URLs. Example: ["stripe.com","Ramp","https://jobs.lever.co/palantir"]'),
                boards: z
                    .array(z.object({ ats: atsSchema, slug: slugSchema, company: z.string().max(200).optional().describe('Optional display name') }))
                    .max(500)
                    .optional()
                    .describe('Optional. 0-500 exact boards. Example: [{"ats":"lever","slug":"palantir"}]'),
                useSeedList: z.boolean().optional().describe('Optional boolean, default false: also scan all verified starter boards (each billed as a board)'),
                titleIncludes: terms('Whole-word title match.', '["engineer"]'),
                titleExcludes: terms('Whole-word title exclusion.', '["intern"]'),
                locations: terms('Location substring match.', '["london"]'),
                countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(50).optional().describe('Optional ISO-2 codes, any-of. Example: ["US","GB"]'),
                remote: z
                    .enum(['any', 'only', 'exclude'])
                    .optional()
                    .describe('Optional, "any" | "only" | "exclude", default "any" (no remote filter). "only" keeps job rows with remote = true (an ATS remote flag, or remote wording such as "Remote" or "Anywhere" in the location or title; see remote_basis); "exclude" drops those rows and keeps rows where remote is false or unknown (null)'),
                departments: terms('Department/team substring match.', '["engineering"]'),
                postedWithinDays: z.number().int().min(1).max(3650).optional().describe('Optional integer 1-3650, default off: keep only job rows whose ATS publish date (posted_at) is at most this many whole days old; rows without an ATS publish date (posted_at = null) are dropped. Free closed rows are not filtered by it. Example: 7'),
                excludeStale: z
                    .boolean()
                    .optional()
                    .describe('Optional boolean, default false. true drops job rows with long_open = true (age_days > 60, counted from posted_at, or from first_seen_at when the ATS gives no date) or reposted = true (a new job id matching a job that closed on the same board within 90 days, from the history in stateStoreName, so never on a board\'s first tracked run). Free closed rows are not filtered by it'),
                onlyNew: z.boolean().optional().describe('Optional boolean, default false: only new/changed jobs since the last tracked run (plus free closed rows)'),
                stateStoreName: z.string().regex(/^[a-zA-Z0-9-]{3,63}$/).optional().describe('Optional, default "fairquery-jobs-feed-state": named key-value store for history in your Apify account'),
                confirmOpen: z.boolean().optional().describe('Optional boolean, default false: re-check each emitted job on its detail endpoint ($0.00029 each, max 200 per run)'),
                includeDescription: z.boolean().optional().describe('Optional boolean, default false: add plain-text descriptions (PII-scrubbed)'),
                maxJobs: z.number().int().min(1).max(50000).optional().describe('Optional integer 1-50000, default 5000: spend cap on billed job rows'),
                limit: limitSchema,
                offset: offsetSchema,
            },
            outputSchema: pagedOutputSchema,
            annotations: { title: 'Search and monitor jobs across many companies (paid Apify Actor)', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (a) => {
            if (!a.companies?.length && !a.boards?.length && !a.useSeedList) return errorResult('INPUT_EMPTY', 'Provide companies, boards or useSeedList: true.');
            const token = getToken();
            if (!token) return errorResult('APIFY_TOKEN_MISSING', MISSING_TOKEN_MESSAGE);
            const { limit, offset, confirmOpen, includeDescription, ...rest } = a;
            try {
                const rows = await runActor(compact({ ...rest, confirmOpen: confirmOpen ? 'detail' : undefined, includeDescription: includeDescription ? 'text' : undefined }), token);
                return paged(rows, limit ?? 50, offset ?? 0, { actor: 'fairquery/company-jobs-feed' });
            } catch (e) {
                return errorResult('APIFY_ACTOR_RUN_FAILED', e instanceof Error ? e.message : String(e), true);
            }
        },
    );

    async function boardMissing(ats: Ats, slug: string): Promise<boolean> {
        try {
            const r = await fetchBoard(client, ats, slug, { maxJobs: 1, withDescription: false });
            return r.notFound;
        } catch {
            return false;
        }
    }

    return server;
}

function seedFor(ats: Ats, slug: string) {
    return SEED_BOARDS.find((s) => s.ats === ats && s.slug.toLowerCase() === slug.toLowerCase());
}

function httpErr(e: unknown) {
    if (e instanceof HttpError) return errorResult(e.code, e.message, e.retryable);
    return errorResult('NETWORK_ERROR', e instanceof Error ? e.message : String(e), true);
}

async function main(): Promise<void> {
    await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
    console.error('fairquery-jobs-feed MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
