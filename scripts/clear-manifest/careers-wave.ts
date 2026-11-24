/**
 * Careers-page harvest. Targets are company career URLs from licensed public lists.
 * A Greenhouse, Lever, or Ashby slug is kept only when the page links to that board.
 * Wikipedia is not fetched here. HTTP 429 backs off and then stops that host.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { crawlDelayMs, isAllowed, parseRobots } from '../../src/robots.js';
import { ROBOTS_AGENT, excludedHost } from '../../src/types.js';

import { USER_AGENT, type ClearAts } from './board.js';
import { slugsFromCareersHtml } from './candidates.js';
import { slugFromCrawledUrl } from './wave-cc.js';

export interface CareerTarget {
    company: string;
    url: string;
    source: string;
}

const HOST_STRIKES = new Map<string, number>();
const HOST_DEAD = new Set<string>();

function sleep(ms: number): Promise<void> {
    return new Promise((r) => {
        setTimeout(r, ms);
    });
}

async function readCap(res: Response, max: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
        const text = await res.text();
        return text.slice(0, max);
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    while (n < max) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const room = max - n;
        chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
        n += Math.min(value.byteLength, room);
        if (value.byteLength > room) {
            await reader.cancel();
            break;
        }
    }
    const buf = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
        buf.set(c, o);
        o += c.byteLength;
    }
    return new TextDecoder().decode(buf);
}

export async function harvestCareerTargets(opts: {
    targets: CareerTarget[];
    known: Set<string>;
    foundFile: string;
    notesFile: string;
}): Promise<{ added: number; fetched: number; direct: number }> {
    let added = 0;
    let fetched = 0;
    let direct = 0;
    const notes: string[] = [];
    const robotsCache = new Map<string, { robots: ReturnType<typeof parseRobots>; delay: number } | 'dead'>();

    const record = (ats: ClearAts, slug: string, source: string, company: string) => {
        const key = `${ats}:${slug.toLowerCase()}`;
        if (opts.known.has(key)) return;
        opts.known.add(key);
        appendFileSync(
            opts.foundFile,
            JSON.stringify({ ats, slug, company, sources: [source] }) + '\n',
        );
        added++;
    };

    const one = async (t: CareerTarget) => {
        let url: URL;
        try {
            url = new URL(t.url);
        } catch {
            return;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        const directHit = slugFromCrawledUrl(t.url);
        if (directHit) {
            record(directHit.ats, directHit.slug, t.source, t.company);
            direct++;
            return;
        }
        if (excludedHost(url.hostname)) return;
        const host = url.hostname.toLowerCase();
        if (HOST_DEAD.has(host)) return;
        let gate = robotsCache.get(host);
        if (!gate) {
            try {
                const rob = await fetch(`https://${host}/robots.txt`, {
                    redirect: 'manual',
                    headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
                    signal: AbortSignal.timeout(8_000),
                });
                if (rob.status === 429) {
                    HOST_DEAD.add(host);
                    notes.push(`429 robots ${host}; host stopped`);
                    await rob.body?.cancel();
                    return;
                }
                const text = rob.status === 200 ? (await rob.text()).slice(0, 200_000) : '';
                if (rob.status !== 200) await rob.body?.cancel();
                const robots = parseRobots(text);
                gate = { robots, delay: Math.min(crawlDelayMs(robots, ROBOTS_AGENT), 5_000) };
                robotsCache.set(host, gate);
            } catch {
                robotsCache.set(host, 'dead');
                return;
            }
        }
        if (gate === 'dead') return;
        if (!isAllowed(gate.robots, ROBOTS_AGENT, url.pathname || '/')) return;
        if (gate.delay) await sleep(gate.delay);
        try {
            const res = await fetch(url, {
                redirect: 'manual',
                headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
                signal: AbortSignal.timeout(10_000),
            });
            fetched++;
            if (res.status === 429) {
                const strikes = (HOST_STRIKES.get(host) ?? 0) + 1;
                HOST_STRIKES.set(host, strikes);
                await res.body?.cancel();
                notes.push(`429 ${host} strike ${strikes}`);
                if (strikes >= 2) HOST_DEAD.add(host);
                else await sleep(60_000);
                return;
            }
            if (res.status !== 200) {
                await res.body?.cancel();
                return;
            }
            const html = await readCap(res, 180_000);
            for (const hit of slugsFromCareersHtml(html)) {
                record(hit.ats, hit.slug, t.source + '_careers_page', t.company);
            }
        } catch {
            /* timeout or network; leave the company for a later wave */
        }
    };

    let cursor = 0;
    const workers = Array.from({ length: 4 }, async () => {
        while (cursor < opts.targets.length) {
            const t = opts.targets[cursor++];
            await one(t);
            if (cursor % 100 === 0) {
                writeFileSync(opts.notesFile, JSON.stringify({ added, fetched, direct, cursor, notes: notes.slice(-40) }, null, 2) + '\n');
                console.log(`CAREERS added ${added} fetched ${fetched} direct ${direct} of ${cursor}`);
            }
        }
    });
    await Promise.all(workers);
    writeFileSync(opts.notesFile, JSON.stringify({ added, fetched, direct, notes: notes.slice(-80) }, null, 2) + '\n');
    console.log(`CAREERS done added ${added} fetched ${fetched} direct ${direct}`);
    return { added, fetched, direct };
}

export function readCareerTargets(file: string): CareerTarget[] {
    const out: CareerTarget[] = [];
    for (const line of readFileSync(file, 'utf8').split(/\n/)) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as CareerTarget;
            if (row.url && row.company) out.push(row);
        } catch {
            /* skip */
        }
    }
    return out;
}
