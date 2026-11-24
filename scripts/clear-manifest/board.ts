/**
 * Pure rules for the CLEAR board manifest.
 * Greenhouse, Lever, and Ashby only. No embed URLs. No description storage.
 */
import { parseBoardUrl } from '../../src/discovery.js';

export const CLEAR_ATS = ['greenhouse', 'lever', 'ashby'] as const;
export type ClearAts = (typeof CLEAR_ATS)[number];

/** Rival self-published CLEAR-family board counts (2026-09-27). Parity ceiling, not a data source. */
export const CLEAR_PARITY_TARGET = 8854;
export const CLEAR_PARITY_BY_ATS: Record<ClearAts, number> = {
    greenhouse: 5243,
    ashby: 3355,
    lever: 256,
};

export const USER_AGENT = 'FairqueryJobsFeed/1.0 (+https://getfairquery.com; info@getfairquery.com)';

/** Floor between Lever request starts. robots.txt on api.lever.co sets Crawl-delay: 1. */
export const LEVER_MIN_INTERVAL_MS = 1000;
export const MAX_429_STRIKES = 3;
export const BACKOFF_CAP_MS = 15 * 60_000;

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isClearAts(value: string): value is ClearAts {
    return (CLEAR_ATS as readonly string[]).includes(value);
}

export function isClearSlug(slug: string): boolean {
    return SLUG_RE.test(slug) && !slug.includes('..');
}

export function jobsApiUrl(ats: ClearAts, slug: string): string {
    const enc = encodeURIComponent(slug);
    if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${enc}/jobs`;
    if (ats === 'lever') return `https://api.lever.co/v0/postings/${enc}?mode=json`;
    return `https://api.ashbyhq.com/posting-api/job-board/${enc}?includeCompensation=true`;
}

export function leverEuJobsApiUrl(slug: string): string {
    return `https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

/** Public board page used only to read <title> for Lever and Ashby company identity. */
export function boardTitleUrl(ats: ClearAts, slug: string): string | null {
    const enc = encodeURIComponent(slug);
    if (ats === 'ashby') return `https://jobs.ashbyhq.com/${enc}`;
    if (ats === 'lever') return `https://jobs.lever.co/${enc}`;
    return null;
}

export function leverEuTitleUrl(slug: string): string {
    return `https://jobs.eu.lever.co/${encodeURIComponent(slug)}`;
}

export function urlUsesEmbed(url: string): boolean {
    return /\/embed(\/|$)/i.test(url);
}

export function backoffMs(strike: number, retryAfterMs: number | null): number {
    const n = Math.max(1, strike);
    const floor = 60_000 * 2 ** (n - 1);
    return Math.min(BACKOFF_CAP_MS, Math.max(floor, retryAfterMs ?? 0));
}

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (!trimmed) return null;
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return null;
    return Math.max(0, when - nowMs);
}

export function workerEgressReason(
    env: NodeJS.ProcessEnv,
    globals: { caches?: { default?: unknown }; WebSocketPair?: unknown },
): string | null {
    for (const key of ['CF_WORKER', 'CLOUDFLARE_WORKER', 'CF_PAGES']) {
        if (env[key]) return key;
    }
    if (globals.caches && 'default' in globals.caches && globals.WebSocketPair !== undefined) {
        return 'cloudflare-worker-globals';
    }
    return null;
}

const LEGAL = new Set([
    'inc',
    'llc',
    'ltd',
    'gmbh',
    'corp',
    'corporation',
    'co',
    'company',
    'plc',
    'ag',
    'sa',
    'bv',
    'the',
    'incorporated',
    'limited',
]);

export function coreCompany(value: string): string {
    const folded = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const words = folded
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w && !LEGAL.has(w));
    return words.join(' ');
}

function longWords(core: string): string[] {
    return core.split(' ').filter((w) => w.length >= 4);
}

/**
 * Intended company vs the name the board itself returns.
 * Long-word sets must be equal, so "Apex Space" does not match "Apex Eye"
 * and "Hinge Health" does not match a board named only "Hinge".
 * Words shorter than 4 characters are ignored when both sides have a longer word
 * ("DoorDash USA" matches "DoorDash"). When neither side has a long word, the
 * full cores must be equal ("Fin" does not match "Financial").
 */
export function companyMatches(intended: string, observed: string): boolean {
    const a = coreCompany(intended);
    const b = coreCompany(observed);
    if (!a || !b) return false;
    if (a === b) return true;
    const la = longWords(a);
    const lb = longWords(b);
    if (!la.length || !lb.length) return false;
    if (la.length !== lb.length) return false;
    const sb = new Set(lb);
    return la.every((w) => sb.has(w));
}

const AGGREGATOR_NAMES = new Set([
    'ziprecruiter',
    'indeed',
    'glassdoor',
    'simplyhired',
    'snagajob',
    'careerbuilder',
    'monster',
]);

/**
 * The board is an aggregator, not an employer's own public board.
 * A company greenhouse token whose name mentions a channel ("Stone - Indeed")
 * stays; ZipRecruiter itself does not.
 */
export function aggregatorBoardReason(slug: string, company: string | null | undefined): string | null {
    const slugCore = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
    const companyCore = coreCompany(company ?? '');
    const folded = companyCore.replace(/ /g, '');
    if (AGGREGATOR_NAMES.has(slugCore) && (!companyCore || folded === slugCore || AGGREGATOR_NAMES.has(folded))) {
        return 'aggregator_board';
    }
    if (AGGREGATOR_NAMES.has(folded)) return 'aggregator_board';
    if (/job wrapping|external feed/i.test(company ?? '')) return 'aggregator_feed';
    return null;
}

export function companyFromBoardTitle(title: string): string | null {
    let t = decodeBasicEntities(title).replace(/\s+/g, ' ').trim();
    t = t.replace(/\s*[|·•]\s*.*$/, '').trim();
    t = t.replace(/\s+(jobs|careers|job board|open roles|open positions)$/i, '').trim();
    if (!t || t.length > 80) return null;
    if (/^(not found|page not found|error|404|forbidden|just a moment|attention required|jobs|careers|lever|ashby|greenhouse)$/i.test(t)) {
        return null;
    }
    return t;
}

export function decodeBasicEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number.parseInt(num, 10)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

export function titleFromHtml(html: string): string | null {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!m) return null;
    return m[1].replace(/<[^>]+>/g, ' ').trim() || null;
}

const DROP_KEYS = new Set([
    'description',
    'descriptionPlain',
    'descriptionHtml',
    'descriptionBody',
    'descriptionBodyPlain',
    'content',
    'additional',
    'additionalPlain',
    'lists',
    'opening',
    'openingPlain',
]);

/** Parse an ATS JSON body and drop description fields so they are not kept. */
export function parseAtsJson(text: string): unknown {
    return JSON.parse(text, (key, value) => (DROP_KEYS.has(key) ? undefined : value));
}

export interface PublishedBoard {
    jobs: number;
    company: string | null;
    titles: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function jobTitle(row: Record<string, unknown>): string | null {
    const raw = row.title ?? row.text;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function publishedBoard(ats: ClearAts, body: unknown, titleCap = 5): PublishedBoard {
    const titles: string[] = [];
    const pushTitle = (row: Record<string, unknown>) => {
        if (titles.length >= titleCap) return;
        const t = jobTitle(row);
        if (t) titles.push(t);
    };
    if (ats === 'lever') {
        if (!Array.isArray(body)) return { jobs: 0, company: null, titles: [] };
        let jobs = 0;
        for (const row of body) {
            const rec = asRecord(row);
            if (!rec || !jobTitle(rec)) continue;
            jobs++;
            pushTitle(rec);
        }
        return { jobs, company: null, titles };
    }
    const root = asRecord(body);
    const list = root && Array.isArray(root.jobs) ? root.jobs : [];
    let company: string | null = null;
    let jobs = 0;
    for (const row of list) {
        const rec = asRecord(row);
        if (!rec) continue;
        if (ats === 'ashby' && rec.isListed === false) continue;
        if (!jobTitle(rec)) continue;
        jobs++;
        pushTitle(rec);
        if (!company && typeof rec.company_name === 'string' && rec.company_name.trim()) {
            company = rec.company_name.trim();
        }
    }
    return { jobs, company, titles };
}

export function countTitleKeyword(titles: string[], keyword: string): number {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return titles.filter((t) => re.test(t)).length;
}

/** First path slug on a public Greenhouse, Lever, or Ashby board URL. Never an embed. */
export function slugFromBoardUrl(raw: string): { ats: ClearAts; slug: string } | null {
    const parsed = parseBoardUrl(raw);
    if (!parsed || !isClearAts(parsed.ats) || !isClearSlug(parsed.slug)) return null;
    if (urlUsesEmbed(raw)) return null;
    return { ats: parsed.ats, slug: parsed.slug };
}

export interface ManifestRow {
    ats: ClearAts;
    slug: string;
    company?: string;
    jobs: number;
    http_status: 200;
    verified_at: string;
    verified_by: 'api_live_probe';
    company_match: 'api_company_name' | 'board_title';
    source_url: string;
    sources: string[];
}

export function manifestLine(row: ManifestRow): string {
    const ordered: ManifestRow = {
        ats: row.ats,
        slug: row.slug,
        ...(row.company ? { company: row.company } : {}),
        jobs: row.jobs,
        http_status: 200,
        verified_at: row.verified_at,
        verified_by: 'api_live_probe',
        company_match: row.company_match,
        source_url: row.source_url,
        sources: [...row.sources].sort(),
    };
    return JSON.stringify(ordered);
}
