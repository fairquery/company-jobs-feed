import { isValidSlug, probeBoard } from './ats.js';
import { type AtsClient, type CareersFetcher, HttpError } from './http.js';
import { normText } from './normalize.js';
import { SEED_BOARDS, type SeedBoard } from './seed.js';
import {
    type Ats,
    ATS_API_HOSTS,
    DISCOVERABLE_ATS,
    type DiscoverableAts,
    EXCLUDED_ATS_NAMES,
    excludedHost,
    isValidGemVanity,
    isValidPersonioAccount,
    isValidPinpointSubdomain,
    MAX_CAREERS_PAGES_PER_DOMAIN,
    MAX_PROBES_PER_COMPANY,
    personioAccountFromHost,
    pinpointSubdomainFromHost,
} from './types.js';

interface FoundBoard {
    ats: Ats;
    slug: string;
    via: 'board_url' | 'careers_page' | 'slug_probe' | 'seed_list';
    confidence: 'high' | 'medium';
}

/** Name of an unsupported hiring system if the input points at one ("smartrecruiters:acme", a Workday URL, ...). */
export function unsupportedAts(raw: string): string | null {
    const s = raw.trim();
    const m = new RegExp(`^(${EXCLUDED_ATS_NAMES.join('|')})\\s*[:/]`, 'i').exec(s);
    if (m) return m[1].toLowerCase();
    try {
        const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
        if (excludedHost(u.hostname)) return u.hostname.toLowerCase();
    } catch {
        /* not a URL */
    }
    return null;
}

/** Board-URL patterns on the ATS's own public hosts. Returns null when the string isn't a board URL. */
export function parseBoardUrl(raw: string): { ats: Ats; slug: string } | null {
    const s = raw.trim();
    const m = /^(greenhouse|lever|ashby|personio|pinpoint|gem)\s*[:/]\s*([A-Za-z0-9._-]+)$/i.exec(s);
    if (m) return checked(m[1].toLowerCase() as Ats, m[2]);
    let u: URL;
    try {
        u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase();
    const personioAccount = personioAccountFromHost(host);
    // Any path on a named career host only names the account. The fetch is always /xml on .de.
    if (personioAccount) return checked('personio', personioAccount);
    const pinpointSubdomain = pinpointSubdomainFromHost(host);
    // Any path only names the subdomain. The fetch is always /postings.json, never jobs.json.
    if (pinpointSubdomain) return checked('pinpoint', pinpointSubdomain);
    const gemVanity = gemVanityFromUrl(host, segOf(u));
    if (host === 'jobs.gem.com' || host === 'api.gem.com') return gemVanity ? checked('gem', gemVanity) : null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
        const forParam = u.searchParams.get('for');
        if (forParam) return checked('greenhouse', forParam);
        if (seg[0] && seg[0] !== 'embed') return checked('greenhouse', seg[0]);
        return null;
    }
    if (host === 'boards-api.greenhouse.io' && seg[0] === 'v1' && seg[1] === 'boards' && seg[2])
        return checked('greenhouse', seg[2]);
    if (host === 'jobs.lever.co' && seg[0]) return checked('lever', seg[0]);
    if (host === 'api.lever.co' && seg[0] === 'v0' && seg[1] === 'postings' && seg[2]) return checked('lever', seg[2]);
    if (host === 'jobs.ashbyhq.com' && seg[0] && seg[0] !== 'api') return checked('ashby', seg[0]);
    if (host === 'api.ashbyhq.com' && seg[0] === 'posting-api' && seg[1] === 'job-board' && seg[2])
        return checked('ashby', seg[2]);
    return null;
}

function checked(ats: Ats, slug: string): { ats: Ats; slug: string } | null {
    const decoded = safeDecode(slug);
    if (ats === 'personio') return isValidPersonioAccount(decoded) ? { ats, slug: decoded.toLowerCase() } : null;
    if (ats === 'pinpoint') return isValidPinpointSubdomain(decoded) ? { ats, slug: decoded.toLowerCase() } : null;
    if (ats === 'gem') return isValidGemVanity(decoded) ? { ats, slug: decoded.toLowerCase() } : null;
    return isValidSlug(decoded) ? { ats, slug: decoded } : null;
}

function segOf(u: URL): string[] {
    return u.pathname.split('/').filter(Boolean).map(safeDecode);
}

const GEM_API_RESOURCES = new Set(['job_posts', 'departments', 'offices']);

/**
 * jobs.gem.com/{vanity}/... names the vanity.
 * api.gem.com names it only on /job_board/v0/{vanity}/{job_posts|departments|offices}/...
 * so the OpenAPI page /job_board/v0/reference is not a board.
 */
function gemVanityFromUrl(host: string, seg: string[]): string | null {
    if (host === 'jobs.gem.com') return seg[0] && isValidGemVanity(seg[0]) ? seg[0].toLowerCase() : null;
    if (
        host === 'api.gem.com' &&
        seg[0] === 'job_board' &&
        seg[1] === 'v0' &&
        seg[2] &&
        isValidGemVanity(seg[2]) &&
        GEM_API_RESOURCES.has(seg[3] ?? '')
    ) {
        return seg[2].toLowerCase();
    }
    return null;
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

const LINK_RE =
    /https?:(?:\/\/|\\\/\\\/)(?:boards|job-boards)\.greenhouse\.io[^\s"'<>)]*|https?:\/\/(?:jobs\.lever\.co|jobs\.ashbyhq\.com)\/[^\s"'<>)]*/gi;

/** ATS board links or embeds that a company publishes on its own careers page. */
export function extractBoardLinks(html: string): { ats: Ats; slug: string }[] {
    const out = new Map<string, { ats: Ats; slug: string }>();
    const text = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    for (const m of text.match(LINK_RE) ?? []) {
        const b = parseBoardUrl(m);
        if (b) out.set(`${b.ats}:${b.slug.toLowerCase()}`, b);
    }
    // Greenhouse embed: <script src=".../embed/job_board/js?for=slug">, or Grnhse.Settings.boardToken
    for (const m of text.matchAll(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9._-]+)/gi)) {
        const b = checked('greenhouse', m[1]);
        if (b) out.set(`greenhouse:${b.slug.toLowerCase()}`, b);
    }
    return [...out.values()];
}

/** Same-site careers links on a company's home page ("/careers", "careers.example.com", "/jobs"). */
export function findCareersLinks(html: string, pageUrl: string): string[] {
    const base = new URL(pageUrl);
    const site = registrableDomain(base.hostname);
    const out: string[] = [];
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
        const href = m[1];
        const label = m[2].replace(/<[^>]+>/g, ' ');
        if (!/career|jobs|join[- ]us|work[- ]with[- ]us|hiring|open (roles|positions)/i.test(`${href} ${label}`))
            continue;
        let u: URL;
        try {
            u = new URL(href, base);
        } catch {
            continue;
        }
        if (!/^https?:$/.test(u.protocol)) continue;
        if (registrableDomain(u.hostname) !== site) continue;
        u.hash = '';
        if (!out.includes(u.toString())) out.push(u.toString());
    }
    return out.slice(0, 5);
}

const MULTI_TLDS = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/i;
export function registrableDomain(host: string): string {
    const h = host.toLowerCase().replace(/^www\./, '');
    const parts = h.split('.');
    const n = MULTI_TLDS.test(h) ? 3 : 2;
    return parts.slice(-n).join('.');
}

/** "https://www.ramp.com/careers" -> "ramp.com"; "Palantir" -> null */
export function domainOf(input: string): string | null {
    const s = input.trim();
    if (/\s/.test(s) || !s.includes('.')) return null;
    try {
        const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
        return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
}

/** Slug candidates from a company name or domain, most likely first. */
export function slugCandidates(input: string): string[] {
    const dom = domainOf(input);
    const out: string[] = [];
    const add = (s: string) => {
        if (s && isValidSlug(s) && !out.includes(s)) out.push(s);
    };
    if (dom) {
        const site = registrableDomain(dom);
        const stem = site.split('.')[0];
        add(stem);
        add(stem.replace(/-/g, ''));
    } else {
        const n = normText(input)
            .replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|plc|ag|sa|bv|the)\b/g, ' ')
            .trim();
        const words = n.split(/\s+/).filter(Boolean);
        add(words.join(''));
        add(words.join('-'));
        if (words.length > 1) add(words[0]);
    }
    return out.slice(0, 3);
}

/**
 * Probe order: most likely candidate on Greenhouse, Lever and Ashby first, then the second candidate
 * on Greenhouse/Ashby. Personio, Pinpoint and Gem are never probed.
 */
export function probePlan(cands: string[]): { ats: DiscoverableAts; slug: string }[] {
    const plan: { ats: DiscoverableAts; slug: string }[] = [];
    if (cands[0]) for (const ats of DISCOVERABLE_ATS) plan.push({ ats, slug: cands[0] });
    for (const c of cands.slice(1)) for (const ats of ['greenhouse', 'ashby'] as const) plan.push({ ats, slug: c });
    return plan.slice(0, MAX_PROBES_PER_COMPANY);
}

export function seedLookup(input: string): SeedBoard[] {
    const dom = domainOf(input);
    const site = dom ? registrableDomain(dom) : null;
    const n = normText(input);
    return SEED_BOARDS.filter(
        (s) =>
            (site && s.domain === site) ||
            normText(s.company) === n ||
            s.slug.toLowerCase() === input.trim().toLowerCase(),
    );
}

export interface DiscoveryOutcome {
    boards: FoundBoard[];
    company: string | null;
    domain: string | null;
    pagesFetched: string[];
    probes: number;
    notes: { code: string; message: string; host?: string }[];
}

/** Careers page first (robots-respecting, ≤3 pages), then ≤6 slug probes against the documented APIs. */
export async function discoverCompany(
    input: string,
    client: AtsClient,
    careers: CareersFetcher,
    opts: { shouldStop?: () => boolean } = {},
): Promise<DiscoveryOutcome> {
    const out: DiscoveryOutcome = {
        boards: [],
        company: null,
        domain: domainOf(input),
        pagesFetched: [],
        probes: 0,
        notes: [],
    };
    const add = (b: { ats: Ats; slug: string }, via: FoundBoard['via'], confidence: FoundBoard['confidence']) => {
        // Named feeds are user-supplied only. A careers-page link is not a named account.
        if (b.ats === 'personio' || b.ats === 'pinpoint' || b.ats === 'gem') return;
        if (!out.boards.some((x) => x.ats === b.ats && x.slug.toLowerCase() === b.slug.toLowerCase())) {
            out.boards.push({ ...b, via, confidence });
        }
    };

    if (unsupportedAts(input)) return out; // never contact excluded hiring systems, not even their websites
    if (out.domain) {
        const site = registrableDomain(out.domain);
        const queue: string[] = [];
        const given = /^[a-z]+:\/\//i.test(input.trim()) ? new URL(input.trim()) : null;
        if (given && given.pathname.length > 1) queue.push(given.toString());
        queue.push(`https://${out.domain}/`);
        const fallbacks = [`https://${out.domain}/careers`, `https://${out.domain}/jobs`];
        const seen = new Set<string>();
        while (queue.length && out.pagesFetched.length < MAX_CAREERS_PAGES_PER_DOMAIN && !opts.shouldStop?.()) {
            const url = queue.shift()!;
            if (seen.has(url) || seen.has(url.replace(/\/$/, ''))) continue;
            seen.add(url);
            try {
                const page = await careers.getPage(url);
                if (!out.pagesFetched.includes(page.url)) out.pagesFetched.push(page.url);
                seen.add(page.url);
                // Site redirects (vanta.com -> www.vanta.com): build fallbacks on the final origin to avoid a wasted hop.
                const finalOrigin = new URL(page.url).origin;
                if (finalOrigin !== `https://${out.domain}` && registrableDomain(new URL(page.url).hostname) === site)
                    for (let i = 0; i < fallbacks.length; i++)
                        fallbacks[i] = fallbacks[i].replace(`https://${out.domain}`, finalOrigin);
                if (registrableDomain(new URL(page.url).hostname) !== site) {
                    // redirected off-site (e.g. straight to an ATS board): accept only an ATS board URL
                    const b = parseBoardUrl(page.url);
                    if (b) add(b, 'careers_page', 'high');
                    continue;
                }
                if (page.status >= 400) continue;
                const direct = parseBoardUrl(page.url);
                if (direct) add(direct, 'careers_page', 'high');
                for (const b of extractBoardLinks(page.body)) add(b, 'careers_page', 'high');
                if (out.boards.length) break;
                for (const l of findCareersLinks(page.body, page.url)) if (!seen.has(l)) queue.unshift(l);
            } catch (e) {
                const he = e instanceof HttpError ? e : null;
                out.notes.push({
                    code: he?.code ?? 'CAREERS_FETCH_FAILED',
                    message: e instanceof Error ? e.message : String(e),
                    host: new URL(url).hostname,
                });
                if (he && ['HOST_BLOCKED', 'URL_NOT_ALLOWED', 'DNS_FAILED', 'ROBOTS_UNAVAILABLE'].includes(he.code))
                    break;
            }
            if (!queue.length && fallbacks.length) queue.push(fallbacks.shift()!);
        }
    }

    if (!out.boards.length) {
        for (const p of probePlan(slugCandidates(input))) {
            if (opts.shouldStop?.()) break;
            if (client.gate.isKilled(ATS_API_HOSTS[p.ats])) continue;
            try {
                out.probes++;
                const r = await probeBoard(client, p.ats, p.slug);
                if (r.found) {
                    add(p, 'slug_probe', 'medium');
                    out.company ??= r.company;
                    break; // first hit wins: fewer requests, fewer false matches
                }
            } catch (e) {
                const he = e instanceof HttpError ? e : null;
                out.notes.push({
                    code: he?.code ?? 'PROBE_FAILED',
                    message: e instanceof Error ? e.message : String(e),
                    host: he?.host,
                });
            }
        }
    }
    return out;
}
