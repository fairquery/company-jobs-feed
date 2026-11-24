/**
 * Pull public board URLs from a Common Crawl CDX index and keep the slug only.
 * The index is a URL list, not a competitor job corpus. Failures are recorded and do not invent slugs.
 */
import { USER_AGENT } from './board.js';

export const CRAWL_ID = 'CC-MAIN-2026-43';

const SPECS: { pattern: string; pages: number }[] = [
    { pattern: 'job-boards.greenhouse.io/*', pages: 5 },
    { pattern: 'jobs.ashbyhq.com/*', pages: 1 },
    { pattern: 'boards.greenhouse.io/*', pages: 2 },
];

async function fetchPage(pattern: string, page: number): Promise<string> {
    const url =
        `https://index.commoncrawl.org/${CRAWL_ID}-index?url=${pattern}` +
        `&output=json&fl=url&page=${page}`;
    const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
        signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
        const err = new Error(`CDX ${pattern} page ${page} HTTP ${res.status}`);
        await res.body?.cancel();
        throw err;
    }
    return res.text();
}

export async function fetchCommonCrawlUrlDump(): Promise<{ text: string; notes: string[] }> {
    const notes: string[] = [];
    const parts: string[] = [];
    for (const spec of SPECS) {
        for (let page = 0; page < spec.pages; page++) {
            try {
                const text = await fetchPage(spec.pattern, page);
                parts.push(text.endsWith('\n') ? text : `${text}\n`);
                notes.push(`ok ${spec.pattern} page ${page} bytes ${text.length}`);
            } catch (e) {
                notes.push(`fail ${spec.pattern} page ${page}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    // The newest crawl's Lever query often 504s, and older crawls mostly stored robots.txt.
    // CC-MAIN-2026-39 page 0 did return a small set of real jobs.lever.co URLs (2026-11-01).
    const leverTries = [
        { id: CRAWL_ID, page: 0 },
        { id: 'CC-MAIN-2026-39', page: 0 },
    ];
    for (const attempt of leverTries) {
        const url =
            `https://index.commoncrawl.org/${attempt.id}-index?url=jobs.lever.co/*` +
            `&output=json&fl=url&page=${attempt.page}`;
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
                signal: AbortSignal.timeout(90_000),
            });
            if (!res.ok) {
                notes.push(`fail jobs.lever.co/* ${attempt.id} page ${attempt.page} HTTP ${res.status}`);
                await res.body?.cancel();
                continue;
            }
            const text = await res.text();
            parts.push(text.endsWith('\n') ? text : `${text}\n`);
            notes.push(`ok jobs.lever.co/* ${attempt.id} page ${attempt.page} bytes ${text.length}`);
        } catch (e) {
            notes.push(`fail jobs.lever.co/* ${attempt.id} page ${attempt.page}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { text: parts.join(''), notes };
}
