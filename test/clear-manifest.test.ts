import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEED_BOARDS } from '../src/seed.js';
import {
    CLEAR_PARITY_BY_ATS,
    CLEAR_PARITY_TARGET,
    aggregatorBoardReason,
    backoffMs,
    companyFromBoardTitle,
    companyMatches,
    jobsApiUrl,
    manifestLine,
    parseAtsJson,
    publishedBoard,
    slugFromBoardUrl,
    urlUsesEmbed,
    workerEgressReason,
} from '../scripts/clear-manifest/board.js';
import {
    DIRECTORY_SHA256,
    probeNames,
    sha256File,
    slugsFromCareersHtml,
    slugsFromUrlDump,
} from '../scripts/clear-manifest/candidates.js';
import { slugFromCrawledUrl } from '../scripts/clear-manifest/wave-cc.js';

describe('CLEAR manifest rules', () => {
    it('keeps the free starter list at 135 boards', () => {
        expect(SEED_BOARDS).toHaveLength(135);
    });

    it('uses the rival CLEAR-family ceiling 5243+3355+256', () => {
        expect(CLEAR_PARITY_BY_ATS.greenhouse + CLEAR_PARITY_BY_ATS.ashby + CLEAR_PARITY_BY_ATS.lever).toBe(8854);
        expect(CLEAR_PARITY_TARGET).toBe(8854);
    });

    it('never builds an embed URL or a Greenhouse content= URL', () => {
        for (const ats of ['greenhouse', 'lever', 'ashby'] as const) {
            const url = jobsApiUrl(ats, 'andurilindustries');
            expect(urlUsesEmbed(url)).toBe(false);
            expect(url.includes('/embed/')).toBe(false);
            expect(url.includes('content=')).toBe(false);
        }
        expect(jobsApiUrl('greenhouse', 'andurilindustries')).toBe(
            'https://boards-api.greenhouse.io/v1/boards/andurilindustries/jobs',
        );
        expect(slugFromBoardUrl('https://boards.greenhouse.io/embed/job_board?for=acme')).toBeNull();
    });

    it('backs off hard on 429 and caps the wait', () => {
        expect(backoffMs(1, null)).toBe(60_000);
        expect(backoffMs(2, null)).toBe(120_000);
        expect(backoffMs(3, null)).toBe(240_000);
        expect(backoffMs(1, 90_000)).toBe(90_000);
        expect(backoffMs(8, null)).toBe(15 * 60_000);
    });

    it('refuses Cloudflare Worker egress flags', () => {
        expect(workerEgressReason({}, {})).toBeNull();
        expect(workerEgressReason({ CF_WORKER: '1' }, {})).toBe('CF_WORKER');
        expect(workerEgressReason({}, { caches: { default: {} }, WebSocketPair: function WebSocketPair() {} })).toBe(
            'cloudflare-worker-globals',
        );
    });

    it('matches the board company and rejects a different company on a similar slug', () => {
        expect(companyMatches('Stripe', 'Stripe')).toBe(true);
        expect(companyMatches('Ōura', 'Oura')).toBe(true);
        expect(companyMatches('CHAOS Industries', 'Chaos Industries')).toBe(true);
        expect(companyMatches('DoorDash USA', 'DoorDash')).toBe(true);
        expect(companyMatches('Ginkgo Bioworks Inc.', 'Ginkgo Bioworks')).toBe(true);
        expect(companyMatches('Apex Space', 'Apex Eye')).toBe(false);
        expect(companyMatches('Hinge Health', 'Hinge')).toBe(false);
        expect(companyMatches('Sword Health', 'Sword')).toBe(false);
        expect(companyMatches('Planet Labs', 'Planet')).toBe(false);
    });

    it('reads a board title and drops Ashby unlisted jobs', () => {
        expect(companyFromBoardTitle('OpenAI Jobs')).toBe('OpenAI');
        expect(companyFromBoardTitle('Spotify')).toBe('Spotify');
        expect(companyFromBoardTitle('Page not found')).toBeNull();
        const body = parseAtsJson(
            JSON.stringify({
                jobs: [
                    { title: 'Hidden', isListed: false, descriptionPlain: 'secret body' },
                    { title: 'Public role', isListed: true, descriptionHtml: '<p>body</p>' },
                ],
            }),
        );
        expect(JSON.stringify(body)).not.toContain('secret');
        expect(publishedBoard('ashby', body).jobs).toBe(1);
        expect(publishedBoard('lever', [{ text: 'Nurse' }, { text: '' }]).jobs).toBe(1);
        expect(publishedBoard('greenhouse', { jobs: [{ title: 'Eng', company_name: 'Anduril' }] })).toMatchObject({
            jobs: 1,
            company: 'Anduril',
        });
    });

    it('takes slugs from public board URLs and ignores other ATS hosts', () => {
        const dump = [
            '{"url":"https://jobs.lever.co/veeva/9ac55b31-df46-4acb-b305-2c0b7ed56027"}',
            'https://jobs.ashbyhq.com/saronic/d3ad80db-8508-4677-95d6-93c5d7a33815',
            'https://job-boards.greenhouse.io/andurilindustries/jobs/1',
            'https://boards.greenhouse.io/embed/job_board?for=nope',
            'https://jobs.smartrecruiters.com/acme/1',
        ].join('\n');
        expect(slugsFromUrlDump(dump)).toEqual([
            { ats: 'lever', slug: 'veeva' },
            { ats: 'ashby', slug: 'saronic' },
            { ats: 'greenhouse', slug: 'andurilindustries' },
        ]);
        const html = '<a href="https://jobs.lever.co/hermeus">jobs</a> https://boards.greenhouse.io/embed/job_board?for=skip';
        expect(slugsFromCareersHtml(html)).toEqual([
            { ats: 'lever', slug: 'hermeus' },
            { ats: 'greenhouse', slug: 'skip' },
        ]);
    });

    it('probes named companies with the product slug plan and skips an excluded host', () => {
        const probes = probeNames([
            { company: 'Hadrian', domain: 'hadrian.co', source: 'sector_slug_probe' },
            { company: 'Rippling', domain: 'rippling.com', source: 'sector_slug_probe' },
        ]);
        expect(probes.map((p) => p.company)).toEqual(['Hadrian']);
        expect(probes[0].plan.length).toBeGreaterThan(0);
        expect(probes[0].plan.every((p) => ['greenhouse', 'lever', 'ashby'].includes(p.ats))).toBe(true);
        expect(probes[0].plan.some((p) => p.slug === 'hadrian')).toBe(true);
    });

    it('pins the MIT directory snapshot', () => {
        const file = path.join(process.cwd(), 'sources/clear/groundtruthtools-directory.json');
        expect(sha256File(file)).toBe(DIRECTORY_SHA256);
        const raw = readFileSync(file, 'utf8');
        expect(raw).toContain('"ats"');
        expect(raw).not.toContain('workday');
    });

    it('rejects aggregator boards and keeps an employer board that only mentions a channel', () => {
        expect(aggregatorBoardReason('ziprecruiter', 'ZipRecruiter')).toBe('aggregator_board');
        expect(aggregatorBoardReason('glassdoor', 'Glassdoor')).toBe('aggregator_board');
        expect(aggregatorBoardReason('indeed', 'Indeed')).toBe('aggregator_board');
        expect(aggregatorBoardReason('artefactlinkedin', 'LinkedIn Job Wrapping')).toBe('aggregator_feed');
        expect(aggregatorBoardReason('stone', 'Stone - Indeed')).toBeNull();
        expect(aggregatorBoardReason('indeedbtrbt', 'Pediatrics Plus')).toBeNull();
        expect(aggregatorBoardReason('stripe', 'Stripe')).toBeNull();
    });

    it('reads observed crawl URLs and drops embed and robots paths', () => {
        expect(slugFromCrawledUrl('https://job-boards.greenhouse.io/stripe/jobs/1')).toEqual({
            ats: 'greenhouse',
            slug: 'stripe',
        });
        expect(slugFromCrawledUrl('https://jobs.eu.lever.co/spotify/abc')).toEqual({ ats: 'lever', slug: 'spotify' });
        expect(slugFromCrawledUrl('https://boards.greenhouse.io/embed/job_board?for=acme')).toBeNull();
        expect(slugFromCrawledUrl('https://jobs.lever.co/robots.txt')).toBeNull();
        expect(slugFromCrawledUrl('https://jobs.smartrecruiters.com/acme/1')).toBeNull();
    });

    it('writes a manifest row the ingest can read', () => {
        const line = manifestLine({
            ats: 'greenhouse',
            slug: 'andurilindustries',
            company: 'Anduril',
            jobs: 10,
            http_status: 200,
            verified_at: '2026-11-01',
            verified_by: 'api_live_probe',
            company_match: 'api_company_name',
            source_url: jobsApiUrl('greenhouse', 'andurilindustries'),
            sources: ['fairquery_seed'],
        });
        const row = JSON.parse(line) as { ats: string; slug: string; company: string };
        expect(row).toMatchObject({ ats: 'greenhouse', slug: 'andurilindustries', company: 'Anduril' });
        expect(line.startsWith('{"ats":"greenhouse","slug":"andurilindustries","company":"Anduril"')).toBe(true);
    });
});
