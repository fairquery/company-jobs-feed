/**
 * Build and verify the CLEAR board manifest for paid index ingest.
 *
 * Run this on a normal machine. It refuses Cloudflare Worker globals and
 * CF_WORKER / CF_PAGES so the crawl does not leave through Worker egress.
 *
 *   npx tsx scripts/clear-manifest.ts collect
 *   npx tsx scripts/clear-manifest.ts verify [--limit N]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CLEAR_PARITY_BY_ATS, CLEAR_PARITY_TARGET, workerEgressReason } from './clear-manifest/board.js';
import {
    type DirectCandidate,
    addDirect,
    loadDirectory,
    loadSeed,
    namesFromFile,
    probeNames,
    repoRoot,
    slugsFromUrlDump,
} from './clear-manifest/candidates.js';
import { fetchCommonCrawlUrlDump } from './clear-manifest/commoncrawl.js';
import { harvestCareers, loadSkipKeys, verifyAll } from './clear-manifest/verify.js';
import { harvestCareerTargets, readCareerTargets } from './clear-manifest/careers-wave.js';
import { WAVE_CRAWLS_OLDER, harvestCrawlWave } from './clear-manifest/wave-cc.js';

const root = repoRoot();
const srcDir = path.join(root, 'sources/clear');
const manifestFlag = process.argv.indexOf('--out');
const manifest = manifestFlag >= 0 && process.argv[manifestFlag + 1]
    ? path.resolve(process.argv[manifestFlag + 1])
    : path.join(root, 'manifests/clear-boards.jsonl');
const progress = path.join(root, 'manifests/clear-progress.json');
const spot = path.join(root, 'manifests/clear-spot-checks.json');
const candidatesPath = path.join(srcDir, 'candidates.jsonl');
const waveNextPath = path.join(srcDir, 'wave-next.jsonl');

function refuseWorker(): void {
    const globals = globalThis as { caches?: { default?: unknown }; WebSocketPair?: unknown };
    const reason = workerEgressReason(process.env, globals);
    if (reason) {
        console.error(`CLEAR manifest crawl refused: Cloudflare Worker egress (${reason}).`);
        process.exit(2);
    }
}

function nameLists() {
    return [
        ...namesFromFile(path.join(srcDir, 'wave2-sector-names.json'), 'sector_slug_probe'),
        ...namesFromFile(path.join(srcDir, 'wikipedia-lehigh-companies.json'), 'pa_lehigh_wikipedia'),
        ...namesFromFile(path.join(srcDir, 'ashby-customer-names.json'), 'ashby_customer_page'),
        ...namesFromFile(path.join(srcDir, 'lever-case-study-names.json'), 'lever_case_study'),
    ];
}

async function collect(withCrawl: boolean): Promise<void> {
    const map = new Map<string, DirectCandidate>();
    const seedN = loadSeed(map);
    const dirN = loadDirectory(path.join(srcDir, 'groundtruthtools-directory.json'), map);
    let crawlNotes: string[] = ['not requested'];
    if (withCrawl) {
        const dump = await fetchCommonCrawlUrlDump();
        crawlNotes = dump.notes;
        for (const hit of slugsFromUrlDump(dump.text)) {
            addDirect(map, { ...hit, source: 'commoncrawl_cc-main-2026-43' });
        }
        writeFileSync(path.join(srcDir, 'commoncrawl-notes.json'), JSON.stringify({ notes: crawlNotes }, null, 2) + '\n');
    }
    const names = nameLists();
    const harvest = await harvestCareers(
        names.filter((n) => n.source === 'sector_slug_probe'),
        (hit) => addDirect(map, hit),
    );
    const rows = [...map.values()].sort((a, b) => a.ats.localeCompare(b.ats) || a.slug.localeCompare(b.slug));
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(candidatesPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    const probes = probeNames(names);
    const summary = {
        direct: rows.length,
        by_ats: {
            greenhouse: rows.filter((r) => r.ats === 'greenhouse').length,
            ashby: rows.filter((r) => r.ats === 'ashby').length,
            lever: rows.filter((r) => r.ats === 'lever').length,
        },
        seed_rows: seedN,
        directory_rows_seen: dirN,
        name_probes: probes.length,
        careers: harvest,
        crawl_notes: crawlNotes,
        target: CLEAR_PARITY_TARGET,
        parity_by_ats: CLEAR_PARITY_BY_ATS,
    };
    writeFileSync(path.join(srcDir, 'collect-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
}

function readJsonlCandidates(file: string, map: Map<string, DirectCandidate>): void {
    let text = '';
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return;
    }
    for (const line of text.split(/\n/)) {
        if (!line.trim()) continue;
        let row: DirectCandidate;
        try {
            row = JSON.parse(line) as DirectCandidate;
        } catch {
            continue;
        }
        addDirect(map, { ats: row.ats, slug: row.slug, company: row.company, source: row.sources[0] ?? 'candidates' });
        const cur = map.get(`${row.ats}:${row.slug.toLowerCase()}`);
        if (cur) cur.sources = [...row.sources];
    }
}

function readCandidates(): Map<string, DirectCandidate> {
    const onlyAt = process.argv.indexOf('--only');
    const map = new Map<string, DirectCandidate>();
    if (onlyAt >= 0 && process.argv[onlyAt + 1]) {
        readJsonlCandidates(path.resolve(process.argv[onlyAt + 1]), map);
        return map;
    }
    readJsonlCandidates(candidatesPath, map);
    readJsonlCandidates(waveNextPath, map);
    return map;
}

async function main(): Promise<void> {
    refuseWorker();
    const cmd = process.argv[2] ?? 'verify';
    const limitFlag = process.argv.indexOf('--limit');
    const limitRaw = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : null;
    const limit = limitRaw != null && Number.isFinite(limitRaw) ? limitRaw : null;
    if (cmd === 'collect') {
        await collect(!process.argv.includes('--no-crawl'));
        return;
    }
    if (cmd === 'careers') {
        const targets = readCareerTargets(path.join(srcDir, 'careers-harvest-targets.jsonl'));
        const known = new Set<string>();
        for (const row of readCandidates().values()) known.add(`${row.ats}:${row.slug.toLowerCase()}`);
        const result = await harvestCareerTargets({
            targets,
            known,
            foundFile: waveNextPath,
            notesFile: path.join(srcDir, 'careers-harvest-notes.json'),
        });
        console.log(JSON.stringify(result));
        return;
    }
    if (cmd === 'wave-cc') {
        const known = new Set<string>();
        for (const row of readCandidates().values()) known.add(`${row.ats}:${row.slug.toLowerCase()}`);
        const result = await harvestCrawlWave({
            known,
            outFile: waveNextPath,
            notesFile: path.join(srcDir, process.argv.includes('--older') ? 'wave-cc-older-notes.json' : 'wave-cc-notes.json'),
            ...(process.argv.includes('--older') ? { crawls: WAVE_CRAWLS_OLDER } : {}),
        });
        console.log(JSON.stringify({ added: result.added, by_ats: result.by_ats }, null, 2));
        return;
    }
    if (cmd === 'verify') {
        const map = readCandidates();
        const probes = process.argv.includes('--no-probes') ? [] : probeNames(nameLists());
        const skip = loadSkipKeys(path.join(root, 'manifests/clear-rejects.jsonl'));
        const { stats, spots } = await verifyAll([...map.values()], probes, { manifest, progress, spot }, { limit, skip });
        console.log(`CLEAR verified ${stats.verified}/8854`);
        console.log(JSON.stringify({ stats, spots }, null, 2));
        return;
    }
    console.error('usage: tsx scripts/clear-manifest.ts collect|wave-cc|verify [--limit N] [--no-crawl]');
    process.exit(1);
}

await main();
