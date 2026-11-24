import { daysBetween, normText, wordMatch } from './normalize.js';
import { type ActorInput, type JobRow, LIMITS, type RemoteMode } from './types.js';

export interface Filters {
    titleIncludes: string[];
    titleExcludes: string[];
    descriptionIncludes: string[];
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
            descriptionIncludes: terms(input.descriptionIncludes, LIMITS.titleTerms),
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
> & { description_text?: string | null };

/**
 * USPS code and full name. Codes are matched as whole tokens, never as substrings,
 * so "or" cannot hit "york", "florida" or "portland", and "in" cannot hit "berlin".
 */
export const US_STATE_LOCATION_NAMES: readonly (readonly [string, string])[] = [
    ['al', 'alabama'],
    ['ak', 'alaska'],
    ['az', 'arizona'],
    ['ar', 'arkansas'],
    ['ca', 'california'],
    ['co', 'colorado'],
    ['ct', 'connecticut'],
    ['de', 'delaware'],
    ['dc', 'district of columbia'],
    ['fl', 'florida'],
    ['ga', 'georgia'],
    ['hi', 'hawaii'],
    ['id', 'idaho'],
    ['il', 'illinois'],
    ['in', 'indiana'],
    ['ia', 'iowa'],
    ['ks', 'kansas'],
    ['ky', 'kentucky'],
    ['la', 'louisiana'],
    ['me', 'maine'],
    ['md', 'maryland'],
    ['ma', 'massachusetts'],
    ['mi', 'michigan'],
    ['mn', 'minnesota'],
    ['ms', 'mississippi'],
    ['mo', 'missouri'],
    ['mt', 'montana'],
    ['ne', 'nebraska'],
    ['nv', 'nevada'],
    ['nh', 'new hampshire'],
    ['nj', 'new jersey'],
    ['nm', 'new mexico'],
    ['ny', 'new york'],
    ['nc', 'north carolina'],
    ['nd', 'north dakota'],
    ['oh', 'ohio'],
    ['ok', 'oklahoma'],
    ['or', 'oregon'],
    ['pa', 'pennsylvania'],
    ['ri', 'rhode island'],
    ['sc', 'south carolina'],
    ['sd', 'south dakota'],
    ['tn', 'tennessee'],
    ['tx', 'texas'],
    ['ut', 'utah'],
    ['vt', 'vermont'],
    ['va', 'virginia'],
    ['wa', 'washington'],
    ['wv', 'west virginia'],
    ['wi', 'wisconsin'],
    ['wy', 'wyoming'],
];

/**
 * City names that match only themselves. They are not expanded to a state code
 * (Portland does not become Oregon / "or").
 */
export const LOCATION_METRO_NAMES = [
    'chicago',
    'boston',
    'seattle',
    'austin',
    'denver',
    'miami',
    'atlanta',
    'dallas',
    'houston',
    'phoenix',
    'portland',
    'detroit',
    'minneapolis',
] as const;

interface AliasGroup {
    keys: readonly string[];
    phrases: readonly string[];
    tokens: readonly string[];
}

function stateGroup(code: string, name: string): AliasGroup {
    return { keys: [code, name], phrases: [name], tokens: [code] };
}

/** Synonym groups. A term hits every group that lists it as an exact key; groups are not chained through tokens. */
const LOCATION_ALIAS_GROUPS: readonly AliasGroup[] = [
    ...US_STATE_LOCATION_NAMES.map(([code, name]) => stateGroup(code, name)),
    {
        keys: ['nyc', 'new york city', 'new york', 'ny'],
        phrases: ['new york', 'new york city', 'nyc'],
        tokens: ['ny'],
    },
    {
        keys: ['sf', 'bay area', 'san fran', 'san francisco'],
        phrases: ['san francisco', 'bay area', 'san fran'],
        tokens: ['sf'],
    },
    // "LA" is both Los Angeles and Louisiana. The code is a token, so it does not match Dallas or Lagos.
    { keys: ['la', 'los angeles'], phrases: ['los angeles'], tokens: ['la'] },
    {
        keys: ['dc', 'd c', 'washington dc', 'district of columbia'],
        phrases: ['washington', 'washington dc', 'district of columbia', 'd c'],
        tokens: ['dc'],
    },
    { keys: ['philly', 'philadelphia'], phrases: ['philadelphia', 'philly'], tokens: [] },
    { keys: ['tampa', 'tampa bay'], phrases: ['tampa', 'tampa bay'], tokens: [] },
    // Baltimore / BWI match each other. They do not expand to every Maryland posting.
    // "MD" and "Maryland" already match "Baltimore, MD" through the state group.
    {
        keys: ['baltimore', 'baltimore md', 'bwi', 'bwi area'],
        phrases: ['baltimore', 'bwi'],
        tokens: [],
    },
];

const GROUPS_BY_KEY = new Map<string, AliasGroup[]>();
for (const group of LOCATION_ALIAS_GROUPS) {
    for (const key of group.keys) {
        const list = GROUPS_BY_KEY.get(key);
        if (list) list.push(group);
        else GROUPS_BY_KEY.set(key, [group]);
    }
}

export interface LocationTermAliases {
    /** Substring phrases. Never a 2-letter code, and never the bare string "or". */
    phrases: string[];
    /** USPS / metro codes matched as whole tokens (space-bounded), not substrings. */
    tokens: string[];
}

/** Expand one location term (any case). `normText` is applied here. */
export function expandLocationTerm(term: string): LocationTermAliases {
    const normalized = normText(term);
    const phrases = new Set<string>();
    const tokens = new Set<string>();
    if (!normalized) return { phrases: [], tokens: [] };
    if (normalized.length <= 2 && !normalized.includes(' ')) tokens.add(normalized);
    else phrases.add(normalized);
    for (const group of GROUPS_BY_KEY.get(normalized) ?? []) {
        for (const phrase of group.phrases) if (phrase.length > 2 || phrase.includes(' ')) phrases.add(phrase);
        for (const token of group.tokens) if (token.length === 2 && !token.includes(' ')) tokens.add(token);
    }
    phrases.delete('or');
    return { phrases: [...phrases], tokens: [...tokens] };
}

/** Word-bounded phrase, optionally skipping one bad prefix ("west virginia", "baja california", "arkansas"). */
function boundedPhrase(loc: string, phrase: string, badPrefix?: string): boolean {
    let from = 0;
    while (from < loc.length) {
        const i = loc.indexOf(phrase, from);
        if (i < 0) return false;
        const end = i + phrase.length;
        const startOk = i === 0 || loc[i - 1] === ' ';
        const endOk = end === loc.length || loc[end] === ' ';
        if (startOk && endOk) {
            if (!badPrefix) return true;
            const before = loc.slice(Math.max(0, i - badPrefix.length), i);
            if (before !== badPrefix) return true;
        }
        from = i + 1;
    }
    return false;
}

function phraseHits(loc: string, phrase: string): boolean {
    if (!phrase) return false;
    if (phrase === 'kansas') return boundedPhrase(loc, phrase);
    if (phrase === 'virginia') return boundedPhrase(loc, phrase, 'west ');
    if (phrase === 'california') return boundedPhrase(loc, phrase, 'baja ');
    return loc.includes(phrase);
}

function locationTermMatches(loc: string, term: string, remote: boolean): boolean {
    if (term === 'remote' && remote) return true;
    const { phrases, tokens } = expandLocationTerm(term);
    if (tokens.length) {
        const padded = ` ${loc} `;
        if (tokens.some((token) => padded.includes(` ${token} `))) return true;
    }
    return phrases.some((phrase) => phraseHits(loc, phrase));
}

/** All filters are AND-ed; values inside one filter are OR-ed (any-of). */
export function matches(j: Matchable, f: Filters, nowMs: number): boolean {
    const title = j.title.slice(0, 300);
    if (f.titleIncludes.length && !f.titleIncludes.some((t) => wordMatch(title, t))) return false;
    if (f.titleExcludes.some((t) => wordMatch(title, t))) return false;
    if (f.titleRegex && !f.titleRegex.test(title)) return false;
    if (f.descriptionIncludes.length) {
        // Title or scrubbed body, so a skill named only in the posting still matches.
        const hay = `${title}\n${j.description_text ?? ''}`;
        if (!f.descriptionIncludes.some((t) => wordMatch(hay, t))) return false;
    }
    if (f.companyFilter.length) {
        const c = ` ${normText(j.company)} ${normText(j.board)} `;
        if (!f.companyFilter.some((t) => c.includes(t))) return false;
    }
    if (f.locations.length) {
        const loc = j.locations.map(normText).join(' | ');
        const ok = f.locations.some((t) => locationTermMatches(loc, t, j.remote === true));
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

export const STARTER_LIST_COVERAGE_NOTE =
    'The starter list is not every employer. This scan covers public Greenhouse, Lever and Ashby boards only. Personio, Pinpoint and Gem are named accounts and are not in the starter list. Workday, LinkedIn, SmartRecruiters, Recruitee, Rippling, iCIMS, Taleo and SuccessFactors are not covered.';

/**
 * Extra place names counted only when a search returns no jobs.
 * They do not widen which jobs match.
 */
const NEARBY_PLACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
    baltimore: ['maryland', 'md'],
    'baltimore md': ['maryland', 'md'],
    bwi: ['baltimore', 'maryland', 'md'],
    'bwi area': ['baltimore', 'maryland', 'md'],
};

const SAMPLE_OPEN_TITLES = 8;

export interface EmptySearchSuggestions {
    note: string;
    title_tokens_tried: string[];
    description_tokens_tried: string[];
    place_aliases_with_hits: { alias: string; jobs: number }[];
    sample_open_titles: string[];
}

export interface SuggestionTally {
    aliases: string[];
    counts: number[];
    titles: string[];
    seen: Set<string>;
}

/** Running counts so a place scan can suggest without retaining every open job. */
export function suggestionTally(filters: Filters): SuggestionTally {
    const aliases = new Set<string>();
    for (const term of filters.locations) {
        const expanded = expandLocationTerm(term);
        for (const phrase of expanded.phrases) aliases.add(phrase);
        for (const token of expanded.tokens) aliases.add(token);
        for (const near of NEARBY_PLACE_ALIASES[normText(term)] ?? []) aliases.add(near);
    }
    const list = [...aliases];
    return { aliases: list, counts: list.map(() => 0), titles: [], seen: new Set() };
}

export function noteSuggestion(tally: SuggestionTally, job: Matchable, filters: Filters, nowMs: number): void {
    const relaxed: Filters = { ...filters, titleIncludes: [], titleRegex: null, descriptionIncludes: [] };
    if (matches(job, relaxed, nowMs)) {
        const title = job.title.trim();
        const key = title.toLowerCase();
        if (title && !tally.seen.has(key) && tally.titles.length < SAMPLE_OPEN_TITLES) {
            tally.seen.add(key);
            tally.titles.push(title);
        }
    }
    const loc = job.locations.map(normText).join(' | ');
    const remote = job.remote === true;
    for (let i = 0; i < tally.aliases.length; i++) {
        if (locationTermMatches(loc, tally.aliases[i] ?? '', remote)) tally.counts.splice(i, 1, (tally.counts[i] ?? 0) + 1);
    }
}

export function suggestionsFromTally(tally: SuggestionTally, filters: Filters): EmptySearchSuggestions {
    const hits: { alias: string; jobs: number }[] = [];
    for (let i = 0; i < tally.aliases.length; i++) {
        const jobs = tally.counts[i] ?? 0;
        const alias = tally.aliases[i];
        if (jobs > 0 && alias) hits.push({ alias, jobs });
    }
    hits.sort((a, b) => b.jobs - a.jobs || a.alias.localeCompare(b.alias));
    return {
        note: STARTER_LIST_COVERAGE_NOTE,
        title_tokens_tried: [...filters.titleIncludes],
        description_tokens_tried: [...filters.descriptionIncludes],
        place_aliases_with_hits: hits.slice(0, 12),
        sample_open_titles: [...tally.titles],
    };
}

/** Structured hints after a successful scan matched nothing. Counts only jobs passed in. */
export function emptySearchSuggestions(jobs: Matchable[], filters: Filters, nowMs: number): EmptySearchSuggestions {
    const tally = suggestionTally(filters);
    for (const job of jobs) noteSuggestion(tally, job, filters, nowMs);
    return suggestionsFromTally(tally, filters);
}
