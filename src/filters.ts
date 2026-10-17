import { daysBetween, normText, wordMatch } from './normalize.js';
import { type ActorInput, type JobRow, LIMITS, type RemoteMode } from './types.js';

export interface Filters {
    titleIncludes: string[];
    titleExcludes: string[];
    titleRegex: RegExp | null;
    locations: string[];
    countries: string[];
    remote: RemoteMode;
    companyFilter: string[];
    departments: string[];
    employmentTypes: string[];
    postedWithinDays: number | null;
    maxAgeDays: number | null;
    includeUnknownPostedDate: boolean;
    hasSalary: boolean;
    excludeStale: boolean;
    onlyNew: boolean;
}

function terms(v: unknown, max: number): string[] {
    if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
    return v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max);
}

function posInt(v: unknown, max: number): number | null {
    let n = NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim()) n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.floor(n), max);
}

/** Rough guard against catastrophic-backtracking patterns, e.g. (a+)+ or (.*)* */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

export function compileFilters(input: ActorInput): { filters: Filters; errors: string[] } {
    const errors: string[] = [];
    let titleRegex: RegExp | null = null;
    if (typeof input.titleRegex === 'string' && input.titleRegex.trim()) {
        const src = input.titleRegex.trim();
        if (src.length > LIMITS.regexLength) errors.push(`titleRegex is longer than ${LIMITS.regexLength} characters.`);
        else if (NESTED_QUANTIFIER.test(src)) errors.push('titleRegex has nested quantifiers like (a+)+; simplify it.');
        else {
            try {
                titleRegex = new RegExp(src, 'i');
            } catch (e) {
                errors.push(
                    `titleRegex is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
    }
    const remote: RemoteMode = input.remote === 'only' || input.remote === 'exclude' ? input.remote : 'any';
    const countries = terms(input.countries, LIMITS.locationTerms).map((c) => c.toUpperCase());
    for (const c of countries)
        if (!/^[A-Z]{2}$/.test(c)) errors.push(`countries: "${c}" is not an ISO-2 code (e.g. US, DE, GB).`);
    return {
        errors,
        filters: {
            titleIncludes: terms(input.titleIncludes, LIMITS.titleTerms),
            titleExcludes: terms(input.titleExcludes, LIMITS.titleTerms),
            titleRegex,
            locations: terms(input.locations, LIMITS.locationTerms).map(normText).filter(Boolean),
            countries,
            remote,
            companyFilter: terms(input.companyFilter, LIMITS.titleTerms).map(normText).filter(Boolean),
            departments: terms(input.departments, LIMITS.titleTerms).map(normText).filter(Boolean),
            employmentTypes: terms(input.employmentTypes, LIMITS.titleTerms).map(normText).filter(Boolean),
            postedWithinDays: posInt(input.postedWithinDays, 3650),
            maxAgeDays: posInt(input.maxAgeDays, 3650),
            includeUnknownPostedDate: input.includeUnknownPostedDate === true,
            hasSalary: input.hasSalary === true,
            excludeStale: input.excludeStale === true,
            onlyNew: input.onlyNew === true,
        },
    };
}

export function hasAnyFilter(f: Filters): boolean {
    return (
        f.titleIncludes.length +
            f.titleExcludes.length +
            f.locations.length +
            f.countries.length +
            f.companyFilter.length +
            f.departments.length +
            f.employmentTypes.length >
            0 ||
        !!f.titleRegex ||
        f.remote !== 'any' ||
        f.postedWithinDays !== null ||
        f.maxAgeDays !== null ||
        f.hasSalary ||
        f.excludeStale ||
        f.onlyNew
    );
}

type Matchable = Pick<
    JobRow,
    | 'title'
    | 'company'
    | 'board'
    | 'locations'
    | 'countries'
    | 'remote'
    | 'department'
    | 'team'
    | 'employment_type'
    | 'compensation'
    | 'posted_at'
    | 'age_days'
    | 'long_open'
    | 'reposted'
    | 'change'
>;

/** All filters are AND-ed; values inside one filter are OR-ed (any-of). */
export function matches(j: Matchable, f: Filters, nowMs: number): boolean {
    const title = j.title.slice(0, 300);
    if (f.titleIncludes.length && !f.titleIncludes.some((t) => wordMatch(title, t))) return false;
    if (f.titleExcludes.some((t) => wordMatch(title, t))) return false;
    if (f.titleRegex && !f.titleRegex.test(title)) return false;
    if (f.companyFilter.length) {
        const c = ` ${normText(j.company)} ${normText(j.board)} `;
        if (!f.companyFilter.some((t) => c.includes(t))) return false;
    }
    if (f.locations.length) {
        const loc = j.locations.map(normText).join(' | ');
        const ok = f.locations.some((t) => loc.includes(t) || (t === 'remote' && j.remote === true));
        if (!ok) return false;
    }
    if (f.countries.length && !j.countries.some((c) => f.countries.includes(c))) return false;
    if (f.remote === 'only' && j.remote !== true) return false;
    if (f.remote === 'exclude' && j.remote === true) return false;
    if (f.departments.length) {
        const d = `${normText(j.department)} | ${normText(j.team)}`;
        if (!f.departments.some((t) => d.includes(t))) return false;
    }
    if (f.employmentTypes.length) {
        const e = normText(j.employment_type);
        if (!f.employmentTypes.some((t) => e.includes(t))) return false;
    }
    if (f.postedWithinDays !== null) {
        if (!j.posted_at) {
            if (!f.includeUnknownPostedDate) return false;
        } else if (daysBetween(j.posted_at, nowMs) > f.postedWithinDays) return false;
    }
    if (f.maxAgeDays !== null && j.age_days !== null && j.age_days > f.maxAgeDays) return false;
    if (f.hasSalary && !(j.compensation && (j.compensation.min || j.compensation.max || j.compensation.summary)))
        return false;
    if (f.excludeStale && (j.long_open || j.reposted)) return false;
    if (f.onlyNew && j.change !== 'new' && j.change !== 'updated') return false;
    return true;
}
