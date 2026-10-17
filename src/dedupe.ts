import { normText, normTitle, uniq } from './normalize.js';
import type { JobRow } from './types.js';

/**
 * dedupe:"role": rows of one board that share normalized title + department become one row listing all
 * locations; the merged-away job ids are listed in merged_job_ids and are not charged.
 */
export function mergeRoles(rows: JobRow[]): JobRow[] {
    const groups = new Map<string, JobRow[]>();
    for (const r of rows) {
        const k = `${normTitle(r.title)}|${normText(r.department)}`;
        const g = groups.get(k);
        if (g) g.push(r);
        else groups.set(k, [r]);
    }
    const out: JobRow[] = [];
    for (const g of groups.values()) {
        if (g.length === 1) {
            out.push(g[0]);
            continue;
        }
        // keep the oldest-posted (or first-seen) row as the representative
        g.sort((a, b) => (a.posted_at ?? a.first_seen_at).localeCompare(b.posted_at ?? b.first_seen_at));
        const [head, ...rest] = g;
        out.push({
            ...head,
            locations: uniq(g.flatMap((r) => r.locations)),
            countries: uniq(g.flatMap((r) => r.countries)),
            remote: g.some((r) => r.remote === true) ? true : head.remote,
            merged_job_ids: rest.map((r) => r.job_id),
            reposted: g.some((r) => r.reposted),
        });
    }
    return out;
}

/**
 * Cross-board / cross-ATS duplicate tracking for one run. The first row with a fingerprint is the canonical
 * one; later rows with the same fingerprint get duplicate_of = canonical job_key. Nothing is dropped.
 */
export class DuplicateTracker {
    private first = new Map<string, string>();
    readonly groups = new Map<string, string[]>();

    /** Pre-register a board's rows so that within-board groups are complete before any row is emitted. */
    register(rows: JobRow[]): void {
        for (const r of rows) {
            const g = this.groups.get(r.fingerprint);
            if (g) {
                if (!g.includes(r.job_key)) g.push(r.job_key);
            } else this.groups.set(r.fingerprint, [r.job_key]);
            if (!this.first.has(r.fingerprint)) this.first.set(r.fingerprint, r.job_key);
        }
    }

    annotate(r: JobRow): JobRow {
        const g = this.groups.get(r.fingerprint) ?? [];
        const first = this.first.get(r.fingerprint);
        return {
            ...r,
            duplicate_group: g.length > 1 ? r.fingerprint : null,
            duplicate_of: first && first !== r.job_key ? first : null,
        };
    }

    multiGroups(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [fp, keys] of this.groups) if (keys.length > 1) out[fp] = keys;
        return out;
    }
}
