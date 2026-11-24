import { CareersFetcher, type HostGate,HttpError } from './http.js';
import { decodeEntities } from './normalize.js';
import { crawlDelayMs, isAllowed, type Robots } from './robots.js';
import {
    type Compensation,
    HOST_MIN_INTERVAL_MS,
    isPersonioTenantHost,
    isValidPersonioAccount,
    PERSONIO_CRAWL_DELAY_CAP_MS,
    ROBOTS_AGENT,
} from './types.js';

/**
 * Personio public positions feed.
 * The only job URL we build is https://{account}.jobs.personio.de/xml
 * (https://developer.personio.de/docs/retrieving-open-job-positions).
 * robots.txt on that same origin is fetched first so a disallow skips the feed.
 * No other path, query, host or method is used. Accounts come from the caller.
 */

const SALARY_CONTAINERS = new Set(['salary', 'salaryinformation', 'salaryinfo', 'salaryrange', 'compensation']);

interface PersonioDescription {
    name: string | null;
    html: string;
}

export interface PersonioPosition {
    id: string;
    subcompany: string | null;
    offices: string[];
    department: string | null;
    recruitingCategory: string | null;
    name: string;
    descriptions: PersonioDescription[];
    employmentType: string | null;
    seniority: string | null;
    schedule: string | null;
    keywords: string | null;
    createdAt: string | null;
    /** Present only when the feed includes a salary/compensation element. The documented element list has seniority, not pay. */
    salaryFields: Record<string, string> | null;
}

export interface PersonioIo {
    robots(url: string): Promise<Robots>;
    get(url: string): Promise<{ status: number; body: string }>;
}

export function personioXmlUrl(account: string): string {
    return personioOriginUrl(account, '/xml');
}

function personioRobotsUrl(account: string): string {
    return personioOriginUrl(account, '/robots.txt');
}

function personioOriginUrl(account: string, path: '/xml' | '/robots.txt'): string {
    if (!isValidPersonioAccount(account)) {
        throw new HttpError(
            `Invalid Personio account "${account}". Pass the company subdomain only (letters, digits, hyphens), e.g. personio:acme.`,
            'INVALID_INPUT',
            false,
        );
    }
    return `https://${account.toLowerCase()}.jobs.personio.de${path}`;
}

/** Refuse anything that is not the documented /xml feed or that host's /robots.txt. */
export function assertPersonioFetchUrl(url: string, path: '/xml' | '/robots.txt'): void {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new HttpError(`Refusing Personio URL ${url}`, 'URL_NOT_ALLOWED', false);
    }
    const got = u.pathname.replace(/\/+$/, '') || '/';
    if (
        u.protocol !== 'https:' ||
        u.port ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !isPersonioTenantHost(u.hostname) ||
        got !== path
    ) {
        throw new HttpError(
            `Refusing ${url}. Personio reads are only https://{account}.jobs.personio.de/xml and that host's robots.txt.`,
            'URL_NOT_ALLOWED',
            false,
        );
    }
}

const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });

/**
 * Fetch one named account's feed: robots.txt, then /xml if allowed.
 * `io.get` is not called when robots.txt disallows /xml or cannot be read.
 */
export async function loadPersonioXml(
    account: string,
    io: PersonioIo,
    sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<{ status: number; body: string; url: string; requests: number }> {
    const url = personioXmlUrl(account);
    const robotsUrl = personioRobotsUrl(account);
    assertPersonioFetchUrl(robotsUrl, '/robots.txt');
    assertPersonioFetchUrl(url, '/xml');
    const robots = await io.robots(robotsUrl);
    const host = new URL(url).hostname;
    if (!isAllowed(robots, ROBOTS_AGENT, '/xml')) {
        throw new HttpError(`robots.txt on ${host} disallows /xml`, 'ROBOTS_DISALLOWED', false, undefined, host);
    }
    const delay = Math.min(PERSONIO_CRAWL_DELAY_CAP_MS, crawlDelayMs(robots, ROBOTS_AGENT));
    const gap = HOST_MIN_INTERVAL_MS['jobs.personio.de'] ?? 1500;
    if (delay > gap) await sleepFn(delay - gap);
    const res = await io.get(url);
    return { status: res.status, body: res.body, url, requests: 2 };
}

/** Production transport. GET only, DNS-pinned, robots-checked, /xml and /robots.txt only. */
export function personioClient(gate: HostGate): PersonioIo {
    const careers = new CareersFetcher(gate);
    return {
        robots: async (url: string) => {
            assertPersonioFetchUrl(url, '/robots.txt');
            return careers.robotsDocument(new URL(url));
        },
        get: async (url: string) => {
            assertPersonioFetchUrl(url, '/xml');
            const res = await careers.getExact(url);
            return { status: res.status, body: res.body };
        },
    };
}

interface XEl {
    name: string;
    attrs: Record<string, string>;
    children: XEl[];
    text: string;
}

function localName(tag: string): string {
    const raw = tag.replace(/\/$/, '').trim().split(/\s+/)[0] ?? '';
    const name = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
    return name.toLowerCase();
}

function attrsOf(rawTag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of rawTag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        out[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? '');
    }
    return out;
}

function readContent(
    s: string,
    start: number,
    endName: string | null,
): { children: XEl[]; text: string; i: number } {
    const children: XEl[] = [];
    let text = '';
    let i = start;
    while (i < s.length) {
        const lt = s.indexOf('<', i);
        if (lt < 0) {
            text += s.slice(i);
            return { children, text: text.trim(), i: s.length };
        }
        text += s.slice(i, lt);
        if (s.startsWith('<![CDATA[', lt)) {
            const end = s.indexOf(']]>', lt + 9);
            if (end < 0) throw new Error('unterminated CDATA');
            text += s.slice(lt + 9, end);
            i = end + 3;
            continue;
        }
        if (s.startsWith('</', lt)) {
            const gt = s.indexOf('>', lt);
            if (gt < 0) throw new Error('unterminated end tag');
            const name = localName(s.slice(lt + 2, gt));
            if (endName && name !== endName) throw new Error(`expected </${endName}>`);
            return { children, text: text.trim(), i: gt + 1 };
        }
        const gt = s.indexOf('>', lt);
        if (gt < 0) throw new Error('unterminated tag');
        const raw = s.slice(lt + 1, gt).trim();
        if (!raw || raw.startsWith('!') || raw.startsWith('?')) {
            i = gt + 1;
            continue;
        }
        const name = localName(raw);
        if (raw.endsWith('/')) {
            children.push({ name, attrs: attrsOf(raw), children: [], text: '' });
            i = gt + 1;
            continue;
        }
        const inner = readContent(s, gt + 1, name);
        children.push({ name, attrs: attrsOf(raw), children: inner.children, text: inner.text });
        i = inner.i;
    }
    if (endName) throw new Error(`unclosed <${endName}>`);
    return { children, text: text.trim(), i };
}

function elementText(el: XEl | undefined): string {
    if (!el) return '';
    const own = decodeEntities(el.text).replace(/\s+/g, ' ').trim();
    if (own) return own;
    const named = el.children.find((c) => c.name === 'name');
    return named ? decodeEntities(named.text).replace(/\s+/g, ' ').trim() : '';
}

function child(el: XEl, name: string): XEl | undefined {
    return el.children.find((c) => c.name === name);
}

function childText(el: XEl, name: string): string | null {
    const t = elementText(child(el, name));
    return t || null;
}

/** Parse the documented positions XML. Refuses DOCTYPE / ENTITY so custom entities are never expanded. */
export function parsePersonioXml(xml: string): PersonioPosition[] {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw new Error('Personio XML with a DOCTYPE or entity declaration is refused');
    }
    const s = xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
    const root = readContent(s, 0, null);
    const feed = root.children.find((c) => c.name === 'workzag-jobs') ?? null;
    if (!feed) return [];
    const out: PersonioPosition[] = [];
    for (const pos of feed.children) {
        if (pos.name !== 'position') continue;
        const id = childText(pos, 'id');
        if (!id) continue;
        const offices = [
            childText(pos, 'office'),
            ...(child(pos, 'additionaloffices')?.children ?? [])
                .filter((c) => c.name === 'office')
                .map((c) => elementText(c)),
        ].filter((x): x is string => !!x);
        const descriptions: PersonioDescription[] = [];
        for (const block of child(pos, 'jobdescriptions')?.children ?? []) {
            if (block.name !== 'jobdescription') continue;
            const html = child(block, 'value')?.text ?? '';
            const name = childText(block, 'name');
            if (html || name) descriptions.push({ name, html });
        }
        out.push({
            id,
            subcompany: childText(pos, 'subcompany'),
            offices,
            department: childText(pos, 'department'),
            recruitingCategory: childText(pos, 'recruitingcategory'),
            name: childText(pos, 'name') ?? '',
            descriptions,
            employmentType: childText(pos, 'employmenttype'),
            seniority: childText(pos, 'seniority'),
            schedule: childText(pos, 'schedule'),
            keywords: childText(pos, 'keywords'),
            createdAt: childText(pos, 'createdat'),
            salaryFields: salaryFields(pos),
        });
    }
    return out;
}

function salaryFields(pos: XEl): Record<string, string> | null {
    const fields: Record<string, string> = {};
    const take = (src: Record<string, string>) => {
        for (const [k, v] of Object.entries(src)) if (v.trim()) fields[k] = v.trim();
    };
    for (const el of pos.children) {
        if (!SALARY_CONTAINERS.has(el.name)) continue;
        take(el.attrs);
        const own = elementText(el);
        if (own && !el.children.length) fields.summary = fields.summary ?? own;
        else if (own) fields.summary = fields.summary ?? own;
        for (const c of el.children) {
            const t = elementText(c);
            if (t) fields[c.name] = t;
        }
    }
    for (const key of ['salarymin', 'minsalary', 'salarymax', 'maxsalary', 'salarycurrency'] as const) {
        const t = childText(pos, key);
        if (t) fields[key] = t;
    }
    return Object.keys(fields).length ? fields : null;
}

function parseAmount(raw: string | null): number | null {
    if (!raw) return null;
    let t = raw.trim().replace(/\s/g, '');
    if (!t) return null;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else t = t.replace(/[^0-9.-]/g, '');
    if (!t || t === '-' || t === '.') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function currencyOf(text: string): string | null {
    const iso = /\b(EUR|USD|GBP|CHF|CAD|AUD|SEK|NOK|DKK|PLN|JPY)\b/i.exec(text);
    if (iso) return iso[1].toUpperCase();
    if (text.includes('€')) return 'EUR';
    if (text.includes('£')) return 'GBP';
    if (text.includes('$')) return 'USD';
    return null;
}

function intervalOf(text: string): string | null {
    const t = text.toLowerCase();
    if (/hour|stunde/.test(t)) return 'hour';
    if (/week|woche/.test(t)) return 'week';
    if (/month|monat/.test(t)) return 'month';
    if (/\bday\b|pro tag/.test(t)) return 'day';
    if (/year|annual|annum|jähr|jahr|p\.a/.test(t)) return 'year';
    return null;
}

function amountsIn(text: string): number[] {
    const out: number[] = [];
    const re =
        /(?:EUR|USD|GBP|CHF|€|£|\$)?\s*(\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,7}(?:[.,]\d+)?)/gi;
    for (const m of text.matchAll(re)) {
        const n = parseAmount(m[1]);
        if (n == null || n < 100) continue;
        const bareYear = n >= 1900 && n <= 2100 && String(Math.trunc(n)).length === 4 && !/[€£$]|[A-Z]{3}/i.test(m[0]);
        if (bareYear) continue;
        out.push(n);
        if (out.length === 2) break;
    }
    return out;
}

function pick(fields: Record<string, string>, names: string[]): string | null {
    for (const n of names) {
        const v = fields[n];
        if (v && v.trim()) return v.trim();
    }
    return null;
}

/** Map a salary/compensation element onto the shared compensation object. Null when the feed has none. */
export function compensationFromSalary(fields: Record<string, string> | null): Compensation | null {
    if (!fields) return null;
    let summary = pick(fields, ['summary', 'text', 'description']);
    let min = parseAmount(pick(fields, ['min', 'minimum', 'salarymin', 'minsalary', 'from']));
    let max = parseAmount(pick(fields, ['max', 'maximum', 'salarymax', 'maxsalary', 'to']));
    const amount = parseAmount(pick(fields, ['value', 'amount']));
    if (min == null && max == null && amount != null) {
        min = amount;
        max = amount;
    }
    const blob = Object.values(fields).filter(Boolean).join(' ');
    let currency = pick(fields, ['currency', 'currencycode', 'salarycurrency']);
    if (currency) {
        const iso = currencyOf(currency);
        currency = iso ?? (/^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null);
    }
    if (!currency) currency = currencyOf(blob);
    const intervalRaw = pick(fields, ['interval', 'period', 'frequency', 'unit']);
    const interval = intervalRaw ? (intervalOf(intervalRaw) ?? intervalRaw.slice(0, 40)) : intervalOf(blob);
    if (summary) {
        const nums = amountsIn(summary);
        if (min == null && nums[0] != null) min = nums[0];
        if (max == null && nums[1] != null) max = nums[1];
    }
    if (min != null && max != null && min > max) [min, max] = [max, min];
    if (!summary && (min != null || max != null)) {
        const range = min != null && max != null && min !== max ? `${min}–${max}` : `${min ?? max}`;
        summary = [range, currency, interval ? `/ ${interval}` : null].filter(Boolean).join(' ');
    }
    if (min == null && max == null && !summary) return null;
    return { summary, min, max, currency, interval };
}
