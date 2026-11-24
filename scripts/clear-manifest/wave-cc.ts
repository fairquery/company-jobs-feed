/**
 * Wave: more observed board slugs from Common Crawl CDX.
 * Each hit is a URL on boards.greenhouse.io, job-boards.greenhouse.io,
 * jobs.ashbyhq.com, jobs.lever.co, or jobs.eu.lever.co. The slug is the
 * first path segment. Nothing is guessed. Job pages are not downloaded.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { USER_AGENT, isClearAts, isClearSlug, type ClearAts } from './board.js';

export const WAVE_CRAWLS = [
    'CC-MAIN-2026-39',
    'CC-MAIN-2026-34',
    'CC-MAIN-2026-30',
    'CC-MAIN-2026-25',
    'CC-MAIN-2026-21',
    'CC-MAIN-2026-17',
    'CC-MAIN-2026-12',
    'CC-MAIN-2026-08',
    'CC-MAIN-2026-04',
    'CC-MAIN-2025-51',
    'CC-MAIN-2025-47',
    'CC-MAIN-2025-43',
];

/** Older crawls. Run after WAVE_CRAWLS so a second pass does not repeat the first. */
export const WAVE_CRAWLS_OLDER = [
    'CC-MAIN-2025-38',
    'CC-MAIN-2025-33',
    'CC-MAIN-2025-30',
    'CC-MAIN-2025-26',
    'CC-MAIN-2025-21',
    'CC-MAIN-2025-18',
    'CC-MAIN-2025-13',
    'CC-MAIN-2025-08',
    'CC-MAIN-2025-05',
    'CC-MAIN-2024-51',
    'CC-MAIN-2024-46',
    'CC-MAIN-2024-42',
    'CC-MAIN-2024-38',
    'CC-MAIN-2024-33',
    'CC-MAIN-2024-30',
];

const PATTERNS = [
    'job-boards.greenhouse.io/*',
    'boards.greenhouse.io/*',
    'jobs.ashbyhq.com/*',
    'jobs.eu.lever.co/*',
    'jobs.lever.co/*',
];

const SKIP_SLUGS = new Set(['embed', 'robots.txt', 'sitemap.xml', 'favicon.ico', 'api', 'static', 'assets']);

export function slugFromCrawledUrl(raw: string): { ats: ClearAts; slug: string } | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const seg = url.pathname.split('/').filter(Boolean);
    const slug = seg[0] ? safeDecode(seg[0]) : '';
    if (!slug || SKIP_SLUGS.has(slug.toLowerCase()) || !isClearSlug(slug)) return null;
    let ats: ClearAts | null = null;
    if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') ats = 'greenhouse';
    else if (host === 'jobs.ashbyhq.com') ats = 'ashby';
    else if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') ats = 'lever';
    if (!ats || !isClearAts(ats)) return null;
    if (ats === 'greenhouse' && slug.toLowerCase() === 'embed') return null;
    return { ats, slug };
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

async function getText(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, status: res.status, text: '' };
    }
    return { ok: true, status: res.status, text: await res.text() };
}

export async function harvestCrawlWave(opts: {
    known: Set<string>;
    outFile: string;
    notesFile: string;
    crawls?: string[];
}): Promise<{ added: number; by_ats: Record<ClearAts, number>; notes: string[] }> {
    const notes: string[] = [];
    const by: Record<ClearAts, number> = { greenhouse: 0, ashby: 0, lever: 0 };
    let added = 0;
    const seen = new Set(opts.known);
    for (const crawl of opts.crawls ?? WAVE_CRAWLS) {
        for (const pattern of PATTERNS) {
            const metaUrl = `https://index.commoncrawl.org/${crawl}-index?url=${pattern}&showNumPages=true`;
            let pages = 0;
            try {
                const meta = await getText(metaUrl, 45_000);
                if (!meta.ok) {
                    notes.push(`fail meta ${crawl} ${pattern} HTTP ${meta.status}`);
                    continue;
                }
                const body = JSON.parse(meta.text) as { pages?: number };
                pages = Math.min(body.pages ?? 0, 25);
                if ((body.pages ?? 0) > 25) notes.push(`cap ${crawl} ${pattern} pages ${body.pages} -> 25`);
            } catch (e) {
                notes.push(`fail meta ${crawl} ${pattern}: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            if (!pages) {
                notes.push(`empty ${crawl} ${pattern}`);
                continue;
            }
            for (let page = 0; page < pages; page++) {
                const url = `https://index.commoncrawl.org/${crawl}-index?url=${pattern}&output=json&fl=url&page=${page}`;
                try {
                    const res = await getText(url, 90_000);
                    if (!res.ok) {
                        notes.push(`fail ${crawl} ${pattern} page ${page} HTTP ${res.status}`);
                        continue;
                    }
                    let pageNew = 0;
                    for (const line of res.text.split(/\n/)) {
                        if (!line.startsWith('{')) continue;
                        let raw: string;
                        try {
                            raw = (JSON.parse(line) as { url?: string }).url ?? '';
                        } catch {
                            continue;
                        }
                        const hit = slugFromCrawledUrl(raw);
                        if (!hit) continue;
                        const key = `${hit.ats}:${hit.slug.toLowerCase()}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        appendFileSync(
                            opts.outFile,
                            JSON.stringify({ ats: hit.ats, slug: hit.slug, sources: [`commoncrawl_${crawl.toLowerCase()}`] }) + '\n',
                        );
                        added++;
                        pageNew++;
                        by[hit.ats]++;
                    }
                    notes.push(`ok ${crawl} ${pattern} page ${page} new ${pageNew}`);
                    console.log(`WAVE-CC ${crawl} ${pattern} p${page} new ${pageNew} total ${added}`);
                } catch (e) {
                    notes.push(`fail ${crawl} ${pattern} page ${page}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
        writeFileSync(opts.notesFile, JSON.stringify({ added, by_ats: by, notes }, null, 2) + '\n');
    }
    writeFileSync(opts.notesFile, JSON.stringify({ added, by_ats: by, notes }, null, 2) + '\n');
    return { added, by_ats: by, notes };
}
