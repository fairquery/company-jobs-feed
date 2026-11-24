export const SCHEMA_VERSION = '1.0.0';
export const USER_AGENT = 'FairqueryJobsFeed/1.0 (+https://getfairquery.com; info@getfairquery.com)';
/** Product token used for robots.txt group matching. */
export const ROBOTS_AGENT = 'FairqueryJobsFeed';

export const CHARGE_EVENTS = {
    job: 'job-result',
    board: 'board-scanned',
    openConfirmed: 'open-confirmed',
    companyDiscovered: 'company-discovered',
} as const;

export const PRICES_USD = {
    'job-result': 0.00099,
    'board-scanned': 0.0005,
    'open-confirmed': 0.00029,
    'company-discovered': 0.0019,
} as const;

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'personio' | 'pinpoint' | 'gem';
/**
 * ATS boards discovery may probe. Personio, Pinpoint and Gem are never probed or crawled;
 * the caller names the account, subdomain or vanity path.
 */
export type DiscoverableAts = Exclude<Ats, 'personio' | 'pinpoint' | 'gem'>;
/** Feeds the caller names. Not in the starter list and not discovered from careers pages. */
export type NamedFeedAts = 'personio' | 'pinpoint' | 'gem';
/**
 * Hosts of hiring systems we deliberately do not support. Nothing under these domains is ever fetched,
 * not even during careers-page discovery. SmartRecruiters' robots.txt disallows non-LinkedIn bots on its API.
 * Workday, Workable and Recruitee have no public API documented for outside use. LinkedIn is out of scope.
 * Rippling is blocked the same way (no public third-party job API we use).
 * Personio, Pinpoint and Gem directory hosts are refused separately so this suffix list does not also
 * block a named Personio account, a named Pinpoint subdomain, or api.gem.com job_posts reads.
 * Gem's Job Board API is implemented only under Fairquery's 2026-10-26 accepted-risk override
 * (policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md). It is not a blocked host.
 */
const EXCLUDED_HOST_SUFFIXES = [
    'smartrecruiters.com',
    'myworkdayjobs.com',
    'workday.com',
    'workable.com',
    'recruitee.com',
    'linkedin.com',
    'rippling.com',
];
export const EXCLUDED_ATS_NAMES = ['smartrecruiters', 'workday', 'workable', 'recruitee', 'linkedin', 'rippling'];

/** One DNS label: letters, digits, hyphens. Shared by Personio accounts and Pinpoint subdomains. */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** Company label in {account}.jobs.personio.de. */
const PERSONIO_ACCOUNT_RE = DNS_LABEL_RE;
/** Company label in {subdomain}.pinpointhq.com. */
const PINPOINT_SUBDOMAIN_RE = DNS_LABEL_RE;
/**
 * Gem job-board vanity path. One segment: letters, digits, hyphens, underscores.
 * No dots, slashes or other punctuation, so the path cannot escape /job_posts/.
 */
const GEM_VANITY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

export function normHost(host: string): string {
    return host.toLowerCase().replace(/\.$/, '');
}

export function isValidPersonioAccount(s: string): boolean {
    return PERSONIO_ACCOUNT_RE.test(s) && s.toLowerCase() !== 'www';
}

export function isValidPinpointSubdomain(s: string): boolean {
    return PINPOINT_SUBDOMAIN_RE.test(s) && s.toLowerCase() !== 'www';
}

export function isValidGemVanity(s: string): boolean {
    return GEM_VANITY_RE.test(s);
}

export function isNamedFeedAts(ats: Ats): ats is NamedFeedAts {
    return ats === 'personio' || ats === 'pinpoint' || ats === 'gem';
}

/** Documented feed host only: {account}.jobs.personio.de. The .com twin is not a fetch target. */
export function isPersonioTenantHost(host: string): boolean {
    const h = normHost(host);
    return !!personioAccountFromHost(h) && h.endsWith('.jobs.personio.de');
}

/**
 * Personio-owned hosts that are not a named company feed: the apex, the jobs directory,
 * developer/marketing hosts, and the .com career alias. Never fetched.
 */
export function isPersonioDirectoryHost(host: string): boolean {
    const h = normHost(host);
    if (isPersonioTenantHost(h)) return false;
    return h === 'personio.de' || h === 'personio.com' || h.endsWith('.personio.de') || h.endsWith('.personio.com');
}

/** Account named by {account}.jobs.personio.de or the .com alias. Null for the bare directory host and www. */
export function personioAccountFromHost(host: string): string | null {
    const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.jobs\.personio\.(de|com)$/.exec(normHost(host));
    if (!m || m[1] === 'www') return null;
    return m[1];
}

/** Documented feed host only: {subdomain}.pinpointhq.com. www and the apex are not tenants. */
export function isPinpointTenantHost(host: string): boolean {
    const h = normHost(host);
    return !!pinpointSubdomainFromHost(h);
}

/**
 * Pinpoint-owned hosts that are not a named company feed: the apex, www, and any host that is
 * not exactly one company label under pinpointhq.com. Never crawled.
 */
export function isPinpointDirectoryHost(host: string): boolean {
    const h = normHost(host);
    if (isPinpointTenantHost(h)) return false;
    return h === 'pinpointhq.com' || h.endsWith('.pinpointhq.com');
}

/** Subdomain named by {subdomain}.pinpointhq.com. Null for the apex, www, and nested hosts. */
export function pinpointSubdomainFromHost(host: string): string | null {
    const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pinpointhq\.com$/.exec(normHost(host));
    if (!m || m[1] === 'www') return null;
    return m[1];
}

export function isPinpointPostingsPath(pathname: string): boolean {
    const path = pathname.replace(/\/+$/, '') || '/';
    return path === '/postings.json';
}

/** The only Gem host this Actor calls. */
export function isGemApiHost(host: string): boolean {
    return normHost(host) === 'api.gem.com';
}

/** gem.com and every other Gem host, including jobs.gem.com. Not a fetch target. */
export function isGemDirectoryHost(host: string): boolean {
    const h = normHost(host);
    if (isGemApiHost(h)) return false;
    return h === 'gem.com' || h.endsWith('.gem.com');
}

/** True only for /job_board/v0/{vanity}/job_posts with a valid vanity. No other Gem path. */
export function isGemJobPostsPath(pathname: string): boolean {
    const path = pathname.replace(/\/+$/, '') || '/';
    const m = /^\/job_board\/v0\/([^/]+)\/job_posts$/.exec(path);
    if (!m) return false;
    let vanity = m[1];
    try {
        vanity = decodeURIComponent(vanity);
    } catch {
        return false;
    }
    return isValidGemVanity(vanity);
}

export function excludedHost(host: string): boolean {
    const h = normHost(host);
    if (isPersonioTenantHost(h) || isPinpointTenantHost(h) || isGemApiHost(h)) return false;
    if (isPersonioDirectoryHost(h) || isPinpointDirectoryHost(h) || isGemDirectoryHost(h)) return true;
    return EXCLUDED_HOST_SUFFIXES.some((d) => h === d || h.endsWith(`.${d}`));
}

export const ATS_LIST: Ats[] = ['greenhouse', 'lever', 'ashby', 'personio', 'pinpoint', 'gem'];
export const DISCOVERABLE_ATS: DiscoverableAts[] = ['greenhouse', 'lever', 'ashby'];

/**
 * Fixed hosts for the Greenhouse, Lever and Ashby JSON APIs.
 * Personio, Pinpoint and Gem are not here and are never probed:
 * Personio is https://{account}.jobs.personio.de/xml,
 * Pinpoint is https://{subdomain}.pinpointhq.com/postings.json,
 * Gem is https://api.gem.com/job_board/v0/{vanity}/job_posts/ for a vanity the caller names.
 */
export const ATS_API_HOSTS: Record<DiscoverableAts, string> = {
    greenhouse: 'boards-api.greenhouse.io',
    lever: 'api.lever.co',
    ashby: 'api.ashbyhq.com',
};

/** Host that actually receives the documented read for one board. */
export function boardHost(ats: Ats, slug: string): string {
    if (ats === 'personio') return `${slug.toLowerCase()}.jobs.personio.de`;
    if (ats === 'pinpoint') return `${slug.toLowerCase()}.pinpointhq.com`;
    if (ats === 'gem') return 'api.gem.com';
    return ATS_API_HOSTS[ats];
}

/**
 * Minimum gap between request starts (ms). Lever's robots.txt sets Crawl-delay: 1.
 * `jobs.personio.de` is the shared pace key for every {account}.jobs.personio.de host.
 * `api.gem.com` is one shared lane for every named vanity (1 request/second, well under Gem's 20 rps key limit).
 * Pinpoint tenants are not in this map: each {subdomain}.pinpointhq.com is its own lane at PINPOINT_MIN_INTERVAL_MS.
 */
export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
    'api.lever.co': 1000,
    'jobs.personio.de': 1500,
    'api.gem.com': 1000,
};
/** Per-tenant gap for {subdomain}.pinpointhq.com. One request at a time, at most 1 per second. */
export const PINPOINT_MIN_INTERVAL_MS = 1000;
/** Cap on a Crawl-delay we will wait out. Longer values are treated as this. */
const CRAWL_DELAY_CAP_MS = 60_000;
/** Cap on a Personio Crawl-delay we will wait out. Longer values are treated as this. */
export const PERSONIO_CRAWL_DELAY_CAP_MS = CRAWL_DELAY_CAP_MS;
/** Cap on a Pinpoint Crawl-delay we will wait out. Longer values are treated as this. */
export const PINPOINT_CRAWL_DELAY_CAP_MS = CRAWL_DELAY_CAP_MS;
export const HOST_CONCURRENCY = 2;
/** Actor multi-board pool. The place scan uses {@link LOCATION_SCAN_CONCURRENCY} instead. */
export const BOARD_CONCURRENCY = 6;
/**
 * In-flight starter boards for one `jobs_search_by_location` call.
 * The scan used to share {@link BOARD_CONCURRENCY} (6), which on the Paid Worker
 * lined up with about six rotating NETWORK_ERRORs per Pennsylvania search.
 * 4 keeps two ATS hosts busy. Per-host concurrency stays {@link HOST_CONCURRENCY}
 * so the 90 Greenhouse boards are not forced through one slot on the 25 s wall clock.
 */
export const LOCATION_SCAN_CONCURRENCY = 4;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_JSON_BYTES = 40_000_000;
/**
 * Wall clock for one jobs_search_by_location scan. Network waits count here; the CPU budget below
 * does not. Returning before the Worker isolate is killed keeps a slow scan as MCP JSON.
 */
export const LOCATION_SCAN_BUDGET_MS = 25_000;
/**
 * Estimated synchronous parse-and-match budget for one place scan, in milliseconds.
 *
 * Deployed Workers freeze `performance.now()` and `Date.now()` until I/O (Spectre mitigation),
 * so a clock delta around the JSON walk stays 0 and never trips before the isolate is killed.
 * The Free plan killed `jobs_search_by_location` at about 2,010 ms of real CPU (2026-10-27,
 * version 536268c0) while an 8,000 ms clock budget was still idle. 1.1.15 charged 1,000 ms
 * and soft-stopped a Costa Mesa + avionics scan near starter board 26 (Anduril is index 32).
 * Paid Workers default to about 30 seconds of CPU (up to 5 minutes if `cpu_ms` is set). This
 * budget stays a hard ceiling: one call does not run unbounded. 12,000 ms of charged work is
 * about three times a full starter-list walk scaled from that live stop (~28,000 jobs, about
 * 4 seconds) and still returns partial JSON before a 30 second hard kill. See
 * {@link LOCATION_SCAN_CPU_BYTES_PER_MS}. The 25 s wall clock stays a second stop.
 * `meta.cost_usd` stays 0. No rows are invented.
 */
export const LOCATION_SCAN_CPU_BUDGET_MS = 12_000;
/**
 * Consumed JSON characters charged as one millisecond of {@link LOCATION_SCAN_CPU_BUDGET_MS}.
 * Job-object walks of this parser used about 19,000 characters per millisecond of CPU in Node.
 * 8,000 characters per millisecond stops the 12,000 ms budget after 96,000,000 characters:
 * about 5 seconds at that Node rate, about 10–15 seconds if the isolate is 2–3× slower, and
 * about 20 seconds at 4×, still under the Paid default of ~30 seconds.
 */
export const LOCATION_SCAN_CPU_BYTES_PER_MS = 8_000;
/**
 * Stop reading one board after this much JSON and continue with the other boards. Greenhouse
 * `content=true` bodies (Anduril is about 44 MB) are the boards this cuts; a short list still fits.
 */
export const LOCATION_SCAN_BOARD_MAX_BYTES = 3_000_000;
/** Decode and scan the body in slices so a large read checks the CPU and wall budgets. */
export const LOCATION_SCAN_STREAM_SLICE_BYTES = 8_192;
/** Characters kept from one JSON string while streaming a board. Descriptions are the long fields. */
export const LOCATION_SCAN_MAX_STRING_CHARS = 20_000;
/** A single job object larger than this after that cap is skipped, not parsed. */
export const LOCATION_SCAN_MAX_ELEMENT_CHARS = 160_000;
/**
 * Estimated CPU milliseconds charged for building one job row (map, fingerprint, filters).
 * Character charging alone missed this work. An empty-keyword state search built every
 * matching row and the Free Worker was killed before it could return JSON.
 * 0.08 ms is about one row-build on top of the character charge. A lite Anduril list
 * (~2,500 jobs) is about 200 ms of row charge and still fits in one call. The matched-row
 * cap below returns JSON before an empty-keyword search serializes every hit.
 */
export const LOCATION_SCAN_ROW_CPU_MS = 0.08;
/**
 * Matched rows kept in one place scan. The next match sets `stop_reason` to `row_cap`
 * and the call returns the rows already found. Keeps the JSON body small enough to
 * serialize before the Free-plan CPU kill.
 */
export const LOCATION_SCAN_MATCHED_ROW_CAP = 200;
/**
 * Do not request Greenhouse `content=true` when the lite list has more jobs than this.
 * Anduril's body is about 44 MB and the Worker isolate is 128 MB. Paid CPU headroom
 * does not make that body safe. The free tool uses the same cutoff on every runtime.
 */
export const LOCATION_SCAN_HOSTED_BODY_MAX_JOBS = 1_000;
/**
 * Hard ceiling on ATS requests in one place scan. The free tool applies this on every
 * runtime, including the hosted Worker. One call does not run unbounded.
 *
 * Paid Workers allow 10,000 subrequests. Free allowed 50, which is why 1.1.15 used 36
 * and stopped a 135-board pass early. A full starter pass is one lite request per board
 * (135) plus a second Greenhouse body only when a place hit still needs a description and
 * the board has at most {@link LOCATION_SCAN_HOSTED_BODY_MAX_JOBS} jobs. Anduril and
 * SpaceX are over that size, so they never take a body. Worst case is 135 list requests
 * + 88 Greenhouse bodies = 223. 300 covers that plus the pool starting up to
 * {@link LOCATION_SCAN_CONCURRENCY} requests that already passed the gate, plus a
 * handful of {@link LOCATION_SCAN_MAX_ATTEMPTS} retries, and stays far under 10,000.
 * Each retry counts toward this cap. Hitting the cap still returns partial JSON
 * with `next_board_cursor`. The cap is not raised for retries.
 */
export const LOCATION_SCAN_MAX_REQUESTS = 300;
/**
 * Attempts for one place-scan board GET, including the first. A network error,
 * timeout, or HTTP 5xx that happens before any job is read gets one retry.
 * HTTP 403/429 still kill the host and are not retried. A second failure is a
 * skipped board (`NETWORK_ERROR` or `ATS_HTTP_ERROR` in `meta.notes`).
 */
export const LOCATION_SCAN_MAX_ATTEMPTS = 2;
/**
 * Wall-clock pause before that one retry. Short enough that a few transient
 * failures fit the 25 s scan budget. It is not charged as CPU.
 */
export const LOCATION_SCAN_RETRY_DELAY_MS = 300;
export const MAX_HTML_BYTES = 2_000_000;
export const MAX_CAREERS_PAGES_PER_DOMAIN = 3;
export const MAX_PROBES_PER_COMPANY = 6;
export const DISCOVERY_CACHE_DAYS = 30;
export const REPOST_WINDOW_DAYS = 90;
export const CLOSED_RETENTION_DAYS = 120;
export const MAX_DESCRIPTION_CHARS = 20_000;

export const LIMITS = {
    companies: 200,
    boards: 500,
    maxJobs: 50_000,
    maxJobsPerBoard: 20_000,
    titleTerms: 50,
    locationTerms: 50,
    regexLength: 200,
    maxOpenChecks: 2_000,
};

export type RemoteMode = 'any' | 'only' | 'exclude';
export type DedupeMode = 'none' | 'exact' | 'role';
type DescriptionMode = 'none' | 'text';
type ConfirmOpenMode = 'none' | 'detail';
type ChangeKind = 'new' | 'updated' | 'unchanged' | 'closed';

export interface BoardRef {
    ats: Ats;
    slug: string;
    company?: string;
    domain?: string;
    discovered_via?: 'input' | 'board_url' | 'seed_list' | 'careers_page' | 'slug_probe' | 'cache';
    input?: string;
}

export interface ActorInput {
    companies?: string[];
    boards?: (string | { ats?: string; slug?: string; token?: string; company?: string; domain?: string })[];
    useSeedList?: boolean;
    discover?: boolean;
    titleIncludes?: string[];
    titleExcludes?: string[];
    /** Whole-word match against the title or scrubbed description. */
    descriptionIncludes?: string[];
    titleRegex?: string;
    locations?: string[];
    countries?: string[];
    remote?: RemoteMode;
    companyFilter?: string[];
    departments?: string[];
    employmentTypes?: string[];
    postedWithinDays?: number;
    maxAgeDays?: number;
    includeUnknownPostedDate?: boolean;
    hasSalary?: boolean;
    excludeStale?: boolean;
    longOpenDays?: number;
    onlyNew?: boolean;
    trackChanges?: boolean;
    emitClosed?: boolean;
    dedupe?: DedupeMode;
    includeDescription?: DescriptionMode;
    scrubPII?: boolean;
    confirmOpen?: ConfirmOpenMode;
    maxOpenChecks?: number;
    maxJobs?: number;
    maxJobsPerBoard?: number;
    stateStoreName?: string;
}

/** A job as normalized from one ATS response, before history/filters. */
export interface NormalizedJob {
    ats: Ats;
    board: string;
    company: string;
    job_id: string;
    title: string;
    department: string | null;
    team: string | null;
    locations: string[];
    countries: string[];
    country_basis: 'ats' | 'text' | null;
    remote: boolean | null;
    remote_basis: 'ats' | 'text' | null;
    workplace_type: 'remote' | 'hybrid' | 'onsite' | null;
    employment_type: string | null;
    compensation: Compensation | null;
    posted_at: string | null;
    ats_updated_at: string | null;
    apply_url: string | null;
    job_url: string | null;
    description_text: string | null;
    detail_url: string | null;
}

export interface Compensation {
    summary: string | null;
    min: number | null;
    max: number | null;
    currency: string | null;
    interval: string | null;
}

export interface JobRow extends Omit<NormalizedJob, 'detail_url'> {
    schema_version: string;
    type: 'job';
    job_key: string;
    company_domain: string | null;
    status: 'open' | 'closed';
    open_check: 'listed' | 'detail_open' | 'detail_closed' | 'detail_not_supported' | 'detail_failed' | 'not_seen';
    verified_open_at: string | null;
    first_seen_at: string;
    last_seen_at: string;
    age_days: number | null;
    age_basis: 'posted_at' | 'first_seen' | null;
    long_open: boolean;
    reposted: boolean;
    stale_signal: 'none' | 'long_open' | 'reposted';
    repost_of: string | null;
    change: ChangeKind | null;
    fingerprint: string;
    duplicate_group: string | null;
    duplicate_of: string | null;
    merged_job_ids: string[];
    source_url: string;
    checked_at: string;
}

export interface BoardRow {
    schema_version: string;
    type: 'board';
    ats: Ats;
    board: string;
    company: string;
    company_domain: string | null;
    discovered_via: BoardRef['discovered_via'];
    source_url: string;
    checked_at: string;
    jobs_total: number;
    jobs_matched: number;
    jobs_emitted: number;
    complete: boolean;
    new: number | null;
    updated: number | null;
    closed: number | null;
    reposted: number | null;
    requests: number;
}

export interface CompanyRow {
    schema_version: string;
    type: 'company';
    input: string;
    company: string | null;
    domain: string | null;
    boards: { ats: Ats; slug: string; via: string; confidence: 'high' | 'medium' }[];
    careers_pages_fetched: string[];
    probes: number;
    cached: boolean;
    source_url: string;
    checked_at: string;
}

export interface ErrorRow {
    schema_version: string;
    type: 'error';
    code: string;
    message: string;
    retryable: boolean;
    ats?: Ats;
    board?: string;
    input?: string;
    host?: string;
    source_url: string | null;
    checked_at: string;
    context?: Record<string, unknown>;
}
