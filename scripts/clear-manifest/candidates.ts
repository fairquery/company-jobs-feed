/**
 * Candidate queues for the CLEAR manifest.
 * Direct slugs come from a saved source (seed, MIT directory, careers link, Common Crawl URL).
 * Name lists become probe plans through slugCandidates + probePlan. A probe is not a manifest row.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { extractBoardLinks, probePlan, slugCandidates } from '../../src/discovery.js';
import { SEED_BOARDS } from '../../src/seed.js';
import { excludedHost } from '../../src/types.js';

import { type ClearAts, isClearAts, isClearSlug, slugFromBoardUrl } from './board.js';

export interface DirectCandidate {
    ats: ClearAts;
    slug: string;
    company?: string;
    sources: string[];
}

export interface NameProbe {
    company: string;
    domain?: string;
    source: string;
    plan: { ats: ClearAts; slug: string }[];
}

export const DIRECTORY_SHA256 = 'ef84af06db88355a6fae395e406b670652da00e447c6624b28de5eacee46402b';

export function sha256File(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function preferSlug(current: string, next: string): string {
    const curMixed = current !== current.toLowerCase();
    const nextMixed = next !== next.toLowerCase();
    if (nextMixed && !curMixed) return next;
    return current;
}

export function addDirect(
    map: Map<string, DirectCandidate>,
    row: { ats: string; slug: string; company?: string | null; source: string },
): void {
    if (!isClearAts(row.ats) || !isClearSlug(row.slug)) return;
    const key = `${row.ats}:${row.slug.toLowerCase()}`;
    const company = row.company?.trim() || undefined;
    const prev = map.get(key);
    if (!prev) {
        map.set(key, { ats: row.ats, slug: row.slug, ...(company ? { company } : {}), sources: [row.source] });
        return;
    }
    prev.slug = preferSlug(prev.slug, row.slug);
    if (!prev.company && company) prev.company = company;
    if (!prev.sources.includes(row.source)) prev.sources.push(row.source);
}

export function loadDirectory(file: string, map: Map<string, DirectCandidate>): number {
    const hash = sha256File(file);
    if (hash !== DIRECTORY_SHA256) {
        throw new Error(`directory sha256 ${hash} != pinned ${DIRECTORY_SHA256}`);
    }
    const payload = JSON.parse(readFileSync(file, 'utf8')) as {
        boards?: { ats?: string; board?: string; company?: string | null }[];
    };
    let n = 0;
    for (const row of payload.boards ?? []) {
        if (!row.ats || !row.board) continue;
        const before = map.size;
        addDirect(map, {
            ats: row.ats,
            slug: row.board,
            company: row.company,
            source: 'oss_groundtruthtools_ats-jobs-mcp',
        });
        if (map.size > before || map.get(`${row.ats}:${row.board.toLowerCase()}`)?.sources.includes('oss_groundtruthtools_ats-jobs-mcp')) {
            n++;
        }
    }
    return n;
}

export function loadSeed(map: Map<string, DirectCandidate>): number {
    let n = 0;
    for (const s of SEED_BOARDS) {
        if (!isClearAts(s.ats)) continue;
        addDirect(map, { ats: s.ats, slug: s.slug, company: s.company, source: 'fairquery_seed' });
        n++;
    }
    return n;
}

/** Unique first-segment slugs from Common Crawl or any other URL dump. One JSON object per line, `url` field, or a raw URL line. */
export function slugsFromUrlDump(text: string): { ats: ClearAts; slug: string }[] {
    const out: { ats: ClearAts; slug: string }[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let url = trimmed;
        if (trimmed.startsWith('{')) {
            try {
                const row = JSON.parse(trimmed) as { url?: string };
                if (!row.url) continue;
                url = row.url;
            } catch {
                continue;
            }
        }
        const hit = slugFromBoardUrl(url);
        if (!hit) continue;
        const key = `${hit.ats}:${hit.slug.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hit);
    }
    return out;
}

export function slugsFromCareersHtml(html: string): { ats: ClearAts; slug: string }[] {
    const out: { ats: ClearAts; slug: string }[] = [];
    const seen = new Set<string>();
    for (const link of extractBoardLinks(html)) {
        if (!isClearAts(link.ats) || !isClearSlug(link.slug)) continue;
        const key = `${link.ats}:${link.slug.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ats: link.ats, slug: link.slug });
    }
    return out;
}

export function probeNames(
    names: { company: string; domain?: string; source: string }[],
): NameProbe[] {
    const out: NameProbe[] = [];
    for (const row of names) {
        const company = row.company.trim();
        if (!company) continue;
        const domain = row.domain?.trim();
        if (domain && excludedHost(domain)) continue;
        const cands: string[] = [];
        const push = (list: string[]) => {
            for (const s of list) if (isClearSlug(s) && !cands.includes(s)) cands.push(s);
        };
        if (domain) push(slugCandidates(domain));
        push(slugCandidates(company));
        const plan = probePlan(cands).filter((p): p is { ats: ClearAts; slug: string } => isClearAts(p.ats) && isClearSlug(p.slug));
        if (!plan.length) continue;
        out.push({ company, ...(domain ? { domain } : {}), source: row.source, plan });
    }
    return out;
}

export interface NameFile {
    companies?: { company?: string; domain?: string }[];
    names?: (string | { company?: string })[];
}

export function namesFromFile(file: string, source: string): { company: string; domain?: string; source: string }[] {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as NameFile;
    const out: { company: string; domain?: string; source: string }[] = [];
    for (const row of payload.companies ?? []) {
        if (!row.company?.trim()) continue;
        out.push({ company: row.company.trim(), ...(row.domain ? { domain: row.domain } : {}), source });
    }
    for (const row of payload.names ?? []) {
        if (typeof row === 'string') {
            if (row.trim()) out.push({ company: row.trim(), source });
            continue;
        }
        const company = row.company?.trim();
        if (company) out.push({ company, source });
    }
    return out;
}

export function repoRoot(): string {
    return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
}
