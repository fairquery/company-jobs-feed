import { createHash } from 'node:crypto';

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    hellip: '…',
    bull: '•',
    middot: '·',
    eacute: 'é',
    copy: '©',
    reg: '®',
    trade: '™',
};

/** Display name from a board slug when the ATS gives none: "sentry" -> "Sentry", "scale-ai" -> "Scale Ai". Mixed-case slugs are kept. */
export function prettySlug(slug: string): string {
    if (/[A-Z]/.test(slug)) return slug;
    return slug
        .split(/[-_.]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** HTML (possibly entity-escaped, as Greenhouse sends it) to plain text with paragraph breaks. */
export function htmlToText(html: string | null | undefined): string | null {
    if (!html) return null;
    let s = html;
    if (/&lt;\s*\/?[a-z]/i.test(s) && !/<\s*\/?[a-z]/i.test(s)) s = decodeEntities(s); // double-escaped HTML
    s = s
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '\n• ')
        .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s)
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return s || null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<![\w/])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?![\w/])/g;

/** Removes e-mail addresses and phone numbers (e.g. recruiter contacts) from description text. */
export function scrubPII(text: string): { text: string; redactions: number } {
    let n = 0;
    const out = text
        .replace(EMAIL_RE, () => {
            n++;
            return '[email removed]';
        })
        .replace(PHONE_RE, (m) => {
            if (m.replace(/\D/g, '').length < 9) return m; // years, salary ranges, etc.
            n++;
            return '[phone removed]';
        });
    return { text: out, redactions: n };
}

export function normText(s: string | null | undefined): string {
    return (s ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9+#]+/g, ' ')
        .trim();
}

/** Title normalized for duplicate/repost matching: drops req numbers and bracketed noise. */
export function normTitle(s: string): string {
    return normText(
        s
            .replace(/\((?:[^)]*\d{3,}[^)]*)\)/g, ' ')
            .replace(/\b(req|r|jr|job)\s*[#:]?\s*\d{3,}\b/gi, ' ')
            .replace(/\s[-–|]\s*\d{3,}$/g, ' '),
    );
}

export function sha1(s: string): string {
    return createHash('sha1').update(s).digest('hex');
}

/** fingerprint = sha1(normalized company key + normalized title + normalized primary location). */
export function fingerprint(company: string, title: string, location: string | undefined): string {
    return sha1(`${normText(company)}|${normTitle(title)}|${normText(location ?? '')}`).slice(0, 16);
}

/** Company key for cross-ATS matching: registrable-ish domain if known, else the normalized company name. */
export function companyKey(company: string, domain: string | null | undefined): string {
    if (domain) return domain.toLowerCase().replace(/^www\./, '');
    return normText(company)
        .replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|group|plc|ag|sa|bv)\b/g, '')
        .trim();
}

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed|home[- ]based|telecommut\w*|fully remote)\b/i;
export function textSaysRemote(...parts: (string | null | undefined)[]): boolean {
    return parts.some((p) => !!p && REMOTE_RE.test(p));
}

/** Whole-word, case-insensitive any-of match ("engineer" matches "Software Engineer", not "Engineering"). */
export function wordMatch(haystack: string, term: string): boolean {
    const h = ` ${normText(haystack)} `;
    const t = normText(term);
    if (!t) return false;
    return h.includes(` ${t} `);
}

export function toIso(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function daysBetween(fromIso: string, toMs: number): number {
    return Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 86_400_000));
}

export function compact<T>(arr: (T | null | undefined | '')[]): T[] {
    return arr.filter((x): x is T => x !== null && x !== undefined && x !== '');
}

export function uniq<T>(arr: T[]): T[] {
    return [...new Set(arr)];
}
