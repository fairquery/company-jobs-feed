import { countriesFromText, countryToIso2 } from './gazetteer.js';
import { gemClient, type GemIo, gemJobPostsUrl, type GemPost,gemPublicJobUrl, loadGemJobPosts, parseGemJobPosts } from './gem.js';
import { type AtsClient, HttpError } from './http.js';
import { compact, decodeEntities, htmlToText, prettySlug, textSaysRemote, toIso, uniq } from './normalize.js';
import {
    compensationFromSalary,
    loadPersonioXml,
    parsePersonioXml,
    personioClient,
    type PersonioIo,
    type PersonioPosition,
    personioXmlUrl,
} from './personio.js';
import {
    compensationFromPinpoint,
    loadPinpointPostings,
    parsePinpointPostings,
    pinpointClient,
    type PinpointIo,
    pinpointListingUrl,
    type PinpointPosting,
    pinpointPostingsUrl,
} from './pinpoint.js';
import {
    type Ats,
    ATS_API_HOSTS,
    type Compensation,
    type DiscoverableAts,
    isValidGemVanity,
    isValidPersonioAccount,
    isValidPinpointSubdomain,
    MAX_DESCRIPTION_CHARS,
    type NormalizedJob,
} from './types.js';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidSlug(s: string): boolean {
    return SLUG_RE.test(s) && !s.includes('..');
}

const enc = encodeURIComponent;
const base = (ats: DiscoverableAts) => `https://${ATS_API_HOSTS[ats]}`;

export function listUrl(
    ats: Ats,
    slug: string,
    opts: { offset?: number; limit?: number; lite?: boolean } = {},
): string {
    switch (ats) {
        case 'greenhouse':
            return `${base(ats)}/v1/boards/${enc(slug)}/jobs${opts.lite ? '' : '?content=true'}`;
        case 'lever':
            return `${base(ats)}/v0/postings/${enc(slug)}?mode=json${opts.limit ? `&limit=${opts.limit}` : ''}`;
        case 'ashby':
            return `${base(ats)}/posting-api/job-board/${enc(slug)}?includeCompensation=true`;
        case 'personio':
            return personioXmlUrl(slug);
        case 'pinpoint':
            return pinpointPostingsUrl(slug);
        case 'gem':
            return gemJobPostsUrl(slug);
        default:
            throw new Error(`unknown ATS ${String(ats)}`);
    }
}

/**
 * Documented per-job endpoint used by confirmOpen:"detail".
 * Ashby, Personio, Pinpoint and Gem have none. Those rows are not re-fetched from any other path.
 * Gem's per-id job_posts URL and POST /applications are never called.
 */
export function detailUrl(ats: Ats, slug: string, id: string): string | null {
    switch (ats) {
        case 'greenhouse':
            return `${base(ats)}/v1/boards/${enc(slug)}/jobs/${enc(id)}`;
        case 'lever':
            return `${base(ats)}/v0/postings/${enc(slug)}/${enc(id)}?mode=json`;
        default:
            return null;
    }
}

export interface BoardFetch {
    company: string | null;
    jobs: NormalizedJob[];
    total: number;
    complete: boolean;
    sourceUrl: string;
    requests: number;
    notFound: boolean;
    /** Set when the board had to be read in a reduced form (e.g. Greenhouse list without content). */
    note?: string;
}

export interface FetchOpts {
    maxJobs: number;
    withDescription: boolean;
    companyHint?: string;
    shouldStop?: () => boolean;
    /** Test hook. Production uses the robots-checked Personio client on `client.gate`. */
    personioIo?: PersonioIo;
    personioSleep?: (ms: number) => Promise<void>;
    /** Test hook. Production uses the robots-checked Pinpoint client on `client.gate`. */
    pinpointIo?: PinpointIo;
    pinpointSleep?: (ms: number) => Promise<void>;
    /** Test hook. Production uses the Gem job_posts client on `client.gate` (no API key). */
    gemIo?: GemIo;
}

function clip(s: string | null): string | null {
    if (!s) return null;
    return s.length > MAX_DESCRIPTION_CHARS ? `${s.slice(0, MAX_DESCRIPTION_CHARS)}…` : s;
}

function str(v: unknown): string | null {
    if (typeof v === 'string') {
        const t = v.trim();
        return t || null;
    }
    if (typeof v === 'number') return String(v);
    return null;
}

/** Title, department, and location text. HTML entities become the characters users and keyword match see. */
function display(v: unknown): string | null {
    const s = str(v);
    if (!s) return null;
    const decoded = decodeEntities(s).trim();
    return decoded || null;
}

function displayTitle(v: string | null | undefined): string {
    return decodeEntities(v ?? '').trim();
}

function splitLocations(s: string | null): string[] {
    if (!s) return [];
    return uniq(
        s
            .split(/\s*;\s*|\s+\|\s+|\s+or\s+/i)
            .map((x) => x.trim())
            .filter(Boolean),
    );
}

function remoteFromText(locations: string[], title: string): { remote: boolean | null; basis: 'text' | null } {
    if (!locations.length && !title) return { remote: null, basis: null };
    return { remote: textSaysRemote(...locations, title), basis: 'text' };
}

function withCountries(job: Omit<NormalizedJob, 'countries' | 'country_basis'>, ats: string[]): NormalizedJob {
    const atsCodes = uniq(compact(ats.map((c) => countryToIso2(c))));
    if (atsCodes.length) return { ...job, countries: atsCodes, country_basis: 'ats' };
    const txt = countriesFromText(job.locations);
    return { ...job, countries: txt, country_basis: txt.length ? 'text' : null };
}

function workplace(wt: string, remoteFallback: boolean | null): NormalizedJob['workplace_type'] {
    if (wt === 'remote' || wt === 'hybrid' || wt === 'onsite') return wt;
    return remoteFallback ? 'remote' : null;
}

// ---------------- Greenhouse ----------------
interface GhJob {
    id: number | string;
    title: string;
    absolute_url?: string;
    location?: { name?: string };
    updated_at?: string;
    first_published?: string;
    company_name?: string;
    content?: string;
    departments?: { name?: string }[];
    offices?: { name?: string; location?: string | null }[];
    metadata?: { name?: string; value?: unknown }[] | null;
}

export function mapGreenhouse(slug: string, j: GhJob, company: string, withDescription: boolean): NormalizedJob {
    const locations = splitLocations(display(j.location?.name));
    const title = displayTitle(j.title);
    const r = remoteFromText(locations, title);
    const meta = Array.isArray(j.metadata) ? j.metadata : [];
    const empType = meta.find((m) => /employment|job type|work type/i.test(m.name ?? ''));
    return withCountries(
        {
            ats: 'greenhouse',
            board: slug,
            company: str(j.company_name) ?? company,
            job_id: String(j.id),
            title,
            department: display(j.departments?.[0]?.name),
            team: display(j.departments?.[1]?.name),
            locations,
            remote: r.remote,
            remote_basis: r.basis,
            workplace_type: r.remote ? 'remote' : null,
            employment_type: empType ? str(empType.value) : null,
            compensation: null,
            posted_at: toIso(j.first_published),
            ats_updated_at: toIso(j.updated_at),
            apply_url: str(j.absolute_url),
            job_url: str(j.absolute_url),
            description_text: withDescription ? clip(htmlToText(j.content)) : null,
            detail_url: detailUrl('greenhouse', slug, String(j.id)),
        },
        [],
    );
}

// ---------------- Lever ----------------
interface LeverJob {
    id: string;
    text: string;
    hostedUrl?: string;
    applyUrl?: string;
    createdAt?: number;
    updatedAt?: number;
    country?: string | null;
    workplaceType?: string;
    categories?: {
        commitment?: string;
        department?: string;
        location?: string;
        team?: string;
        allLocations?: string[];
    };
    descriptionPlain?: string;
    lists?: { text?: string; content?: string }[];
    additionalPlain?: string;
    salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null;
    salaryDescriptionPlain?: string;
}

export function mapLever(slug: string, j: LeverJob, company: string, withDescription: boolean): NormalizedJob {
    const c = j.categories ?? {};
    const locations = uniq(compact([...(c.allLocations ?? []), c.location ?? null].map((loc) => display(loc))));
    const title = displayTitle(j.text);
    const wt = (j.workplaceType ?? '').toLowerCase();
    let remote: boolean | null;
    let basis: 'ats' | 'text' | null;
    if (wt === 'remote' || wt === 'onsite' || wt === 'hybrid') {
        remote = wt === 'remote';
        basis = 'ats';
    } else ({ remote, basis } = remoteFromText(locations, title));
    const sr = j.salaryRange;
    const compensation: Compensation | null =
        sr && (sr.min || sr.max)
            ? {
                  summary: str(j.salaryDescriptionPlain),
                  min: sr.min ?? null,
                  max: sr.max ?? null,
                  currency: sr.currency ?? null,
                  interval: sr.interval ?? null,
              }
            : null;
    let description: string | null = null;
    if (withDescription) {
        const parts = [decodeEntities(j.descriptionPlain ?? '')];
        for (const l of j.lists ?? []) parts.push(`${decodeEntities(l.text ?? '')}\n${htmlToText(l.content) ?? ''}`);
        parts.push(decodeEntities(j.additionalPlain ?? ''));
        description = clip(
            parts
                .map((p) => p.trim())
                .filter(Boolean)
                .join('\n\n') || null,
        );
    }
    return withCountries(
        {
            ats: 'lever',
            board: slug,
            company,
            job_id: j.id,
            title,
            department: display(c.department),
            team: display(c.team),
            locations,
            remote,
            remote_basis: basis,
            workplace_type: workplace(wt, remote),
            employment_type: str(c.commitment),
            compensation,
            posted_at: toIso(j.createdAt),
            ats_updated_at: toIso(j.updatedAt),
            apply_url: str(j.applyUrl) ?? str(j.hostedUrl),
            job_url: str(j.hostedUrl),
            description_text: description,
            detail_url: detailUrl('lever', slug, j.id),
        },
        compact([j.country ?? null]),
    );
}

// ---------------- Ashby ----------------
interface AshbyAddress {
    postalAddress?: { addressCountry?: string; addressLocality?: string; addressRegion?: string };
}
interface AshbyJob {
    id: string;
    title: string;
    department?: string;
    team?: string;
    employmentType?: string;
    location?: string;
    secondaryLocations?: { location?: string; address?: AshbyAddress | AshbyAddress['postalAddress'] }[];
    publishedAt?: string;
    isListed?: boolean;
    isRemote?: boolean | null;
    workplaceType?: string | null;
    address?: AshbyAddress;
    jobUrl?: string;
    applyUrl?: string;
    descriptionPlain?: string;
    compensation?: {
        compensationTierSummary?: string | null;
        scrapeableCompensationSalarySummary?: string | null;
        summaryComponents?: {
            compensationType?: string;
            interval?: string;
            currencyCode?: string | null;
            minValue?: number | null;
            maxValue?: number | null;
        }[];
    };
}

const EMPLOYMENT: Record<string, string> = {
    FullTime: 'Full-time',
    PartTime: 'Part-time',
    Intern: 'Internship',
    Contract: 'Contract',
    Temporary: 'Temporary',
};

export function mapAshby(slug: string, j: AshbyJob, company: string, withDescription: boolean): NormalizedJob {
    const locations = uniq(compact([display(j.location), ...(j.secondaryLocations ?? []).map((s) => display(s.location))]));
    const countryNames = compact([
        j.address?.postalAddress?.addressCountry ?? null,
        ...(j.secondaryLocations ?? []).map((s) => {
            const a = s.address as AshbyAddress & { addressCountry?: string };
            return a?.postalAddress?.addressCountry ?? a?.addressCountry ?? null;
        }),
    ]);
    const wt = (j.workplaceType ?? '').toLowerCase();
    const title = displayTitle(j.title);
    let remote: boolean | null = typeof j.isRemote === 'boolean' ? j.isRemote : null;
    let basis: 'ats' | 'text' | null = remote === null ? null : 'ats';
    if (remote === null) ({ remote, basis } = remoteFromText(locations, title));
    const sal = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary');
    const summary =
        str(j.compensation?.compensationTierSummary) ?? str(j.compensation?.scrapeableCompensationSalarySummary);
    const compensation: Compensation | null =
        sal || summary
            ? {
                  summary,
                  min: sal?.minValue ?? null,
                  max: sal?.maxValue ?? null,
                  currency: sal?.currencyCode ?? null,
                  interval: sal?.interval ?? null,
              }
            : null;
    return withCountries(
        {
            ats: 'ashby',
            board: slug,
            company,
            job_id: j.id,
            title,
            department: display(j.department),
            team: display(j.team),
            locations,
            remote,
            remote_basis: basis,
            workplace_type: workplace(wt, null),
            employment_type: j.employmentType ? (EMPLOYMENT[j.employmentType] ?? j.employmentType) : null,
            compensation,
            posted_at: toIso(j.publishedAt),
            ats_updated_at: null,
            apply_url: str(j.applyUrl) ?? str(j.jobUrl),
            job_url: str(j.jobUrl),
            description_text: withDescription ? clip(display(j.descriptionPlain)) : null,
            detail_url: null,
        },
        countryNames,
    );
}

const EMPLOYMENT_LABEL: Record<string, string> = {
    permanent: 'Permanent',
    intern: 'Internship',
    trainee: 'Trainee',
    freelance: 'Freelance',
};
const SCHEDULE_LABEL: Record<string, string> = {
    'full-time': 'Full-time',
    'part-time': 'Part-time',
};
const SENIORITY_LABEL: Record<string, string> = {
    'entry-level': 'Entry-level',
    experienced: 'Experienced',
    executive: 'Executive',
    student: 'Student',
};

function enumLabel(map: Record<string, string>, raw: string | null): string | null {
    if (!raw) return null;
    const key = raw.trim().toLowerCase();
    if (!key) return null;
    if (map[key]) return map[key];
    if (key.length > 40) return null;
    return raw.trim();
}

/** Personio createdAt often uses +0200. Insert the colon so Date parses it. */
function personioPostedAt(raw: string | null): string | null {
    if (!raw) return null;
    return toIso(raw.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

/**
 * Same row shape as Greenhouse, Lever and Ashby.
 * Seniority, employment type and schedule share employment_type (no extra column).
 * Compensation is set only when the XML includes a salary element. apply_url and job_url
 * stay empty: the documented feed has no per-job URL, and we do not invent or fetch one.
 */
function mapPersonio(account: string, p: PersonioPosition, company: string, withDescription: boolean): NormalizedJob {
    const locations = uniq(p.offices.map((o) => o.trim()).filter(Boolean));
    const title = p.name.trim();
    const looked = locations.length > 0 || !!title || !!p.keywords;
    const remote = looked ? textSaysRemote(...locations, title, p.keywords) : null;
    const employment_type =
        [
            enumLabel(EMPLOYMENT_LABEL, p.employmentType),
            enumLabel(SCHEDULE_LABEL, p.schedule),
            enumLabel(SENIORITY_LABEL, p.seniority),
        ]
            .filter(Boolean)
            .join(', ') || null;
    let description: string | null = null;
    if (withDescription) {
        description = clip(
            p.descriptions
                .map((d) => [d.name, htmlToText(d.html)].filter(Boolean).join('\n'))
                .filter(Boolean)
                .join('\n\n') || null,
        );
    }
    return withCountries(
        {
            ats: 'personio',
            board: account.toLowerCase(),
            company: p.subcompany?.trim() || company,
            job_id: p.id,
            title,
            department: p.department,
            team: p.recruitingCategory,
            locations,
            remote,
            remote_basis: looked ? 'text' : null,
            workplace_type: remote ? 'remote' : null,
            employment_type,
            compensation: compensationFromSalary(p.salaryFields),
            posted_at: personioPostedAt(p.createdAt),
            ats_updated_at: null,
            apply_url: null,
            job_url: null,
            description_text: description,
            detail_url: null,
        },
        [],
    );
}

function personioFeedError(host: string, status: number, message: string, code: string, retryable: boolean): HttpError {
    return new HttpError(message, code, retryable, status, host);
}

const PINPOINT_EMPLOYMENT: Record<string, string> = {
    full_time: 'Full-time',
    part_time: 'Part-time',
    contract_temp: 'Contract',
    freelance: 'Freelance',
    internship: 'Internship',
    permanent: 'Permanent',
    fixed_term_contract: 'Fixed-term contract',
    zero_hours: 'Zero hours',
    permanent_full_time: 'Permanent, Full-time',
    permanent_part_time: 'Permanent, Part-time',
    fixed_term_full_time: 'Fixed-term, Full-time',
    fixed_term_part_time: 'Fixed-term, Part-time',
    flexible: 'Flexible',
    seasonal_full_time: 'Seasonal, Full-time',
    seasonal_part_time: 'Seasonal, Part-time',
    contract: 'Contract',
    temporary: 'Temporary',
    contract_to_hire: 'Contract to hire',
    volunteer: 'Volunteer',
    apprentice: 'Apprentice',
    programme: 'Programme',
};

function pinpointWorkplace(raw: string | null): NormalizedJob['workplace_type'] {
    const key = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (key === 'remote' || key === 'fully_remote') return 'remote';
    if (key === 'hybrid') return 'hybrid';
    if (key === 'onsite' || key === 'on_site' || key === 'office') return 'onsite';
    return null;
}

/**
 * Metadata and a listing link only. The ad body is not mapped, even when the caller
 * asked for descriptions. postings.json has no publish timestamp (deadline_at is a
 * close time and is not used). apply_url stays empty. job_url is this tenant's listing
 * URL and is not fetched.
 */
function mapPinpoint(subdomain: string, p: PinpointPosting, company: string): NormalizedJob {
    const account = subdomain.toLowerCase();
    const locations = p.locationName ? [p.locationName] : [];
    const title = p.title.trim();
    const workplace_type = pinpointWorkplace(p.workplaceType);
    let remote: boolean | null = null;
    let remote_basis: 'ats' | 'text' | null = null;
    if (workplace_type === 'remote') {
        remote = true;
        remote_basis = 'ats';
    } else if (workplace_type === 'hybrid' || workplace_type === 'onsite') {
        remote = false;
        remote_basis = 'ats';
    } else if (locations.length || title) {
        remote = textSaysRemote(...locations, title);
        remote_basis = 'text';
    }
    const employment_type =
        (p.employmentTypeText && p.employmentTypeText.length <= 80 ? p.employmentTypeText : null) ??
        (p.employmentType ? (PINPOINT_EMPLOYMENT[p.employmentType.toLowerCase()] ?? null) : null);
    return withCountries(
        {
            ats: 'pinpoint',
            board: account,
            company,
            job_id: p.id,
            title,
            department: p.department,
            team: p.team,
            locations,
            remote,
            remote_basis,
            workplace_type,
            employment_type,
            compensation: compensationFromPinpoint(p.compensation),
            posted_at: null,
            ats_updated_at: null,
            apply_url: null,
            job_url: pinpointListingUrl(account, p.listingUrl),
            description_text: null,
            detail_url: null,
        },
        [],
    );
}

function gemWorkplace(raw: string | null): NormalizedJob['workplace_type'] {
    const wt = (raw ?? '').toLowerCase();
    if (wt === 'remote') return 'remote';
    if (wt === 'hybrid') return 'hybrid';
    if (wt === 'in_office') return 'onsite';
    return null;
}

const GEM_EMPLOYMENT: Record<string, string> = {
    full_time: 'Full-time',
    part_time: 'Part-time',
    intern: 'Internship',
    contract: 'Contract',
    temporary: 'Temporary',
};

/**
 * Same row shape, without the ad body. content and content_plain are not mapped.
 * job_url is a jobs.gem.com link. apply_url stays empty. No per-job request.
 */
function mapGem(vanity: string, p: GemPost, company: string): NormalizedJob {
    const board = vanity.toLowerCase();
    const title = p.title.trim();
    const workplace_type = gemWorkplace(p.locationType);
    let remote: boolean | null = null;
    let remote_basis: 'ats' | 'text' | null = null;
    if (workplace_type === 'remote') {
        remote = true;
        remote_basis = 'ats';
    } else if (workplace_type === 'hybrid' || workplace_type === 'onsite') {
        remote = false;
        remote_basis = 'ats';
    } else if (p.locations.length || title) {
        remote = textSaysRemote(...p.locations, title);
        remote_basis = 'text';
    }
    return withCountries(
        {
            ats: 'gem',
            board,
            company,
            job_id: p.id,
            title,
            department: p.department,
            team: null,
            locations: p.locations,
            remote,
            remote_basis,
            workplace_type,
            employment_type: p.employmentType ? (GEM_EMPLOYMENT[p.employmentType.toLowerCase()] ?? null) : null,
            compensation: null,
            posted_at: toIso(p.postedAt),
            ats_updated_at: toIso(p.updatedAt),
            apply_url: null,
            job_url: gemPublicJobUrl(board, p.absoluteUrl, p.id),
            description_text: null,
            detail_url: null,
        },
        [],
    );
}

// ---------------- board fetch ----------------
export async function fetchBoard(client: AtsClient, ats: Ats, slug: string, o: FetchOpts): Promise<BoardFetch> {
    if (ats === 'personio') return fetchPersonio(client, slug, o);
    if (ats === 'pinpoint') return fetchPinpoint(client, slug, o);
    if (ats === 'gem') return fetchGem(client, slug, o);
    const hint = o.companyHint ?? prettySlug(slug);
    let url = listUrl(ats, slug);
    let note: string | undefined;
    let requests = 1;
    let r: Awaited<ReturnType<AtsClient['getJson']>>;
    try {
        r = await client.getJson<unknown>(url);
    } catch (e) {
        // Very large Greenhouse boards exceed the size cap with content=true; the documented list without
        // content still carries title, location, first_published, updated_at and metadata.
        if (ats !== 'greenhouse' || !(e instanceof HttpError) || e.code !== 'RESPONSE_TOO_LARGE') throw e;
        url = listUrl(ats, slug, { lite: true });
        r = await client.getJson<unknown>(url);
        requests = 2;
        note =
            'greenhouse_list_without_content: board too large for content=true, so department, offices and description are missing';
    }
    if (r.status === 404 || r.json === null) {
        return { company: null, jobs: [], total: 0, complete: false, sourceUrl: url, requests: 1, notFound: true };
    }
    let jobs: NormalizedJob[];
    let company: string | null = null;
    if (ats === 'greenhouse') {
        const raw = ((r.json as { jobs?: GhJob[] }).jobs ?? []) as GhJob[];
        company = str(raw[0]?.company_name);
        jobs = raw.map((j) => mapGreenhouse(slug, j, company ?? hint, o.withDescription));
    } else if (ats === 'lever') {
        const raw = (Array.isArray(r.json) ? r.json : []) as LeverJob[];
        jobs = raw.map((j) => mapLever(slug, j, hint, o.withDescription));
    } else if (ats === 'ashby') {
        const raw = ((r.json as { jobs?: AshbyJob[] }).jobs ?? []).filter((j) => j.isListed !== false);
        jobs = raw.map((j) => mapAshby(slug, j, hint, o.withDescription));
    } else {
        throw new HttpError(
            'Personio, Pinpoint and Gem are fetched from their documented feeds, not the JSON API hosts.',
            'URL_NOT_ALLOWED',
            false,
        );
    }
    const total = jobs.length;
    const complete = total <= o.maxJobs;
    return {
        company,
        jobs: complete ? jobs : jobs.slice(0, o.maxJobs),
        total,
        complete,
        sourceUrl: url,
        requests,
        notFound: false,
        note,
    };
}

async function fetchPersonio(client: AtsClient, slug: string, o: FetchOpts): Promise<BoardFetch> {
    if (!isValidPersonioAccount(slug)) {
        throw new HttpError(
            `Invalid Personio account "${slug}". Pass the company subdomain only (letters, digits, hyphens), e.g. personio:acme.`,
            'INVALID_INPUT',
            false,
        );
    }
    const account = slug.toLowerCase();
    const hint = o.companyHint ?? prettySlug(account);
    const loaded = await loadPersonioXml(account, o.personioIo ?? personioClient(client.gate), o.personioSleep);
    const host = `${account}.jobs.personio.de`;
    if (loaded.status === 404 || loaded.status === 410) {
        return {
            company: null,
            jobs: [],
            total: 0,
            complete: false,
            sourceUrl: loaded.url,
            requests: loaded.requests,
            notFound: true,
        };
    }
    if (loaded.status !== 200) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url} -> HTTP ${loaded.status}`,
            'ATS_HTTP_ERROR',
            loaded.status >= 500,
        );
    }
    if (!/<\s*workzag-jobs[\s>/]/i.test(loaded.body)) {
        if (/<\s*html[\s>]/i.test(loaded.body)) {
            client.gate.kill(host, loaded.status, 'HTML block page instead of Personio XML');
            throw personioFeedError(
                host,
                loaded.status,
                `${host} returned HTML instead of the XML feed; host stopped (kill switch).`,
                'HOST_BLOCKED',
                true,
            );
        }
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url}: not a Personio positions XML feed`,
            'ATS_BAD_RESPONSE',
            true,
        );
    }
    let positions: PersonioPosition[];
    try {
        positions = parsePersonioXml(loaded.body);
    } catch (e) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url}: ${e instanceof Error ? e.message : 'invalid XML'}`,
            'ATS_BAD_RESPONSE',
            false,
        );
    }
    const company = positions.map((p) => p.subcompany).find((s) => !!s && s.trim()) ?? null;
    const jobs = positions.map((p) => mapPersonio(account, p, company ?? hint, o.withDescription));
    const total = jobs.length;
    const complete = total <= o.maxJobs;
    return {
        company,
        jobs: complete ? jobs : jobs.slice(0, o.maxJobs),
        total,
        complete,
        sourceUrl: loaded.url,
        requests: loaded.requests,
        notFound: false,
    };
}

async function fetchPinpoint(client: AtsClient, slug: string, o: FetchOpts): Promise<BoardFetch> {
    if (!isValidPinpointSubdomain(slug)) {
        throw new HttpError(
            `Invalid Pinpoint subdomain "${slug}". Pass the company label only (letters, digits, hyphens), e.g. pinpoint:acme.`,
            'INVALID_INPUT',
            false,
        );
    }
    const account = slug.toLowerCase();
    const hint = o.companyHint ?? prettySlug(account);
    const loaded = await loadPinpointPostings(account, o.pinpointIo ?? pinpointClient(client.gate), o.pinpointSleep);
    const host = `${account}.pinpointhq.com`;
    if (loaded.status === 404 || loaded.status === 410) {
        return {
            company: null,
            jobs: [],
            total: 0,
            complete: false,
            sourceUrl: loaded.url,
            requests: loaded.requests,
            notFound: true,
        };
    }
    if (loaded.status !== 200) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url} -> HTTP ${loaded.status}`,
            'ATS_HTTP_ERROR',
            loaded.status >= 500,
        );
    }
    const trimmed = loaded.body.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        if (looksHtml(trimmed)) {
            client.gate.kill(host, loaded.status, 'HTML block page instead of Pinpoint JSON');
            throw personioFeedError(
                host,
                loaded.status,
                `${host} returned HTML instead of postings.json; host stopped (kill switch).`,
                'HOST_BLOCKED',
                true,
            );
        }
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url}: not a Pinpoint postings.json feed`,
            'ATS_BAD_RESPONSE',
            true,
        );
    }
    let posts: PinpointPosting[];
    try {
        posts = parsePinpointPostings(loaded.body);
    } catch (e) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url}: ${e instanceof Error ? e.message : 'invalid JSON'}`,
            'ATS_BAD_RESPONSE',
            false,
        );
    }
    const jobs = posts.map((p) => mapPinpoint(account, p, hint));
    const total = jobs.length;
    const complete = total <= o.maxJobs;
    return {
        company: null,
        jobs: complete ? jobs : jobs.slice(0, o.maxJobs),
        total,
        complete,
        sourceUrl: loaded.url,
        requests: loaded.requests,
        notFound: false,
    };
}

async function fetchGem(client: AtsClient, slug: string, o: FetchOpts): Promise<BoardFetch> {
    if (!isValidGemVanity(slug)) {
        throw new HttpError(
            `Invalid Gem vanity "${slug}". Pass the job-board path only (letters, digits, hyphens, underscores), e.g. gem:acme.`,
            'INVALID_INPUT',
            false,
        );
    }
    const vanity = slug.toLowerCase();
    const hint = o.companyHint ?? prettySlug(vanity);
    const loaded = await loadGemJobPosts(vanity, o.gemIo ?? gemClient(client.gate));
    const host = 'api.gem.com';
    if (loaded.status === 404 || loaded.status === 410) {
        return {
            company: null,
            jobs: [],
            total: 0,
            complete: false,
            sourceUrl: loaded.url,
            requests: loaded.requests,
            notFound: true,
        };
    }
    if (loaded.status !== 200) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url} -> HTTP ${loaded.status}`,
            'ATS_HTTP_ERROR',
            loaded.status >= 500,
        );
    }
    const trimmed = loaded.body.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        if (looksHtml(trimmed)) {
            client.gate.kill(host, loaded.status, 'HTML block page instead of Gem JSON');
            throw personioFeedError(
                host,
                loaded.status,
                `${host} returned HTML instead of job_posts JSON; host stopped (kill switch).`,
                'HOST_BLOCKED',
                true,
            );
        }
        throw personioFeedError(host, loaded.status, `GET ${loaded.url}: not a Gem job_posts list`, 'ATS_BAD_RESPONSE', true);
    }
    let posts: GemPost[];
    try {
        posts = parseGemJobPosts(loaded.body);
    } catch (e) {
        throw personioFeedError(
            host,
            loaded.status,
            `GET ${loaded.url}: ${e instanceof Error ? e.message : 'invalid JSON'}`,
            'ATS_BAD_RESPONSE',
            false,
        );
    }
    const jobs = posts.map((p) => mapGem(vanity, p, hint));
    const total = jobs.length;
    const complete = total <= o.maxJobs;
    return {
        company: null,
        jobs: complete ? jobs : jobs.slice(0, o.maxJobs),
        total,
        complete,
        sourceUrl: loaded.url,
        requests: loaded.requests,
        notFound: false,
    };
}

function looksHtml(body: string): boolean {
    return /^\s*</.test(body) && /<\s*html[\s>]/i.test(body.slice(0, 500));
}

/** Cheap existence check used by slug probing. Personio, Pinpoint and Gem are never probed. */
export async function probeBoard(
    client: AtsClient,
    ats: Ats,
    slug: string,
): Promise<{ found: boolean; company: string | null; url: string }> {
    let url: string;
    switch (ats) {
        case 'greenhouse':
            url = `${base(ats)}/v1/boards/${enc(slug)}`;
            break;
        case 'lever':
            url = listUrl(ats, slug, { limit: 1 });
            break;
        case 'ashby':
            url = listUrl(ats, slug);
            break;
        case 'personio':
            throw new HttpError(
                'Personio accounts are not probed. Pass the company subdomain the user named.',
                'URL_NOT_ALLOWED',
                false,
            );
        case 'pinpoint':
            throw new HttpError(
                'Pinpoint subdomains are not probed. Pass the company label the user named.',
                'URL_NOT_ALLOWED',
                false,
            );
        case 'gem':
            throw new HttpError(
                'Gem vanities are not probed. Pass the job-board path the user named.',
                'URL_NOT_ALLOWED',
                false,
            );
        default:
            url = listUrl(ats, slug, { limit: 1 });
    }
    const r = await client.getJson<unknown>(url);
    if (r.status !== 200 || r.json === null) return { found: false, company: null, url };
    if (ats === 'greenhouse') return { found: true, company: str((r.json as { name?: string }).name), url };
    if (ats === 'lever') return { found: Array.isArray(r.json), company: null, url };
    return { found: Array.isArray((r.json as { jobs?: unknown[] }).jobs), company: null, url };
}
