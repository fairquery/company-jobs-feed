import { companyKey, daysBetween, fingerprint, scrubPII } from './normalize.js';
import type { ClosedJob, JobHistory } from './state.js';
import { type Ats, type JobRow, type NormalizedJob, SCHEMA_VERSION } from './types.js';

export interface RowContext {
    nowIso: string;
    nowMs: number;
    domain: string | null;
    sourceUrl: string;
    longOpenDays: number;
    scrub: boolean;
}

export function jobKey(ats: Ats, board: string, id: string): string {
    return `${ats}:${board.toLowerCase()}:${id}`;
}

export function jobFingerprint(
    j: Pick<NormalizedJob, 'company' | 'title' | 'locations'>,
    domain: string | null,
): string {
    return fingerprint(companyKey(j.company, domain), j.title, j.locations[0]);
}

function staleSignal(reposted: boolean, longOpen: boolean): JobRow['stale_signal'] {
    if (reposted) return 'reposted';
    return longOpen ? 'long_open' : 'none';
}

export function buildJobRow(j: NormalizedJob, hist: JobHistory | null, fp: string, ctx: RowContext): JobRow {
    const first = hist?.first_seen_at ?? ctx.nowIso;
    const basisDate = j.posted_at ?? first;
    const age = daysBetween(basisDate, ctx.nowMs);
    const longOpen = age > ctx.longOpenDays;
    const reposted = !!hist?.repost_of;
    const { detail_url: _d, ...rest } = j;
    let description = rest.description_text;
    if (description && ctx.scrub) description = scrubPII(description).text;
    return {
        schema_version: SCHEMA_VERSION,
        type: 'job',
        ...rest,
        description_text: description,
        job_key: jobKey(j.ats, j.board, j.job_id),
        company_domain: ctx.domain,
        status: 'open',
        open_check: 'listed',
        verified_open_at: ctx.nowIso,
        first_seen_at: first,
        last_seen_at: hist?.last_seen_at ?? ctx.nowIso,
        age_days: age,
        age_basis: j.posted_at ? 'posted_at' : 'first_seen',
        long_open: longOpen,
        reposted,
        stale_signal: staleSignal(reposted, longOpen),
        repost_of: hist?.repost_of ?? null,
        change: hist?.change ?? null,
        fingerprint: fp,
        duplicate_group: null,
        duplicate_of: null,
        merged_job_ids: [],
        source_url: ctx.sourceUrl,
        checked_at: ctx.nowIso,
    };
}

/** A job that was open in the previous tracked run and is gone from a complete fetch now (free row). */
export function buildClosedRow(
    c: ClosedJob,
    meta: { ats: Ats; board: string; company: string },
    ctx: RowContext,
): JobRow {
    const e = c.entry;
    return {
        schema_version: SCHEMA_VERSION,
        type: 'job',
        ats: meta.ats,
        board: meta.board,
        company: meta.company,
        job_id: c.job_id,
        title: e.t,
        department: null,
        team: null,
        locations: e.loc ? [e.loc] : [],
        countries: [],
        country_basis: null,
        remote: null,
        remote_basis: null,
        workplace_type: null,
        employment_type: null,
        compensation: null,
        posted_at: null,
        ats_updated_at: null,
        apply_url: null,
        job_url: null,
        description_text: null,
        job_key: jobKey(meta.ats, meta.board, c.job_id),
        company_domain: ctx.domain,
        status: 'closed',
        open_check: 'not_seen',
        verified_open_at: null,
        first_seen_at: e.f,
        last_seen_at: e.l,
        age_days: daysBetween(e.f, Date.parse(e.l)),
        age_basis: 'first_seen',
        long_open: false,
        reposted: !!e.ro,
        stale_signal: 'none',
        repost_of: e.ro ?? null,
        change: 'closed',
        fingerprint: e.fp,
        duplicate_group: null,
        duplicate_of: null,
        merged_job_ids: [],
        source_url: ctx.sourceUrl,
        checked_at: ctx.nowIso,
    };
}
