import { readFileSync } from 'node:fs';

import { Ajv } from 'ajv';
import { describe, expect, it, vi } from 'vitest';

import { detailUrl, fetchBoard, listUrl, mapAshby, mapGreenhouse, mapLever } from '../src/ats.js';
import { DuplicateTracker, mergeRoles } from '../src/dedupe.js';
import {
    discoverCompany,
    extractBoardLinks,
    findCareersLinks,
    parseBoardUrl,
    probePlan,
    seedLookup,
    slugCandidates,
    unsupportedAts,
} from '../src/discovery.js';
import {
    compileFilters,
    emptySearchSuggestions,
    expandLocationTerm,
    LOCATION_METRO_NAMES,
    matches,
    STARTER_LIST_COVERAGE_NOTE,
    US_STATE_LOCATION_NAMES,
} from '../src/filters.js';
import { countriesFromText, countryToIso2 } from '../src/gazetteer.js';
import { assertGemFetchUrl } from '../src/gem.js';
import { AtsClient, CareersFetcher, HostGate, HttpError } from '../src/http.js';
import { iterateJsonArray } from '../src/json-array.js';
import { scanSeedByLocation } from '../src/location-scan.js';
import type { SeedBoard } from '../src/seed.js';
import { htmlToText, normTitle, scrubPII, wordMatch } from '../src/normalize.js';
import { assertPersonioFetchUrl } from '../src/personio.js';
import { assertPinpointFetchUrl } from '../src/pinpoint.js';
import { crawlDelayMs, isAllowed, parseRobots } from '../src/robots.js';
import { buildBoardRow, buildClosedRow, buildJobRow, jobFingerprint, type RowContext } from '../src/rows.js';
import { SEED_BOARDS } from '../src/seed.js';
import { isPrivateAddress, unsafeUrlReason } from '../src/ssrf.js';
import { applyHistory, type BoardState } from '../src/state.js';
import {
    BOARD_CONCURRENCY,
    excludedHost,
    HOST_CONCURRENCY,
    LOCATION_SCAN_BOARD_MAX_BYTES,
    LOCATION_SCAN_BUDGET_MS,
    LOCATION_SCAN_CONCURRENCY,
    LOCATION_SCAN_CPU_BUDGET_MS,
    LOCATION_SCAN_CPU_BYTES_PER_MS,
    LOCATION_SCAN_HOSTED_BODY_MAX_JOBS,
    LOCATION_SCAN_MATCHED_ROW_CAP,
    LOCATION_SCAN_MAX_ATTEMPTS,
    LOCATION_SCAN_MAX_REQUESTS,
    LOCATION_SCAN_RETRY_DELAY_MS,
    LOCATION_SCAN_ROW_CPU_MS,
    type BoardRef,
    type NormalizedJob,
} from '../src/types.js';

const NOW = '2026-10-17T12:00:00.000Z';
const ctx: RowContext = {
    nowIso: NOW,
    nowMs: Date.parse(NOW),
    domain: 'example.com',
    sourceUrl: 'https://x',
    longOpenDays: 60,
    scrub: true,
};

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
    return {
        ats: 'greenhouse',
        board: 'acme',
        company: 'Acme',
        job_id: '1',
        title: 'Software Engineer',
        department: 'Engineering',
        team: null,
        locations: ['New York, NY'],
        countries: ['US'],
        country_basis: 'text',
        remote: false,
        remote_basis: 'text',
        workplace_type: null,
        employment_type: 'Full-time',
        compensation: null,
        posted_at: '2026-10-10T00:00:00.000Z',
        ats_updated_at: null,
        apply_url: null,
        job_url: null,
        description_text: null,
        detail_url: null,
        ...over,
    };
}

function fakeFetch(handler: (url: string) => { status: number; body: unknown; type?: string }): typeof fetch {
    return (async (input: string | URL) => {
        const r = handler(String(input));
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return new Response(text, { status: r.status, headers: { 'content-type': r.type ?? 'application/json' } });
    }) as typeof fetch;
}

describe('board URL parsing and discovery helpers', () => {
    it('parses every supported board URL form', () => {
        expect(parseBoardUrl('https://boards.greenhouse.io/stripe')).toEqual({ ats: 'greenhouse', slug: 'stripe' });
        expect(parseBoardUrl('https://job-boards.greenhouse.io/embed/job_board?for=figma')).toEqual({
            ats: 'greenhouse',
            slug: 'figma',
        });
        expect(parseBoardUrl('https://jobs.lever.co/palantir/abc-123')).toEqual({ ats: 'lever', slug: 'palantir' });
        expect(parseBoardUrl('jobs.ashbyhq.com/ramp')).toEqual({ ats: 'ashby', slug: 'ramp' });
        expect(parseBoardUrl('https://careers.smartrecruiters.com/BoschGroup')).toBeNull();
        expect(parseBoardUrl('smartrecruiters:BoschGroup')).toBeNull();
        expect(parseBoardUrl('ashby:ramp')).toEqual({ ats: 'ashby', slug: 'ramp' });
        expect(parseBoardUrl('https://www.linkedin.com/jobs/view/123')).toBeNull();
        expect(parseBoardUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers')).toBeNull();
        expect(parseBoardUrl('https://jobs.ashbyhq.com/api/non-user-graphql')).toBeNull();
        expect(parseBoardUrl('personio:Acme-EU')).toEqual({ ats: 'personio', slug: 'acme-eu' });
        expect(parseBoardUrl('https://acme.jobs.personio.de/xml?language=en')).toEqual({
            ats: 'personio',
            slug: 'acme',
        });
        expect(parseBoardUrl('https://acme.jobs.personio.com/job/12')).toEqual({ ats: 'personio', slug: 'acme' });
        expect(parseBoardUrl('https://jobs.personio.de/xml')).toBeNull();
        expect(parseBoardUrl('https://www.jobs.personio.de/xml')).toBeNull();
        expect(parseBoardUrl('https://acme.jobs.personio.de.evil.com/xml')).toBeNull();
        expect(parseBoardUrl('personio:foo.bar')).toBeNull();
        expect(parseBoardUrl('personio:-bad')).toBeNull();
        expect(parseBoardUrl('pinpoint:Acme')).toEqual({ ats: 'pinpoint', slug: 'acme' });
        expect(parseBoardUrl('https://acme.pinpointhq.com/jobs.json')).toEqual({ ats: 'pinpoint', slug: 'acme' });
        expect(parseBoardUrl('https://acme.pinpointhq.com/en/postings.json?department_id=1')).toEqual({
            ats: 'pinpoint',
            slug: 'acme',
        });
        expect(parseBoardUrl('https://www.pinpointhq.com/postings.json')).toBeNull();
        expect(parseBoardUrl('https://pinpointhq.com/postings.json')).toBeNull();
        expect(parseBoardUrl('https://acme.pinpointhq.com.evil.com/postings.json')).toBeNull();
        expect(parseBoardUrl('pinpoint:foo.bar')).toBeNull();
        expect(parseBoardUrl('gem:Acme_Board')).toEqual({ ats: 'gem', slug: 'acme_board' });
        expect(parseBoardUrl('https://jobs.gem.com/acme/am9icG9zdA')).toEqual({ ats: 'gem', slug: 'acme' });
        expect(parseBoardUrl('https://api.gem.com/job_board/v0/acme/job_posts/')).toEqual({ ats: 'gem', slug: 'acme' });
        expect(parseBoardUrl('https://api.gem.com/job_board/v0/acme/job_posts/id/applications')).toEqual({
            ats: 'gem',
            slug: 'acme',
        });
        expect(parseBoardUrl('https://jobs.gem.com/')).toBeNull();
        expect(parseBoardUrl('https://www.gem.com/acme')).toBeNull();
        expect(parseBoardUrl('gem:foo.bar')).toBeNull();
        expect(parseBoardUrl('https://api.gem.com/job_board/v0/reference')).toBeNull();
        expect(parseBoardUrl('https://acme.rippling.com/jobs')).toBeNull();
    });

    it('extracts ATS links and Greenhouse embeds from a careers page', () => {
        const html = `<a href="https://jobs.lever.co/acme">Jobs</a>
            <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme2"></script>
            <iframe src="https:\\/\\/jobs.ashbyhq.com\\/acme3"></iframe>`;
        const links = extractBoardLinks(html).map((b) => `${b.ats}:${b.slug}`);
        expect(links).toEqual(expect.arrayContaining(['lever:acme', 'greenhouse:acme2', 'ashby:acme3']));
        const withPersonio = `${html}<a href="https://acme.jobs.personio.de/xml">Personio</a><a href="https://acme.pinpointhq.com/postings.json">Pinpoint</a><a href="https://jobs.gem.com/acme">Gem</a>`;
        expect(extractBoardLinks(withPersonio).some((b) => b.ats === 'personio' || b.ats === 'pinpoint' || b.ats === 'gem')).toBe(false);
    });

    it('only follows same-site careers links', () => {
        const html =
            '<a href="/careers">Careers</a><a href="https://evil.example/jobs">Jobs</a><a href="https://careers.acme.com/">Join us</a>';
        expect(findCareersLinks(html, 'https://www.acme.com/')).toEqual([
            'https://www.acme.com/careers',
            'https://careers.acme.com/',
        ]);
    });

    it('caps slug probes at 6 per company', () => {
        expect(slugCandidates('https://www.ramp.com/careers')[0]).toBe('ramp');
        expect(slugCandidates('Palantir Technologies Inc')).toEqual([
            'palantirtechnologies',
            'palantir-technologies',
            'palantir',
        ]);
        expect(probePlan(slugCandidates('Palantir Technologies')).length).toBeLessThanOrEqual(6);
        expect(probePlan(['acme']).map((p) => p.ats)).toEqual(['greenhouse', 'lever', 'ashby']);
    });

    it('seed list resolves by domain and name, and every entry is well-formed', () => {
        expect(seedLookup('stripe.com')[0]).toMatchObject({ ats: 'greenhouse', slug: 'stripe' });
        expect(seedLookup('Ramp')[0]).toMatchObject({ ats: 'ashby', slug: 'ramp' });
        for (const s of SEED_BOARDS) {
            expect(['greenhouse', 'lever', 'ashby']).toContain(s.ats);
            expect(s.jobs_at_verification).toBeGreaterThan(0);
            expect(s.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('2026-10-27 starter expansion is 84 CLEAR boards with the seed shape', () => {
        expect(SEED_BOARDS).toHaveLength(135);
        const added = SEED_BOARDS.filter((s) => s.verified_at === '2026-10-27');
        expect(added).toHaveLength(84);
        expect(SEED_BOARDS.find((s) => s.slug === 'spacex')).toMatchObject({
            company: 'SpaceX',
            domain: 'spacex.com',
            ats: 'greenhouse',
            slug: 'spacex',
            verified_at: '2026-10-27',
            verified_by: 'api_live_probe',
            jobs_at_verification: 2834,
        });
        expect(SEED_BOARDS.find((s) => s.slug === 'saronic')).toMatchObject({
            company: 'Saronic',
            domain: 'saronic.com',
            ats: 'ashby',
            verified_by: 'api_live_probe',
        });
        expect(SEED_BOARDS.find((s) => s.slug === 'hermeus')).toMatchObject({
            company: 'Hermeus',
            domain: 'hermeus.com',
            ats: 'lever',
            verified_by: 'api_live_probe',
        });
        const slugs = new Set<string>();
        const domains = new Set<string>();
        for (const s of SEED_BOARDS) {
            expect(slugs.has(s.slug.toLowerCase()), s.slug).toBe(false);
            expect(domains.has(s.domain.toLowerCase()), s.domain).toBe(false);
            slugs.add(s.slug.toLowerCase());
            domains.add(s.domain.toLowerCase());
            expect(['greenhouse', 'lever', 'ashby']).toContain(s.ats);
        }
        expect(added.every((s) => s.verified_by === 'api_live_probe')).toBe(true);
    });
});

describe('SSRF guard', () => {
    it('flags private, loopback, link-local, CGNAT and mapped addresses', () => {
        for (const ip of [
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '192.168.1.1',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '::1',
            'fe80::1',
            'fd00::1',
            '::ffff:127.0.0.1',
            '198.18.0.1',
        ]) {
            expect(isPrivateAddress(ip), ip).toBe(true);
        }
        expect(isPrivateAddress('104.16.1.1')).toBe(false);
        expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    });

    it('rejects unsafe URLs before DNS', () => {
        expect(unsafeUrlReason(new URL('http://127.0.0.1/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('http://8.8.8.8/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://acme.com:8443/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://user:pw@acme.com/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('file:///etc/passwd'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://metadata.google.internal/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://acme.com/careers'))).toBeNull();
    });

    it('refuses careers hosts that resolve to private IPs (DNS rebinding)', async () => {
        const f = new CareersFetcher(new HostGate(), async () => [{ address: '10.0.0.5', family: 4 }]);
        await expect(f.getPage('https://acme.com/')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
    });

    it('ATS client only calls the three documented API hosts', async () => {
        const c = new AtsClient(
            new HostGate(),
            fakeFetch(() => ({ status: 200, body: {} })),
        );
        await expect(c.getJson('https://evil.example/v1/boards/x')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('https://jobs.ashbyhq.com/api/x')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('http://boards-api.greenhouse.io/v1/boards/x')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(c.getJson('https://acme.jobs.personio.de/xml')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('https://acme.jobs.personio.de/job/1')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('https://acme.pinpointhq.com/postings.json')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('https://api.gem.com/job_board/v0/acme/job_posts/')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
    });

    it('does not crawl Personio hosts, including the bare jobs directory', async () => {
        const f = new CareersFetcher(new HostGate(), async () => {
            throw new Error('DNS should not run');
        });
        await expect(f.getPage('https://acme.jobs.personio.de/')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getPage('https://acme.jobs.personio.de/job/1')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getPage('https://jobs.personio.de/xml')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getExact('https://acme.jobs.personio.de/job/1')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getExact('https://acme.jobs.personio.com/xml')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        expect(() => assertPersonioFetchUrl('https://acme.jobs.personio.de/xml?language=en', '/xml')).toThrow(
            HttpError,
        );
    });

    it('does not crawl Pinpoint or Gem hosts, and refuses every path except the documented GET', async () => {
        const f = new CareersFetcher(new HostGate(), async () => {
            throw new Error('DNS should not run');
        });
        await expect(f.getPage('https://acme.pinpointhq.com/postings.json')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getPage('https://www.pinpointhq.com/security-privacy/acceptable-use-policy')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getPage('https://jobs.gem.com/acme')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getPage('https://api.gem.com/job_board/v0/acme/job_posts/')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getPinpoint('https://acme.pinpointhq.com/jobs.json')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getPinpoint('https://acme.pinpointhq.com/postings.json?department_id=1')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getPinpoint('https://acme.pinpointhq.com/en/postings.json')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getPinpoint('https://acme.pinpointhq.com/api/v1/jobs')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(f.getGem('https://api.gem.com/job_board/v0/acme/job_posts/id/applications')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getGem('https://api.gem.com/job_board/v0/acme/departments/')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getGem('https://api.gem.com/job_board/v0/acme/offices/')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
        await expect(f.getGem('https://api.gem.com/robots.txt')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        expect(() => assertPinpointFetchUrl('https://acme.pinpointhq.com/jobs.json', '/postings.json')).toThrow(HttpError);
        expect(() => assertGemFetchUrl('https://api.gem.com/job_board/v0/acme/job_posts/id')).toThrow(HttpError);
    });
});

describe('kill switch', () => {
    it('stops a host after a 429 and fails fast afterwards without more requests', async () => {
        let calls = 0;
        const gate = new HostGate();
        const c = new AtsClient(
            gate,
            fakeFetch(() => {
                calls++;
                return { status: 429, body: { error: 'slow down' } };
            }),
        );
        await expect(c.getJson(listUrl('greenhouse', 'a'))).rejects.toMatchObject({
            code: 'HOST_BLOCKED',
            status: 429,
        });
        await expect(c.getJson(listUrl('greenhouse', 'b'))).rejects.toBeInstanceOf(HttpError);
        expect(calls).toBe(1);
        expect(gate.isKilled('boards-api.greenhouse.io')).toBe(true);
        expect(gate.isKilled('api.lever.co')).toBe(false);
    });

    it('treats a 403 and an HTML challenge page as blocks', async () => {
        const g1 = new HostGate();
        await expect(
            new AtsClient(
                g1,
                fakeFetch(() => ({ status: 403, body: 'no' })),
            ).getJson(listUrl('lever', 'x')),
        ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        const g2 = new HostGate();
        await expect(
            new AtsClient(
                g2,
                fakeFetch(() => ({ status: 200, body: '<html>captcha</html>', type: 'text/html' })),
            ).getJson(listUrl('ashby', 'x')),
        ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        expect(g2.isKilled('api.ashbyhq.com')).toBe(true);
    });

    it('returns 404 as not found (not a block)', async () => {
        const c = new AtsClient(
            new HostGate(),
            fakeFetch(() => ({ status: 404, body: { error: 'Job board not found' } })),
        );
        const r = await fetchBoard(c, 'greenhouse', 'nope', { maxJobs: 10, withDescription: false });
        expect(r.notFound).toBe(true);
    });

    it('limits concurrency per host', async () => {
        const gate = new HostGate(2);
        let active = 0;
        let peak = 0;
        await Promise.all(
            Array.from({ length: 6 }, async () =>
                gate.run('h', async () => {
                    active++;
                    peak = Math.max(peak, active);
                    await new Promise((r) => {
                        setTimeout(r, 10);
                    });
                    active--;
                }),
            ),
        );
        expect(peak).toBe(2);
    });

    it('paces every Personio tenant on one lane', async () => {
        const gate = new HostGate();
        let active = 0;
        let peak = 0;
        const start = Date.now();
        await Promise.all(
            ['a.jobs.personio.de', 'b.jobs.personio.de'].map((host) =>
                gate.run(host, async () => {
                    active++;
                    peak = Math.max(peak, active);
                    await new Promise((r) => {
                        setTimeout(r, 20);
                    });
                    active--;
                }),
            ),
        );
        expect(peak).toBe(1);
        expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
    });

    it('paces each Pinpoint tenant on its own lane and every Gem vanity on api.gem.com', async () => {
        const gate = new HostGate();
        let active = 0;
        let peak = 0;
        const start = Date.now();
        await Promise.all(
            ['a.pinpointhq.com', 'b.pinpointhq.com'].map((host) =>
                gate.run(host, async () => {
                    active++;
                    peak = Math.max(peak, active);
                    await new Promise((r) => {
                        setTimeout(r, 20);
                    });
                    active--;
                }),
            ),
        );
        expect(peak).toBe(2);
        expect(Date.now() - start).toBeLessThan(800);
        const same = new HostGate();
        const serial = Date.now();
        await same.run('acme.pinpointhq.com', async () => undefined);
        await same.run('acme.pinpointhq.com', async () => undefined);
        expect(Date.now() - serial).toBeGreaterThanOrEqual(900);
        const gem = new HostGate();
        let gemPeak = 0;
        let gemActive = 0;
        const gemStart = Date.now();
        await Promise.all(
            [0, 1].map(() =>
                gem.run('api.gem.com', async () => {
                    gemActive++;
                    gemPeak = Math.max(gemPeak, gemActive);
                    await new Promise((r) => {
                        setTimeout(r, 20);
                    });
                    gemActive--;
                }),
            ),
        );
        expect(gemPeak).toBe(1);
        expect(Date.now() - gemStart).toBeGreaterThanOrEqual(900);
    });
});

const PERSONIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>4103</id>
    <subcompany>Acme GmbH</subcompany>
    <office>Munich</office>
    <additionalOffices><office>Remote</office></additionalOffices>
    <department>Management</department>
    <recruitingCategory>Various</recruitingCategory>
    <name>Office Manager</name>
    <jobDescriptions>
      <jobDescription>
        <name>Your mission</name>
        <value><![CDATA[<p>Run the office. Email jobs@acme.test</p>]]></value>
      </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>entry-level</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>lt-1</yearsOfExperience>
    <keywords>office</keywords>
    <createdAt>2016-05-31T12:14:07+0200</createdAt>
  </position>
  <position>
    <id>4104</id>
    <office>Berlin</office>
    <name>Accountant</name>
    <employmentType>intern</employmentType>
    <seniority>student</seniority>
    <schedule>part-time</schedule>
    <keywords>EUR 80000</keywords>
    <createdAt>2016-06-01T00:00:00+00:00</createdAt>
    <salary>
      <min>60.000</min>
      <max>80.000</max>
      <currency>EUR</currency>
      <interval>yearly</interval>
    </salary>
  </position>
  <position>
    <id>4105</id>
    <office>Hamburg</office>
    <name>Designer</name>
    <compensation>€70.000 – €90.000 per year</compensation>
    <createdAt>2016-07-01T00:00:00Z</createdAt>
  </position>
</workzag-jobs>`;

describe('Personio documented XML feed', () => {
    const allow = 'User-agent: *\nAllow: /\n';

    function ioFor(body: string, robots = allow, status = 200) {
        const calls: string[] = [];
        return {
            calls,
            io: {
                robots: async (url: string) => {
                    calls.push(url);
                    return parseRobots(robots);
                },
                get: async (url: string) => {
                    calls.push(url);
                    return { status, body };
                },
            },
        };
    }

    it('reads only /xml for a named account and maps the shared row', async () => {
        const { calls, io } = ioFor(PERSONIO_XML);
        const r = await fetchBoard(new AtsClient(new HostGate()), 'personio', 'Acme', {
            maxJobs: 10,
            withDescription: true,
            personioIo: io,
        });
        expect(calls).toEqual([
            'https://acme.jobs.personio.de/robots.txt',
            'https://acme.jobs.personio.de/xml',
        ]);
        expect(listUrl('personio', 'Acme')).toBe('https://acme.jobs.personio.de/xml');
        expect(detailUrl('personio', 'acme', '4103')).toBeNull();
        expect(r.notFound).toBe(false);
        expect(r.company).toBe('Acme GmbH');
        expect(r.sourceUrl).toBe('https://acme.jobs.personio.de/xml');
        expect(r.requests).toBe(2);
        const office = r.jobs[0];
        expect(office).toMatchObject({
            ats: 'personio',
            board: 'acme',
            company: 'Acme GmbH',
            job_id: '4103',
            title: 'Office Manager',
            department: 'Management',
            team: 'Various',
            locations: ['Munich', 'Remote'],
            remote: true,
            remote_basis: 'text',
            workplace_type: 'remote',
            employment_type: 'Permanent, Full-time, Entry-level',
            compensation: null,
            apply_url: null,
            job_url: null,
            detail_url: null,
            posted_at: '2016-05-31T10:14:07.000Z',
        });
        expect(office.description_text).toContain('Run the office');
        expect(r.jobs[1]).toMatchObject({
            job_id: '4104',
            employment_type: 'Internship, Part-time, Student',
            compensation: { min: 60000, max: 80000, currency: 'EUR', interval: 'year' },
            remote: false,
        });
        expect(r.jobs[1].description_text).toBeNull();
        expect(r.jobs[2].compensation).toMatchObject({ min: 70000, max: 90000, currency: 'EUR', interval: 'year' });
    });

    it('does not fetch /xml when robots.txt disallows it', async () => {
        const { calls, io } = ioFor(PERSONIO_XML, 'User-agent: *\nDisallow: /\n');
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'personio', 'acme', {
                maxJobs: 10,
                withDescription: false,
                personioIo: io,
            }),
        ).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
        expect(calls).toEqual(['https://acme.jobs.personio.de/robots.txt']);
    });

    it('waits out Crawl-delay above the shared gap, capped at 60s', async () => {
        const slept: number[] = [];
        const { io } = ioFor('<workzag-jobs></workzag-jobs>', 'User-agent: *\nCrawl-delay: 10\nAllow: /\n');
        const r = await fetchBoard(new AtsClient(new HostGate()), 'personio', 'acme', {
            maxJobs: 10,
            withDescription: false,
            personioIo: io,
            personioSleep: async (ms) => {
                slept.push(ms);
            },
        });
        expect(slept).toEqual([8500]);
        expect(r.jobs).toEqual([]);
        expect(r.notFound).toBe(false);
        const huge = ioFor('<workzag-jobs/>', 'User-agent: *\nCrawl-delay: 999999\nAllow: /\n');
        await fetchBoard(new AtsClient(new HostGate()), 'personio', 'acme', {
            maxJobs: 10,
            withDescription: false,
            personioIo: huge.io,
            personioSleep: async (ms) => {
                slept.push(ms);
            },
        });
        expect(slept[1]).toBe(58_500);
    });

    it('refuses a DOCTYPE, treats 404 as missing, and stops on an HTML block', async () => {
        const doctype = ioFor('<!DOCTYPE workzag-jobs [<!ENTITY x "y">]><workzag-jobs></workzag-jobs>');
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'personio', 'acme', {
                maxJobs: 5,
                withDescription: false,
                personioIo: doctype.io,
            }),
        ).rejects.toMatchObject({ code: 'ATS_BAD_RESPONSE' });
        const missing = ioFor('', allow, 404);
        const notFound = await fetchBoard(new AtsClient(new HostGate()), 'personio', 'acme', {
            maxJobs: 5,
            withDescription: false,
            personioIo: missing.io,
        });
        expect(notFound.notFound).toBe(true);
        const gate = new HostGate();
        const html = ioFor('<html>captcha</html>');
        await expect(
            fetchBoard(new AtsClient(gate), 'personio', 'acme', {
                maxJobs: 5,
                withDescription: false,
                personioIo: html.io,
            }),
        ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        expect(gate.isKilled('acme.jobs.personio.de')).toBe(true);
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'personio', 'foo.bar', { maxJobs: 1, withDescription: false }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('does not discover Personio accounts from a careers page', async () => {
        const fetched: string[] = [];
        const atsCalls: string[] = [];
        const careers = {
            getPage: async (url: string) => {
                fetched.push(url);
                return {
                    url,
                    status: 200,
                    body: '<a href="https://acme.jobs.personio.de/xml">Jobs</a><a href="https://jobs.lever.co/acme">Lever</a>',
                    contentType: 'text/html',
                };
            },
        };
        const client = new AtsClient(
            new HostGate(),
            fakeFetch((url) => {
                atsCalls.push(url);
                return { status: 404, body: {} };
            }),
        );
        const d = await discoverCompany('https://acme.example', client, careers as never);
        expect(d.boards.map((b) => b.ats)).toEqual(['lever']);
        expect(fetched.some((u) => u.includes('personio'))).toBe(false);
        expect(atsCalls.some((u) => u.includes('personio'))).toBe(false);
        await expect(probePlan(['acme']).some((p) => (p.ats as string) === 'personio')).toBe(false);
        expect(probePlan(['acme']).some((p) => (p.ats as string) === 'pinpoint' || (p.ats as string) === 'gem')).toBe(false);
    });
});

const PINPOINT_JSON = JSON.stringify({
    data: [
        {
            id: '118475',
            title: 'Senior Marketing Designer',
            compensation: '£55,000 - £65,000 / year. Ask pay@acme.example or +1 415-555-0199',
            compensation_minimum: 65000,
            compensation_maximum: 55000,
            compensation_currency: 'gbp',
            compensation_frequency: 'year',
            compensation_visible: true,
            deadline_at: '2026-12-01T00:00:00Z',
            description: '<p>Design the brand. Email jobs@acme.example</p>',
            key_responsibilities: '<p>Own the brand system.</p>',
            reporting_to: 'Jane Doe jane@acme.example',
            employment_type: 'full_time',
            employment_type_text: 'Full Time',
            workplace_type: 'remote',
            url: 'https://acme.pinpointhq.com/en/postings/9447bc5f-30f9-4dbe-8531-3d66df1fc1a5?apply=1',
            job: { id: '130185', department: { id: '191', name: 'Marketing' }, division: { id: '2', name: 'Brand' } },
            location: { id: '5495', name: 'United Kingdom' },
        },
        {
            id: 118476,
            title: 'Office Coordinator',
            compensation_visible: false,
            compensation: 'hidden',
            compensation_minimum: 1,
            employment_type: 'part_time',
            workplace_type: 'hybrid',
            url: 'https://evil.example/postings/1',
            department: { name: 'Ops' },
            location: { name: 'London' },
        },
    ],
});

describe('Pinpoint documented postings.json feed', () => {
    const allow = 'User-agent: *\nAllow: /\n';

    function ioFor(body: string, robots = allow, status = 200) {
        const calls: string[] = [];
        return {
            calls,
            io: {
                robots: async (url: string) => {
                    calls.push(url);
                    return parseRobots(robots);
                },
                get: async (url: string) => {
                    calls.push(url);
                    return { status, body };
                },
            },
        };
    }

    it('reads only /postings.json for a named subdomain and maps the shared row', async () => {
        const { calls, io } = ioFor(PINPOINT_JSON);
        const r = await fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'Acme', {
            maxJobs: 10,
            withDescription: true,
            pinpointIo: io,
        });
        expect(calls).toEqual(['https://acme.pinpointhq.com/robots.txt', 'https://acme.pinpointhq.com/postings.json']);
        expect(listUrl('pinpoint', 'Acme')).toBe('https://acme.pinpointhq.com/postings.json');
        expect(detailUrl('pinpoint', 'acme', '118475')).toBeNull();
        expect(r.notFound).toBe(false);
        expect(r.requests).toBe(2);
        expect(r.sourceUrl).toBe('https://acme.pinpointhq.com/postings.json');
        expect(r.jobs[0]).toMatchObject({
            ats: 'pinpoint',
            board: 'acme',
            job_id: '118475',
            title: 'Senior Marketing Designer',
            department: 'Marketing',
            team: 'Brand',
            locations: ['United Kingdom'],
            countries: ['GB'],
            country_basis: 'text',
            remote: true,
            remote_basis: 'ats',
            workplace_type: 'remote',
            employment_type: 'Full Time',
            compensation: { min: 55000, max: 65000, currency: 'GBP', interval: 'year' },
            posted_at: null,
            apply_url: null,
            job_url: 'https://acme.pinpointhq.com/en/postings/9447bc5f-30f9-4dbe-8531-3d66df1fc1a5',
            detail_url: null,
            description_text: null,
        });
        const dumped = JSON.stringify(r.jobs);
        expect(dumped).not.toContain('jobs@acme.example');
        expect(dumped).not.toContain('pay@acme.example');
        expect(dumped).not.toContain('jane@acme.example');
        expect(dumped).not.toContain('Jane Doe');
        expect(dumped).not.toContain('Design the brand');
        expect(dumped).not.toContain('Own the brand');
        expect(dumped).not.toContain('415-555-0199');
        expect(r.jobs[0].compensation?.summary).toContain('55,000');
        expect(r.jobs[1]).toMatchObject({
            job_id: '118476',
            department: 'Ops',
            compensation: null,
            job_url: null,
            apply_url: null,
            remote: false,
            workplace_type: 'hybrid',
            employment_type: 'Part-time',
            description_text: null,
        });
    });

    it('does not fetch /postings.json when robots.txt disallows it', async () => {
        const { calls, io } = ioFor(PINPOINT_JSON, 'User-agent: *\nDisallow: /\n');
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'acme', {
                maxJobs: 5,
                withDescription: false,
                pinpointIo: io,
            }),
        ).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
        expect(calls).toEqual(['https://acme.pinpointhq.com/robots.txt']);
    });

    it('waits out Crawl-delay above the 1s tenant gap, capped at 60s', async () => {
        const slept: number[] = [];
        const { io } = ioFor('{"data":[]}', 'User-agent: *\nCrawl-delay: 10\nAllow: /\n');
        const r = await fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'acme', {
            maxJobs: 5,
            withDescription: false,
            pinpointIo: io,
            pinpointSleep: async (ms) => {
                slept.push(ms);
            },
        });
        expect(slept).toEqual([9000]);
        expect(r.jobs).toEqual([]);
        expect(r.notFound).toBe(false);
        const huge = ioFor('{"data":[]}', 'User-agent: *\nCrawl-delay: 999999\nAllow: /\n');
        await fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'acme', {
            maxJobs: 5,
            withDescription: false,
            pinpointIo: huge.io,
            pinpointSleep: async (ms) => {
                slept.push(ms);
            },
        });
        expect(slept[1]).toBe(59_000);
    });

    it('treats 404 as missing, stops on HTML, and rejects a bad subdomain', async () => {
        const missing = ioFor('', allow, 404);
        const notFound = await fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'acme', {
            maxJobs: 5,
            withDescription: false,
            pinpointIo: missing.io,
        });
        expect(notFound.notFound).toBe(true);
        const gate = new HostGate();
        const html = ioFor('<html>captcha</html>');
        await expect(
            fetchBoard(new AtsClient(gate), 'pinpoint', 'acme', {
                maxJobs: 5,
                withDescription: false,
                pinpointIo: html.io,
            }),
        ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        expect(gate.isKilled('acme.pinpointhq.com')).toBe(true);
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'pinpoint', 'foo.bar', { maxJobs: 1, withDescription: false }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});

const GEM_JSON = JSON.stringify([
    {
        id: 'am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q',
        title: 'Product Manager',
        content: '<p>Full ad body that must not be copied. jobs@gem.example</p>',
        content_plain: 'Full ad body that must not be copied.',
        first_published_at: '2023-09-22T20:17:34.000Z',
        updated_at: '2025-01-15T22:52:24.609Z',
        departments: [{ id: 'd1', name: 'Engineering' }],
        offices: [{ id: 'o1', name: 'NYC', location: { name: 'New York, United States' } }],
        absolute_url: 'https://jobs.gem.com/acme/am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q?utm=1',
        location: { name: 'New York, United States' },
        location_type: 'hybrid',
        employment_type: 'full_time',
    },
    {
        id: 'second-post',
        title: 'Designer',
        content_plain: 'Another ad',
        location_type: 'remote',
        employment_type: 'contract',
        absolute_url: 'https://evil.example/apply/second-post',
        departments: [{ name: 'Design' }, { name: 'Brand' }],
    },
]);

describe('Gem documented job_posts list', () => {
    function ioFor(body: string, status = 200) {
        const calls: string[] = [];
        return {
            calls,
            io: {
                get: async (url: string) => {
                    calls.push(url);
                    return { status, body };
                },
            },
        };
    }

    it('reads only the named vanity job_posts list and links out instead of copying the ad', async () => {
        const { calls, io } = ioFor(GEM_JSON);
        const r = await fetchBoard(new AtsClient(new HostGate()), 'gem', 'Acme', {
            maxJobs: 10,
            withDescription: true,
            gemIo: io,
        });
        expect(calls).toEqual(['https://api.gem.com/job_board/v0/acme/job_posts/']);
        expect(calls.some((u) => u.includes('departments') || u.includes('offices') || u.includes('applications'))).toBe(
            false,
        );
        expect(listUrl('gem', 'Acme')).toBe('https://api.gem.com/job_board/v0/acme/job_posts/');
        expect(detailUrl('gem', 'acme', 'am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q')).toBeNull();
        expect(r.requests).toBe(1);
        expect(r.jobs[0]).toMatchObject({
            ats: 'gem',
            board: 'acme',
            job_id: 'am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q',
            title: 'Product Manager',
            department: 'Engineering',
            locations: ['New York, United States'],
            countries: ['US'],
            remote: false,
            remote_basis: 'ats',
            workplace_type: 'hybrid',
            employment_type: 'Full-time',
            compensation: null,
            posted_at: '2023-09-22T20:17:34.000Z',
            ats_updated_at: '2025-01-15T22:52:24.609Z',
            apply_url: null,
            job_url: 'https://jobs.gem.com/acme/am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q',
            description_text: null,
            detail_url: null,
        });
        expect(JSON.stringify(r.jobs[0])).not.toContain('Full ad body');
        expect(r.jobs[1]).toMatchObject({
            job_id: 'second-post',
            department: 'Design, Brand',
            remote: true,
            workplace_type: 'remote',
            employment_type: 'Contract',
            description_text: null,
            job_url: 'https://jobs.gem.com/acme/second-post',
            apply_url: null,
        });
    });

    it('treats 404 as missing, stops the shared host on HTML, and rejects a dotted vanity', async () => {
        const missing = ioFor('[]', 404);
        const notFound = await fetchBoard(new AtsClient(new HostGate()), 'gem', 'acme', {
            maxJobs: 5,
            withDescription: true,
            gemIo: missing.io,
        });
        expect(notFound.notFound).toBe(true);
        const gate = new HostGate();
        const html = ioFor('<html>captcha</html>');
        await expect(
            fetchBoard(new AtsClient(gate), 'gem', 'acme', { maxJobs: 5, withDescription: true, gemIo: html.io }),
        ).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        expect(gate.isKilled('api.gem.com')).toBe(true);
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'gem', 'foo.bar', { maxJobs: 1, withDescription: false }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(
            fetchBoard(new AtsClient(new HostGate()), 'gem', 'acme', {
                maxJobs: 1,
                withDescription: false,
                gemIo: ioFor('{"job_posts":[]}').io,
            }),
        ).rejects.toMatchObject({ code: 'ATS_BAD_RESPONSE' });
    });
});

describe('ATS mappers (fields confirmed against live responses 2026-10-17)', () => {
    it('Greenhouse: first_published -> posted_at, escaped HTML content, text remote', () => {
        const j = mapGreenhouse(
            'stripe',
            {
                id: 8172503,
                title: 'Abuse Research Engineer',
                absolute_url: 'https://stripe.com/jobs/search?gh_jid=8172503',
                location: { name: 'Remote from the US' },
                updated_at: '2026-10-07T19:02:27-04:00',
                first_published: '2026-09-09T10:52:09-04:00',
                company_name: 'Stripe',
                content: '&lt;p&gt;Hello &amp;amp; welcome. Email jobs@stripe.com&lt;/p&gt;',
                departments: [{ name: 'Security' }],
            },
            'stripe',
            true,
        );
        expect(j).toMatchObject({
            company: 'Stripe',
            remote: true,
            remote_basis: 'text',
            posted_at: '2026-09-09T14:52:09.000Z',
            department: 'Security',
            countries: ['US'],
            country_basis: 'text',
        });
        expect(j.description_text).toContain('Hello & welcome');
        expect(j.detail_url).toBe('https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172503');
    });

    it('Lever: createdAt, workplaceType, country, salaryRange', () => {
        const j = mapLever(
            'palantir',
            {
                id: 'abc',
                text: 'Forward Deployed Engineer',
                createdAt: 1786469891368,
                country: 'GB',
                workplaceType: 'remote',
                categories: {
                    commitment: 'Full-time',
                    team: 'Dev',
                    location: 'London',
                    allLocations: ['London', 'Remote'],
                },
                salaryRange: { min: 100000, max: 150000, currency: 'GBP', interval: 'per-year-salary' },
                hostedUrl: 'https://jobs.lever.co/palantir/abc',
                applyUrl: 'https://jobs.lever.co/palantir/abc/apply',
            },
            'Palantir',
            false,
        );
        expect(j).toMatchObject({
            remote: true,
            remote_basis: 'ats',
            workplace_type: 'remote',
            countries: ['GB'],
            country_basis: 'ats',
            employment_type: 'Full-time',
        });
        expect(j.posted_at).toBe(new Date(1786469891368).toISOString());
        expect(j.compensation).toMatchObject({ min: 100000, max: 150000, currency: 'GBP' });
    });

    it('Ashby: isRemote, publishedAt, address countries, salary component', () => {
        const j = mapAshby(
            'ramp',
            {
                id: 'x',
                title: ' Security Engineer, Cloud',
                department: 'Engineering',
                employmentType: 'FullTime',
                location: 'New York, NY (HQ)',
                secondaryLocations: [
                    { location: 'Remote (Canada)', address: { postalAddress: { addressCountry: 'Canada' } } },
                ],
                publishedAt: '2026-04-07T17:12:35.753+00:00',
                isRemote: true,
                workplaceType: 'Hybrid',
                address: { postalAddress: { addressCountry: 'USA' } },
                compensation: {
                    compensationTierSummary: '$211.4K – $290.6K',
                    summaryComponents: [
                        {
                            compensationType: 'Salary',
                            interval: '1 YEAR',
                            currencyCode: 'USD',
                            minValue: 211400,
                            maxValue: 290600,
                        },
                    ],
                },
            },
            'Ramp',
            false,
        );
        expect(j).toMatchObject({
            title: 'Security Engineer, Cloud',
            remote: true,
            workplace_type: 'hybrid',
            employment_type: 'Full-time',
            countries: ['US', 'CA'],
            country_basis: 'ats',
        });
        expect(j.compensation?.max).toBe(290600);
        expect(j.detail_url).toBeNull();
    });

    it('SmartRecruiters, Workday, Workable, Recruitee, LinkedIn and Rippling are never contacted', async () => {
        const { ATS_API_HOSTS } = await import('../src/types.js');
        expect(Object.values(ATS_API_HOSTS)).toEqual(['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com']);
        expect(unsupportedAts('https://careers.smartrecruiters.com/BoschGroup')).toBe('careers.smartrecruiters.com');
        expect(unsupportedAts('smartrecruiters:BoschGroup')).toBe('smartrecruiters');
        expect(unsupportedAts('acme.wd5.myworkdayjobs.com')).toBe('acme.wd5.myworkdayjobs.com');
        expect(unsupportedAts('https://ats.rippling.com/acme/jobs')).toBe('ats.rippling.com');
        expect(unsupportedAts('rippling:acme')).toBe('rippling');
        expect(unsupportedAts('https://apply.workable.com/acme')).toBe('apply.workable.com');
        expect(unsupportedAts('https://acme.recruitee.com/')).toBe('acme.recruitee.com');
        expect(unsupportedAts('https://www.linkedin.com/jobs')).toBe('www.linkedin.com');
        expect(unsupportedAts('stripe.com')).toBeNull();
        expect(excludedHost('API.SmartRecruiters.com.')).toBe(true);
        expect(excludedHost('notsmartrecruiters.com')).toBe(false);
        expect(excludedHost('jobs.rippling.com')).toBe(true);
        expect(excludedHost('acme.jobs.personio.de')).toBe(false);
        expect(excludedHost('jobs.personio.de')).toBe(true);
        expect(excludedHost('developer.personio.de')).toBe(true);
        expect(excludedHost('acme.pinpointhq.com')).toBe(false);
        expect(excludedHost('pinpointhq.com')).toBe(true);
        expect(excludedHost('www.pinpointhq.com')).toBe(true);
        expect(excludedHost('api.gem.com')).toBe(false);
        expect(excludedHost('jobs.gem.com')).toBe(true);
        expect(excludedHost('www.gem.com')).toBe(true);
        let calls = 0;
        const c = new AtsClient(
            new HostGate(),
            fakeFetch(() => {
                calls++;
                return { status: 200, body: {} };
            }),
        );
        await expect(c.getJson('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings')).rejects.toThrow();
        const cf = new CareersFetcher(new HostGate());
        await expect(cf.getPage('https://careers.smartrecruiters.com/BoschGroup')).rejects.toMatchObject({
            code: 'UNSUPPORTED_ATS',
        });
        expect(calls).toBe(0);
    });
});

describe('history: first/last seen, change, closed, repost', () => {
    const fps = (jobs: NormalizedJob[]) => new Map(jobs.map((j) => [j.job_id, jobFingerprint(j, 'example.com')]));

    it('baseline run marks everything new', () => {
        const jobs = [job({ job_id: '1' }), job({ job_id: '2', title: 'Designer' })];
        const h = applyHistory(null, 'greenhouse', 'acme', jobs, fps(jobs), NOW, true);
        expect(h.baseline).toBe(true);
        expect(h.counts).toMatchObject({ new: 2, closed: 0 });
    });

    it('detects unchanged, updated, closed and a repost under a new id', () => {
        const day1 = [
            job({ job_id: '1' }),
            job({ job_id: '2', title: 'Designer' }),
            job({ job_id: '3', title: 'Sales Lead' }),
        ];
        const s1 = applyHistory(null, 'greenhouse', 'acme', day1, fps(day1), '2026-10-01T00:00:00.000Z', true).state;
        // day 2: #1 unchanged, #2 retitled (updated), #3 gone, #4 = same role as #3 under a new id
        const day2 = [
            job({ job_id: '1' }),
            job({ job_id: '2', title: 'Senior Designer' }),
            job({ job_id: '4', title: 'Sales Lead' }),
        ];
        const h = applyHistory(s1, 'greenhouse', 'acme', day2, fps(day2), NOW, true);
        expect(h.perJob.get('1')).toMatchObject({ change: 'unchanged', first_seen_at: '2026-10-01T00:00:00.000Z' });
        expect(h.perJob.get('2')?.change).toBe('updated');
        expect(h.closed.map((c) => c.job_id)).toEqual(['3']);
        expect(h.perJob.get('4')).toMatchObject({ change: 'new', repost_of: '3' });
        const row = buildJobRow(day2[2], h.perJob.get('4')!, fps(day2).get('4')!, ctx);
        expect(row).toMatchObject({ reposted: true, stale_signal: 'reposted', repost_of: '3' });
    });

    it('does not close jobs when the fetch was truncated', () => {
        const day1 = [job({ job_id: '1' }), job({ job_id: '2', title: 'X' })];
        const s1 = applyHistory(null, 'greenhouse', 'acme', day1, fps(day1), '2026-10-01T00:00:00.000Z', true).state;
        const h = applyHistory(s1, 'greenhouse', 'acme', [day1[0]], fps(day1), NOW, false);
        expect(h.closed).toHaveLength(0);
        expect(h.state.jobs['2']).toBeDefined();
    });

    it('prunes long-closed jobs', () => {
        const s: BoardState = {
            v: 1,
            ats: 'greenhouse',
            slug: 'acme',
            updated_at: NOW,
            runs: 3,
            jobs: {
                old: {
                    f: '2025-01-01T00:00:00Z',
                    l: '2025-02-01T00:00:00Z',
                    h: 'x',
                    fp: 'y',
                    t: 'Old',
                    c: '2025-02-02T00:00:00Z',
                },
            },
        };
        expect(applyHistory(s, 'greenhouse', 'acme', [], new Map(), NOW, true).state.jobs.old).toBeUndefined();
    });
});

describe('rows, age and long-open', () => {
    it('uses posted_at for age, else first_seen', () => {
        const r1 = buildJobRow(job({ posted_at: '2026-07-01T00:00:00.000Z' }), null, 'fp', ctx);
        expect(r1).toMatchObject({
            age_basis: 'posted_at',
            long_open: true,
            stale_signal: 'long_open',
            verified_open_at: NOW,
            status: 'open',
        });
        const r2 = buildJobRow(job({ posted_at: null }), null, 'fp', ctx);
        expect(r2).toMatchObject({ posted_at: null, age_basis: 'first_seen', age_days: 0, long_open: false });
    });

    it('scrubs e-mails and phone numbers from descriptions', () => {
        const r = buildJobRow(
            job({
                description_text: 'Contact jane.doe@acme.com or +1 415-555-0134. Salary 120,000-150,000. Since 2019.',
            }),
            null,
            'fp',
            ctx,
        );
        expect(r.description_text).not.toContain('jane.doe@acme.com');
        expect(r.description_text).not.toContain('555-0134');
        expect(r.description_text).toContain('120,000-150,000');
        expect(r.description_text).toContain('2019');
    });
});

describe('filters', () => {
    const row = (over: Partial<NormalizedJob> = {}) => buildJobRow(job(over), null, 'fp', ctx);
    const f = (input: Record<string, unknown>) => compileFilters(input).filters;

    it('title include/exclude is whole-word and case-insensitive', () => {
        expect(matches(row(), f({ titleIncludes: ['engineer'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ title: 'Engineering Manager' }), f({ titleIncludes: ['engineer'] }), ctx.nowMs)).toBe(
            false,
        );
        expect(
            matches(
                row({ title: 'Software Engineer Intern' }),
                f({ titleIncludes: ['engineer'], titleExcludes: ['intern'] }),
                ctx.nowMs,
            ),
        ).toBe(false);
    });

    it('location, country, remote, department, company, posted-within', () => {
        expect(matches(row(), f({ locations: ['new york'] }), ctx.nowMs)).toBe(true);
        expect(matches(row(), f({ countries: ['de'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ remote: true }), f({ remote: 'only' }), ctx.nowMs)).toBe(true);
        expect(matches(row(), f({ remote: 'only' }), ctx.nowMs)).toBe(false);
        expect(matches(row({ remote: true }), f({ remote: 'exclude' }), ctx.nowMs)).toBe(false);
        expect(matches(row(), f({ departments: ['engineering'] }), ctx.nowMs)).toBe(true);
        expect(matches(row(), f({ companyFilter: ['globex'] }), ctx.nowMs)).toBe(false);
        expect(matches(row(), f({ postedWithinDays: 3 }), ctx.nowMs)).toBe(false);
        expect(matches(row(), f({ postedWithinDays: 14 }), ctx.nowMs)).toBe(true);
        expect(matches(row({ posted_at: null }), f({ postedWithinDays: 14 }), ctx.nowMs)).toBe(false);
        expect(
            matches(row({ posted_at: null }), f({ postedWithinDays: 14, includeUnknownPostedDate: true }), ctx.nowMs),
        ).toBe(true);
        expect(matches(row({ compensation: null }), f({ hasSalary: true }), ctx.nowMs)).toBe(false);
    });

    it('rejects bad input', () => {
        expect(compileFilters({ titleRegex: '(a+)+$' }).errors).toHaveLength(1);
        expect(compileFilters({ titleRegex: '[' }).errors).toHaveLength(1);
        expect(compileFilters({ countries: ['Germany'] }).errors).toHaveLength(1);
        expect(compileFilters({ titleRegex: '^senior\\b' }).errors).toHaveLength(0);
    });

    it('matches US state codes and names both ways, including FL and Florida', () => {
        expect(matches(row({ locations: ['Tampa, FL'] }), f({ locations: ['FL'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Tampa, FL'] }), f({ locations: ['Florida'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['FL'] }), f({ locations: ['Florida'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Florida'] }), f({ locations: ['fl'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['TAMPA, FL'] }), f({ locations: ['Fl'] }), ctx.nowMs)).toBe(true);
        for (const [code, name] of US_STATE_LOCATION_NAMES) {
            expect(matches(row({ locations: [code.toUpperCase()] }), f({ locations: [name] }), ctx.nowMs)).toBe(true);
            expect(matches(row({ locations: [name] }), f({ locations: [code.toUpperCase()] }), ctx.nowMs)).toBe(true);
            for (const phrase of expandLocationTerm(name).phrases) expect(phrase).not.toBe('or');
            for (const phrase of expandLocationTerm(code).phrases) expect(phrase).not.toBe('or');
        }
    });

    it('matches NYC to New York and other metro aliases', () => {
        expect(matches(row({ locations: ['New York, NY'] }), f({ locations: ['NYC'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['New York, NY'] }), f({ locations: ['nyc'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['NYC'] }), f({ locations: ['New York'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['San Francisco, CA'] }), f({ locations: ['SF'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Bay Area'] }), f({ locations: ['san fran'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Los Angeles, CA'] }), f({ locations: ['LA'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['LA'] }), f({ locations: ['Los Angeles'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Washington, D.C.'] }), f({ locations: ['DC'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['D.C.'] }), f({ locations: ['washington dc'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Philadelphia, PA'] }), f({ locations: ['Philly'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Tampa, FL'] }), f({ locations: ['Tampa Bay'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Tampa Bay, FL'] }), f({ locations: ['Tampa'] }), ctx.nowMs)).toBe(true);
    });

    it('matches a remote location term from the ATS flag, case-insensitively', () => {
        expect(matches(row({ locations: ['Berlin'], remote: true }), f({ locations: ['remote'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Berlin'], remote: true }), f({ locations: ['Remote'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Berlin'], remote: false }), f({ locations: ['remote'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Remote'] }), f({ locations: ['REMOTE'] }), ctx.nowMs)).toBe(true);
    });

    it('does not introduce "or" as a substring alias or over-match short codes', () => {
        expect(expandLocationTerm('oregon').phrases).not.toContain('or');
        expect(expandLocationTerm('Oregon').phrases).not.toContain('or');
        expect(expandLocationTerm('new york').phrases).not.toContain('or');
        expect(expandLocationTerm('portland').phrases).not.toContain('or');
        expect(expandLocationTerm('florida').phrases).not.toContain('or');
        expect(expandLocationTerm('or').phrases).not.toContain('or');
        expect(expandLocationTerm('or').phrases).toContain('oregon');
        expect(expandLocationTerm('oregon').tokens).toContain('or');
        for (const city of LOCATION_METRO_NAMES) {
            expect(expandLocationTerm(city)).toEqual({ phrases: [city], tokens: [] });
        }
        expect(matches(row({ locations: ['New York, NY'] }), f({ locations: ['or'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Florida'] }), f({ locations: ['or'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Portland'] }), f({ locations: ['or'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Portland'] }), f({ locations: ['Oregon'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Portland, OR'] }), f({ locations: ['Oregon'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Portland, OR'] }), f({ locations: ['or'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Arkansas'] }), f({ locations: ['Kansas'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Kansas City, KS'] }), f({ locations: ['Kansas'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Dallas, TX'] }), f({ locations: ['LA'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Berlin'] }), f({ locations: ['IN'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Canada'] }), f({ locations: ['CA'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Baja California'] }), f({ locations: ['California'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['West Virginia'] }), f({ locations: ['Virginia'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Richmond, VA'] }), f({ locations: ['Virginia'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['New York, NY'] }), f({ locations: ['FL'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Berlin, Germany'] }), f({ locations: ['berlin'] }), ctx.nowMs)).toBe(true);
    });

    it('matches Baltimore, Baltimore MD and BWI to each other, and MD to Maryland', () => {
        expect(matches(row({ locations: ['Baltimore, MD'] }), f({ locations: ['Baltimore'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Baltimore, MD'] }), f({ locations: ['Baltimore MD'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Baltimore, MD'] }), f({ locations: ['BWI'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['BWI'] }), f({ locations: ['Baltimore'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Baltimore, MD'] }), f({ locations: ['MD'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Baltimore, MD'] }), f({ locations: ['Maryland'] }), ctx.nowMs)).toBe(true);
        expect(matches(row({ locations: ['Annapolis, MD'] }), f({ locations: ['Baltimore'] }), ctx.nowMs)).toBe(false);
        expect(matches(row({ locations: ['Annapolis, MD'] }), f({ locations: ['Maryland'] }), ctx.nowMs)).toBe(true);
    });

    it('matches a description keyword on the body or the title, whole word', () => {
        const tech = row({
            title: 'Electrical Technician',
            locations: ['Baltimore, MD'],
            description_text: 'Supports avionics integration on the flight line.',
        });
        expect(matches(tech, f({ descriptionIncludes: ['avionics'] }), ctx.nowMs)).toBe(true);
        expect(matches(tech, f({ descriptionIncludes: ['Avionics'] }), ctx.nowMs)).toBe(true);
        expect(matches(tech, f({ titleIncludes: ['avionics'] }), ctx.nowMs)).toBe(false);
        expect(matches(tech, f({ descriptionIncludes: ['avionicsengineering'] }), ctx.nowMs)).toBe(false);
        expect(
            matches(row({ title: 'Avionics Technician', description_text: null }), f({ descriptionIncludes: ['avionics'] }), ctx.nowMs),
        ).toBe(true);
        expect(
            matches(
                tech,
                f({ titleIncludes: ['avionics'], descriptionIncludes: ['avionics'] }),
                ctx.nowMs,
            ),
        ).toBe(false);
    });

    it('empty-result suggestions use real scanned rows only', () => {
        const tech = row({
            title: 'Electrical Technician',
            locations: ['Baltimore, MD'],
            description_text: 'Supports avionics integration on the flight line.',
        });
        const other = row({
            job_id: '2',
            title: 'Integration Engineer',
            locations: ['Annapolis, MD'],
            description_text: 'Wiring harness.',
        });
        const filters = f({ locations: ['Baltimore'], descriptionIncludes: ['radar'] });
        expect(matches(tech, filters, ctx.nowMs)).toBe(false);
        const hints = emptySearchSuggestions([tech, other], filters, ctx.nowMs);
        expect(hints.note).toBe(STARTER_LIST_COVERAGE_NOTE);
        expect(hints.note).toContain('Greenhouse, Lever and Ashby');
        expect(hints.note).toContain('not every employer');
        expect(hints.description_tokens_tried).toEqual(['radar']);
        expect(hints.title_tokens_tried).toEqual([]);
        expect(hints.sample_open_titles).toEqual(['Electrical Technician']);
        expect(hints.sample_open_titles).not.toContain('Integration Engineer');
        const aliases = Object.fromEntries(hints.place_aliases_with_hits.map((h) => [h.alias, h.jobs]));
        expect(aliases.baltimore).toBe(1);
        expect(aliases.md).toBeGreaterThan(0);
        expect(hints.place_aliases_with_hits.every((h) => h.jobs > 0)).toBe(true);
    });
});

describe('registry description length', () => {
    it('stays within 100 characters', () => {
        const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as { description: string };
        expect(server.description.length).toBeLessThanOrEqual(100);
    });
});

describe('dedupe', () => {
    it('role mode merges one role listed per city; tracker marks cross-board duplicates', () => {
        const a = buildJobRow(job({ job_id: '1', locations: ['Berlin'] }), null, 'fa', ctx);
        const b = buildJobRow(job({ job_id: '2', locations: ['Munich'] }), null, 'fb', ctx);
        const merged = mergeRoles([a, b]);
        expect(merged).toHaveLength(1);
        expect(merged[0].locations).toEqual(['Berlin', 'Munich']);
        expect(merged[0].merged_job_ids).toEqual(['2']);

        const t = new DuplicateTracker();
        const x = { ...a, job_key: 'greenhouse:acme:1', fingerprint: 'same' };
        const y = { ...a, job_key: 'ashby:acme:9', ats: 'ashby' as const, fingerprint: 'same' };
        t.register([x]);
        t.register([y]);
        expect(t.annotate(y)).toMatchObject({ duplicate_of: 'greenhouse:acme:1', duplicate_group: 'same' });
        expect(t.multiGroups()).toEqual({ same: ['greenhouse:acme:1', 'ashby:acme:9'] });
    });
});

describe('text helpers', () => {
    it('robots.txt longest-match', () => {
        const r = parseRobots(
            'User-agent: *\nDisallow: /\nUser-agent: FairqueryJobsFeed\nAllow: /careers\nDisallow: /',
        );
        expect(isAllowed(r, 'FairqueryJobsFeed', '/careers')).toBe(true);
        expect(isAllowed(r, 'FairqueryJobsFeed', '/admin')).toBe(false);
        expect(isAllowed(parseRobots('User-agent: *\nDisallow: /api/'), 'FairqueryJobsFeed', '/jobs')).toBe(true);
        const delayed = parseRobots('User-agent: *\nCrawl-delay: 10\nAllow: /\n');
        expect(crawlDelayMs(delayed, 'FairqueryJobsFeed')).toBe(10_000);
        expect(isAllowed(delayed, 'FairqueryJobsFeed', '/xml')).toBe(true);
        expect(isAllowed(parseRobots('User-agent: *\nDisallow: /xml\n'), 'FairqueryJobsFeed', '/xml')).toBe(false);
    });

    it('gazetteer and normalizers', () => {
        expect(countriesFromText(['Baltimore'])).toEqual(['US']);
        expect(countriesFromText(['Austin, TX'])).toEqual(['US']);
        expect(countriesFromText(['Springfield, IL'])).toEqual(['US']);
        expect(countriesFromText(['Bengaluru, India'])).toEqual(['IN']);
        expect(countriesFromText(['London'])).toEqual(['GB']);
        expect(countryToIso2('USA')).toBe('US');
        expect(countryToIso2('de')).toBe('DE');
        expect(wordMatch('Sr. Software Engineer', 'software engineer')).toBe(true);
        expect(normTitle('Software Engineer (Req 12345)')).toBe('software engineer');
        expect(htmlToText('<p>A</p><ul><li>B</li></ul>')).toBe('A\n\n• B');
        expect(htmlToText('Avionics &amp; Electronics')).toBe('Avionics & Electronics');
        expect(htmlToText('Avionics &#x26; Electronics')).toBe('Avionics & Electronics');
        expect(htmlToText('Avionics &#38; Electronics')).toBe('Avionics & Electronics');
        expect(scrubPII('mail a@b.co').redactions).toBe(1);
    });
});

describe('prettySlug', () => {
    it('title-cases lowercase slugs and keeps mixed case', async () => {
        const { prettySlug } = await import('../src/normalize.js');
        expect(prettySlug('sentry')).toBe('Sentry');
        expect(prettySlug('scale-ai')).toBe('Scale Ai');
        expect(prettySlug('OpenAI')).toBe('OpenAI');
    });
});

describe('dataset schema accepts every row shape (trackChanges on and off)', () => {
    const ds = JSON.parse(readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv({ strict: false, allErrors: true }).compile(ds.fields);
    const ok = (row: unknown) => {
        const valid = validate(row);
        expect(validate.errors ?? [], JSON.stringify(row)).toEqual([]);
        expect(valid).toBe(true);
    };
    const boardBase = {
        ref: { ats: 'greenhouse' as const, slug: 'acme', discovered_via: 'input' as BoardRef['discovered_via'] },
        company: 'Acme',
        domain: 'example.com',
        sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
        nowIso: NOW,
        total: 3,
        matched: 2,
        emitted: 2,
        complete: true,
        requests: 1,
    };

    it('trackChanges false: board counts are null (not tracked) and the row validates', () => {
        const row = buildBoardRow({ ...boardBase, counts: null });
        expect(row.reposted).toBeNull();
        expect(row.new).toBeNull();
        ok(row);
        ok(buildJobRow(job(), null, 'fp', ctx));
    });

    it('trackChanges true: board counts are integers, job reposted is boolean, closed rows validate', () => {
        const day1 = [job({ job_id: 'a' }), job({ job_id: 'b', title: 'Designer' })];
        const fp = (js: NormalizedJob[]) => new Map(js.map((j) => [j.job_id, jobFingerprint(j, 'example.com')]));
        const s1 = applyHistory(null, 'greenhouse', 'acme', day1, fp(day1), '2026-10-01T00:00:00.000Z', true).state;
        const h = applyHistory(s1, 'greenhouse', 'acme', [day1[0]], fp(day1), NOW, true);
        const row = buildBoardRow({ ...boardBase, counts: h.counts });
        expect(typeof row.reposted).toBe('number');
        ok(row);
        ok(buildJobRow(day1[0], h.perJob.get('a') ?? null, 'fp', ctx));
        for (const c of h.closed) ok(buildClosedRow(c, { ats: 'greenhouse', board: 'acme', company: 'Acme' }, ctx));
        expect(h.closed.length).toBe(1);
    });
});

describe('jobs_search_by_location scan', () => {
    const filters = (input: Record<string, unknown>) => compileFilters(input).filters;
    const board = (ats: SeedBoard['ats'], slug: string): SeedBoard => ({
        company: slug,
        domain: `${slug}.example`,
        ats,
        slug,
        verified_at: '2026-10-27',
        verified_by: 'test',
        jobs_at_verification: 1,
    });
    const ghJob = (id: number, title: string, location: string, content?: string) => ({
        id,
        title,
        location: { name: location },
        absolute_url: `https://example.com/j/${id}`,
        company_name: 'Acme',
        first_published: '2026-10-01T00:00:00.000Z',
        ...(content ? { content } : {}),
    });
    function chunked(text: string, status: number, chunk: number): Response {
        const bytes = new TextEncoder().encode(text);
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.slice(offset, offset + chunk));
                offset += chunk;
            },
        });
        return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
    }
    const clientFor = (fetchImpl: typeof fetch) => new AtsClient(new HostGate(), fetchImpl);
    const scan = (args: Omit<Parameters<typeof scanSeedByLocation>[0], 'nowIso' | 'nowMs' | 'longOpenDays'>) =>
        scanSeedByLocation({ ...args, nowIso: NOW, nowMs: Date.parse(NOW), longOpenDays: 60 });

    it('walks a jobs array in small chunks, including braces and quotes inside strings', async () => {
        const text = '{"meta":{"n":1},"jobs":[{"title":"A \\"x\\" {","ok":true},{"title":"B"}]}';
        const bytes = new TextEncoder().encode(text);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const b of bytes) controller.enqueue(new Uint8Array([b]));
                controller.close();
            },
        });
        const items: unknown[] = [];
        const scanResult = await iterateJsonArray(
            stream,
            { arrayKey: 'jobs', maxStringChars: 1000, maxElementChars: 100_000 },
            (json) => {
                items.push(JSON.parse(json));
            },
        );
        expect(scanResult.foundArray).toBe(true);
        expect(scanResult.complete).toBe(true);
        expect(items).toEqual([
            { title: 'A "x" {', ok: true },
            { title: 'B' },
        ]);
    });

    it('cuts a multi-megabyte string instead of retaining the board body', async () => {
        const text = `{"jobs":[{"id":1,"content":"${'y'.repeat(2_000_000)}"}]}`;
        const bytes = new TextEncoder().encode(text);
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.slice(offset, offset + 4096));
                offset += 4096;
            },
        });
        let content = '';
        const scanResult = await iterateJsonArray(
            stream,
            { arrayKey: 'jobs', maxStringChars: 1000, maxElementChars: 100_000 },
            (json) => {
                content = (JSON.parse(json) as { content: string }).content;
            },
        );
        expect(scanResult.bytes).toBeGreaterThan(2_000_000);
        expect(scanResult.maxBufferChars).toBeLessThan(250_000);
        expect(content.length).toBeLessThanOrEqual(1000);
        expect(scanResult.truncatedStrings).toBe(1);
    });

    it('does not buffer or download Greenhouse content=true for a place scan', async () => {
        const calls: string[] = [];
        const fat = JSON.stringify({
            jobs: [ghJob(1, 'Technician', 'Allentown, PA', `<p>avionics</p>${'x'.repeat(2_000_000)}`)],
        });
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            if (u.includes('content=true')) return chunked('{"jobs":[]}', 500, 100);
            return chunked(fat, 200, 2048);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
        });
        expect(calls.some((u) => u.includes('content=true'))).toBe(false);
        expect(result.bytes).toBeGreaterThan(2_000_000);
        expect(result.maxBufferChars).toBeLessThan(250_000);
        expect(result.meta.partial).toBe(false);
        expect(result.meta.complete).toBe(true);
        expect(result.meta.notice).toContain('Indexed Jobs search is COMING SOON');
        expect(result.meta.notice).toContain('Indexed search covers 8,700+ boards');
        expect(result.meta.notice).toContain("Get 8,700+ boards free with Apify's $5 starter credit");
        expect(result.meta.notice).toContain('https://console.apify.com/settings/integrations');
        expect(result.meta.notice.startsWith('Scanned')).toBe(false);
        expect(result.meta.notes[0]).toBe(result.meta.notice);
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows[0]?.title).toBe('Technician');
        expect(result.rows[0]?.locations.join(' ')).toContain('Allentown');
        expect(result.meta.suggestions).toBeUndefined();
    });

    it('reads Greenhouse bodies only after a place hit when the description is required', async () => {
        const calls: string[] = [];
        const lite = JSON.stringify({ jobs: [ghJob(1, 'Electrical Technician', 'Allentown, PA')] });
        const full = JSON.stringify({
            jobs: [ghJob(1, 'Electrical Technician', 'Allentown, PA', '<p>Daily avionics work on the line.</p>')],
        });
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            return chunked(u.includes('content=true') ? full : lite, 200, 64);
        }) as typeof fetch;
        const missed = await scan({
            boards: [board('greenhouse', 'acme')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Allentown'], descriptionIncludes: ['radar'] }),
            returnDescription: false,
        });
        expect(missed.meta.jobs_matched).toBe(0);
        expect(missed.meta.suggestions?.description_tokens_tried).toEqual(['radar']);
        expect(missed.meta.suggestions?.sample_open_titles).toContain('Electrical Technician');
        expect(missed.meta.suggestions?.note).toContain('not every employer');
        expect(missed.meta.suggestions?.note).toBe(STARTER_LIST_COVERAGE_NOTE);
        const before = calls.length;
        const hit = await scan({
            boards: [board('greenhouse', 'acme')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Allentown'], descriptionIncludes: ['avionics'] }),
            returnDescription: true,
        });
        const extra = calls.slice(before);
        expect(extra.filter((u) => u.includes('content=true'))).toHaveLength(1);
        expect(hit.meta.jobs_matched).toBe(1);
        expect(hit.rows[0]?.description_text).toContain('avionics');
        expect(hit.rows[0]?.description_text).not.toMatch(/@/);
    });

    it('returns the jobs already matched when the time budget runs out', async () => {
        let now = 1_000;
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            now += 20;
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '';
            const location = slug === 'b' ? 'Austin, TX' : 'Allentown, PA';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, location)] }), 200, 128);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'a'), board('greenhouse', 'b'), board('greenhouse', 'c')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            budgetMs: 30,
            concurrency: 1,
            clock: { now: () => now },
        });
        expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['a', 'b']);
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('time_budget');
        expect(result.meta.boards_skipped).toBe(1);
        expect(result.meta.boards_scanned).toBe(2);
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows[0]?.title).toBe('Role a');
        expect(result.meta.notes.join('\n')).toContain('time_budget');
        expect(result.meta.notes.join('\n')).toContain('nothing was invented');
        expect(result.meta.notice).toBe(
            `Scanned 2 of 3 boards; the upcoming indexed search covers 8,700+ boards. ${result.meta.notes[0].slice(result.meta.notes[0].indexOf('Indexed Jobs search'))}`,
        );
        expect(result.meta.notes[0]).toBe(result.meta.notice);
        expect(result.meta.notice.startsWith('Scanned 2 of 3 boards; the upcoming indexed search covers 8,700+ boards.')).toBe(true);
        expect(result.meta.complete).toBe(false);
        expect(result.meta.cut).toBe(true);
        expect(result.meta.boards_reached).toBe(2);
        expect(result.meta.next_board_cursor).toBe(2);
        expect(result.meta.board_cursor).toBe(0);
    });

    it('returns the jobs already matched when the CPU budget runs out', async () => {
        const cpu = { ms: 0 };
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            cpu.ms += 5_000;
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '';
            const location = slug === 'b' ? 'Austin, TX' : 'Allentown, PA';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, location)] }), 200, 128);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'a'), board('greenhouse', 'b'), board('greenhouse', 'c')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            cpu,
            cpuBudgetMs: 8_000,
            concurrency: 1,
        });
        expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['a', 'b']);
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('cpu_budget');
        expect(result.meta.boards_skipped).toBe(1);
        expect(result.meta.boards_scanned).toBe(2);
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows[0]?.title).toBe('Role a');
        expect(result.rows.some((row) => row.title === 'Role c')).toBe(false);
        expect(result.meta.notes.join('\n')).toContain('cpu_budget');
        expect(result.meta.notes.join('\n')).toContain('nothing was invented');
        expect(result.meta.boards_reached).toBe(2);
        expect(result.meta.next_board_cursor).toBe(2);
    });

    it('keeps a hard CPU and request ceiling under the Paid Worker limits', () => {
        expect(LOCATION_SCAN_BUDGET_MS).toBe(25_000);
        expect(LOCATION_SCAN_BOARD_MAX_BYTES).toBe(3_000_000);
        // 12 s of charged work. Still a ceiling: one call does not run unbounded on Paid CPU.
        // 8,000 characters each. Soft-stop stays under the Paid ~30 s CPU default.
        expect(LOCATION_SCAN_CPU_BUDGET_MS).toBe(12_000);
        expect(LOCATION_SCAN_CPU_BUDGET_MS).toBeGreaterThan(1_000);
        expect(LOCATION_SCAN_CPU_BUDGET_MS).toBeGreaterThanOrEqual(8_000);
        expect(LOCATION_SCAN_CPU_BUDGET_MS).toBeLessThanOrEqual(15_000);
        expect(LOCATION_SCAN_CPU_BYTES_PER_MS).toBe(8_000);
        expect(LOCATION_SCAN_CPU_BUDGET_MS * LOCATION_SCAN_CPU_BYTES_PER_MS).toBe(96_000_000);
        expect(LOCATION_SCAN_ROW_CPU_MS).toBeGreaterThan(0);
        expect(LOCATION_SCAN_ROW_CPU_MS).toBeLessThan(0.2);
        expect(LOCATION_SCAN_MATCHED_ROW_CAP).toBe(200);
        expect(LOCATION_SCAN_HOSTED_BODY_MAX_JOBS).toBe(1_000);
        // Above the Free-plan cap of 36, enough for 135 lite lists + 88 small Greenhouse bodies, under Paid's 10,000.
        expect(LOCATION_SCAN_MAX_REQUESTS).toBe(300);
        expect(LOCATION_SCAN_MAX_REQUESTS).toBeGreaterThan(36);
        expect(LOCATION_SCAN_MAX_REQUESTS).toBeGreaterThanOrEqual(200);
        expect(LOCATION_SCAN_MAX_REQUESTS).toBeLessThanOrEqual(400);
        expect(LOCATION_SCAN_MAX_REQUESTS).toBeGreaterThanOrEqual(135 + 88);
        expect(LOCATION_SCAN_MAX_REQUESTS).toBeLessThan(10_000);
        // Place-scan pool only. The Actor board pool stays at BOARD_CONCURRENCY.
        expect(HOST_CONCURRENCY).toBe(2);
        expect(BOARD_CONCURRENCY).toBe(6);
        expect(LOCATION_SCAN_CONCURRENCY).toBe(4);
        expect(LOCATION_SCAN_CONCURRENCY).toBeLessThan(BOARD_CONCURRENCY);
        expect(LOCATION_SCAN_MAX_ATTEMPTS).toBe(2);
        expect(LOCATION_SCAN_RETRY_DELAY_MS).toBeGreaterThanOrEqual(200);
        expect(LOCATION_SCAN_RETRY_DELAY_MS).toBeLessThanOrEqual(500);
    });

    it('default budgets pass starter index 32 and keep a large board title-only', async () => {
        const jobs = [
            {
                ...ghJob(1, 'Avionics Technician', 'Costa Mesa, CA'),
                departments: [{ name: 'Flight Systems' }],
            },
        ];
        for (let i = 0; i < LOCATION_SCAN_HOSTED_BODY_MAX_JOBS; i++) jobs.push(ghJob(i + 2, `Other ${i}`, 'Austin, TX'));
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            if (u.includes('content=true')) return chunked('{"jobs":[]}', 500, 64);
            if (u.includes('/boards/andurilindustries/')) return chunked(JSON.stringify({ jobs }), 200, 4096);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? 'x';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Austin, TX')] }), 200, 64);
        }) as typeof fetch;
        const boards = Array.from({ length: 40 }, (_, i) => board('greenhouse', i === 32 ? 'andurilindustries' : `b${i}`));
        const result = await scan({
            boards,
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'], descriptionIncludes: ['avionics'] }),
            returnDescription: true,
            hostedFree: true,
            concurrency: 6,
        });
        expect(calls.some((u) => u.includes('/boards/andurilindustries/'))).toBe(true);
        expect(calls.some((u) => u.includes('content=true'))).toBe(false);
        expect(result.meta.title_only_boards).toEqual(['greenhouse/andurilindustries']);
        expect(result.rows.map((row) => row.title)).toEqual(['Avionics Technician']);
        expect(result.meta.partial).toBe(false);
        expect(result.meta.complete).toBe(true);
        expect(result.meta.stop_reason).toBeUndefined();
        expect(result.meta.boards_reached).toBe(40);
        expect(result.meta.board_cursor).toBe(0);
        expect(result.meta.next_board_cursor).toBeNull();
    });

    it('returns partial JSON under a tight work budget while the Workers clock is frozen', async () => {
        const frozen = vi.spyOn(performance, 'now').mockReturnValue(10_000);
        try {
            const jobs = [ghJob(1, 'Early PA role', 'Allentown, PA')];
            for (let i = 0; i < 2_500; i++) jobs.push({ ...ghJob(i + 2, `Other ${i}`, 'Austin, TX'), pad: 'p'.repeat(180) });
            jobs.push(ghJob(9_999, 'Tail PA role', 'Pittsburgh, PA'));
            const body = JSON.stringify({ jobs });
            const calls: string[] = [];
            const fetchImpl = (async (url: string | URL) => {
                const u = String(url);
                calls.push(u);
                if (u.includes('/boards/big/')) return chunked(body, 200, 4_096);
                return chunked(JSON.stringify({ jobs: [ghJob(7, 'Later board', 'Harrisburg, PA')] }), 200, 128);
            }) as typeof fetch;
            const result = await scan({
                boards: [board('greenhouse', 'big'), board('greenhouse', 'later')],
                client: clientFor(fetchImpl),
                filters: filters({ locations: ['PA'] }),
                returnDescription: false,
                cpuBudgetMs: 30,
                concurrency: 1,
            });
            expect(performance.now()).toBe(10_000);
            expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['big']);
            expect(result.meta.partial).toBe(true);
            expect(result.meta.stop_reason).toBe('cpu_budget');
            expect(result.rows.map((row) => row.title)).toContain('Early PA role');
            expect(result.rows.some((row) => row.title === 'Tail PA role' || row.title === 'Later board')).toBe(false);
            expect(result.bytes).toBeGreaterThan(0);
            expect(result.bytes).toBeLessThan(body.length);
            expect(result.meta.boards_skipped).toBe(1);
            expect(result.meta.notes.join('\n')).toContain('cpu_budget');
            expect(result.meta.notes.join('\n')).toContain('nothing was invented');
        } finally {
            frozen.mockRestore();
        }
    });

    it('cuts a heavy board and still returns later boards', async () => {
        const jobs = [1, 2, 3].map((n) => ({ ...ghJob(n, `Role ${n}`, n === 1 ? 'Allentown, PA' : 'Austin, TX'), pad: 'x'.repeat(400) }));
        const firstDoc = JSON.stringify({ jobs: [jobs[0]] });
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            if (u.includes('/boards/big/')) return chunked(JSON.stringify({ jobs }), 200, 64);
            return chunked(JSON.stringify({ jobs: [ghJob(9, 'Later role', 'Pittsburgh, PA')] }), 200, 64);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'big'), board('greenhouse', 'later')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            boardMaxBytes: firstDoc.length - 2,
            concurrency: 1,
        });
        expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['big', 'later']);
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('cpu_budget');
        expect(result.rows.map((row) => row.title)).toEqual(['Role 1', 'Later role']);
        expect(result.meta.notes.join('\n')).toContain('heavy board');
        expect(result.meta.notes.join('\n')).toContain('nothing was invented');
        expect(result.meta.boards_ok).toBe(2);
    });

    it('matches a description keyword from a short excerpt and does not keep the Lever body', async () => {
        const description = `${'z'.repeat(50_000)} avionics ${'q'.repeat(50_000)}`;
        const body = JSON.stringify([
            {
                id: 'lev-1',
                text: 'Technician',
                categories: { location: 'Allentown, PA', allLocations: ['Allentown, PA'] },
                hostedUrl: 'https://jobs.lever.co/acme/lev-1',
                createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
                descriptionPlain: description,
            },
        ]);
        const fetchImpl = (async () => chunked(body, 200, 1024)) as typeof fetch;
        const result = await scan({
            boards: [board('lever', 'acme')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'], descriptionIncludes: ['avionics'] }),
            returnDescription: false,
        });
        expect(result.meta.partial).toBe(false);
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows[0]?.title).toBe('Technician');
        expect(result.rows[0]?.description_text).toBeNull();
        expect(result.maxBufferChars).toBeLessThan(250_000);
        expect(result.bytes).toBeGreaterThan(100_000);
        const short = JSON.stringify([
            {
                id: 'lev-1',
                text: 'Technician',
                categories: { location: 'Allentown, PA', allLocations: ['Allentown, PA'] },
                hostedUrl: 'https://jobs.lever.co/acme/lev-1',
                createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
                descriptionPlain: 'Daily avionics work on the line.',
            },
        ]);
        const kept = await scan({
            boards: [board('lever', 'acme')],
            client: clientFor((async () => chunked(short, 200, 64)) as typeof fetch),
            filters: filters({ locations: ['PA'], descriptionIncludes: ['avionics'] }),
            returnDescription: true,
        });
        expect(kept.meta.jobs_matched).toBe(1);
        expect(kept.rows[0]?.description_text).toContain('avionics');
    });

    it('keeps jobs from other hosts when one board answers 403', async () => {
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            if (u.includes('api.lever.co')) {
                return chunked(
                    JSON.stringify([
                        {
                            id: 'lev-1',
                            text: 'Avionics Technician',
                            categories: { location: 'Pittsburgh, PA', allLocations: ['Pittsburgh, PA'] },
                            hostedUrl: 'https://jobs.lever.co/good/lev-1',
                            createdAt: Date.parse('2026-10-01T00:00:00.000Z'),
                        },
                    ]),
                    200,
                    128,
                );
            }
            if (u.includes('/boards/bad/')) return new Response('no', { status: 403 });
            return new Response('', { status: 404 });
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'bad'), board('lever', 'good')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(result.meta.partial).toBe(false);
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows[0]?.title).toBe('Avionics Technician');
        expect(result.rows[0]?.ats).toBe('lever');
        expect(result.meta.notes.some((n) => n.startsWith('HOST_BLOCKED'))).toBe(true);
        expect(result.meta.boards_ok).toBe(1);
        expect(result.meta.boards_failed).toBe(1);
    });

    it('keeps Greenhouse title matches when the body request throws after the budget', async () => {
        const cpu = { ms: 0 };
        const lite = JSON.stringify({
            jobs: [
                {
                    ...ghJob(1, 'Avionics Technician', 'Costa Mesa, CA'),
                    departments: [{ name: 'Flight Systems' }],
                },
                ghJob(2, 'Buyer', 'Costa Mesa, CA'),
            ],
        });
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            if (u.includes('content=true')) {
                cpu.ms = 5_000;
                throw new Error('body read failed after the budget');
            }
            return chunked(lite, 200, 64);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'], descriptionIncludes: ['avionics'] }),
            returnDescription: true,
            cpu,
            cpuBudgetMs: 1_000,
            concurrency: 1,
        });
        expect(calls.some((u) => u.includes('content=true'))).toBe(true);
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('cpu_budget');
        expect(result.meta.jobs_matched).toBe(1);
        expect(result.rows.map((row) => row.title)).toEqual(['Avionics Technician']);
        expect(result.rows.some((row) => row.title === 'Buyer')).toBe(false);
    });

    it('returns partial JSON instead of throwing when an empty keyword matches many rows', async () => {
        const jobs = [];
        for (let i = 0; i < 250; i++) jobs.push(ghJob(i + 1, `Role ${i}`, 'Allentown, PA'));
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            calls.push(String(url));
            return chunked(JSON.stringify({ jobs }), 200, 1024);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'bigpa'), board('greenhouse', 'later')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('row_cap');
        expect(result.meta.complete).toBe(false);
        expect(result.meta.cut).toBe(true);
        expect(result.rows).toHaveLength(LOCATION_SCAN_MATCHED_ROW_CAP);
        expect(result.meta.jobs_matched).toBe(LOCATION_SCAN_MATCHED_ROW_CAP);
        expect(result.rows[0]?.title).toBe('Role 0');
        expect(result.meta.next_board_cursor).toBe(1);
        expect(calls).toHaveLength(1);
        expect(result.meta.notes.join('\n')).toContain('row_cap');
        expect(result.meta.notes.join('\n')).toContain('nothing was invented');
    });

    it('matches title and department on the lite list and skips the body for a large hosted board', async () => {
        const jobs = [
            {
                ...ghJob(1, 'Avionics Technician', 'Costa Mesa, CA'),
                departments: [{ name: 'Flight Systems' }],
            },
            {
                ...ghJob(2, 'Buyer', 'Costa Mesa, CA'),
                departments: [{ name: 'Avionics' }],
            },
        ];
        for (let i = 0; i < LOCATION_SCAN_HOSTED_BODY_MAX_JOBS; i++) jobs.push(ghJob(i + 3, `Other ${i}`, 'Austin, TX'));
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            if (u.includes('content=true')) return chunked('{"jobs":[]}', 500, 64);
            return chunked(JSON.stringify({ jobs }), 200, 2048);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'], descriptionIncludes: ['avionics'] }),
            returnDescription: true,
            hostedFree: true,
            concurrency: 1,
        });
        expect(calls.some((u) => u.includes('content=true'))).toBe(false);
        expect(result.rows.map((row) => row.title).sort()).toEqual(['Avionics Technician', 'Buyer']);
        expect(result.meta.title_only_boards).toEqual(['greenhouse/andurilindustries']);
        expect(result.meta.partial).toBe(false);
        expect(result.meta.complete).toBe(true);
        expect(result.meta.cut).toBe(true);
        expect(result.meta.jobs_matched).toBe(2);
    });

    it('continues at boardCursor instead of re-scanning earlier boards', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Allentown, PA')] }), 200, 128);
        }) as typeof fetch;
        const boards = [board('greenhouse', 'a'), board('greenhouse', 'b'), board('greenhouse', 'c')];
        const result = await scan({
            boards,
            boardCursor: 1,
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['b', 'c']);
        expect(result.rows.map((row) => row.title)).toEqual(['Role b', 'Role c']);
        expect(result.meta.board_cursor).toBe(1);
        expect(result.meta.next_board_cursor).toBeNull();
        expect(result.meta.complete).toBe(true);
        expect(result.meta.partial).toBe(false);
        expect(result.meta.cut).toBe(false);
        expect(result.meta.boards_reached).toBe(2);
        expect(result.meta.boards_total).toBe(3);
        expect(result.meta.boards_skipped).toBe(0);
    });

    it('returns partial JSON at the hosted subrequest cap instead of starting another board', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? 'x';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Austin, TX')] }), 200, 64);
        }) as typeof fetch;
        const boards = Array.from({ length: LOCATION_SCAN_MAX_REQUESTS + 4 }, (_, i) => board('greenhouse', `b${i}`));
        const result = await scan({
            boards,
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            hostedFree: true,
            concurrency: 1,
        });
        expect(calls).toHaveLength(LOCATION_SCAN_MAX_REQUESTS);
        expect(calls.some((u) => u.includes('content=true'))).toBe(false);
        expect(result.meta.partial).toBe(true);
        expect(result.meta.stop_reason).toBe('subrequest_budget');
        expect(result.meta.complete).toBe(false);
        expect(result.meta.next_board_cursor).toBe(LOCATION_SCAN_MAX_REQUESTS);
        expect(result.meta.jobs_matched).toBe(0);
        expect(result.meta.notes.join('\n')).toContain('subrequest_budget');
        expect(result.meta.next_board_cursor).toBe(result.meta.board_cursor + result.meta.boards_reached);
    });

    it('decodes ampersand entities in titles so keyword matching sees the same text', async () => {
        const mapped = mapGreenhouse(
            'andurilindustries',
            {
                id: 1,
                title: 'Avionics &amp; Electronics',
                location: { name: 'Costa Mesa &#x26; Irvine' },
                departments: [{ name: 'Avionics &#38; Power' }],
            },
            'Anduril',
            false,
        );
        expect(mapped.title).toBe('Avionics & Electronics');
        expect(mapped.department).toBe('Avionics & Power');
        expect(mapped.locations).toEqual(['Costa Mesa & Irvine']);
        expect(wordMatch(mapped.title, 'avionics electronics')).toBe(true);
        expect(wordMatch('DFx Manufacturing Engineer, Avionics 0026 Electronics', 'avionics electronics')).toBe(false);

        const body = JSON.stringify({
            jobs: [
                {
                    ...ghJob(1, 'DFx Manufacturing Engineer, Avionics & Electronics', 'Costa Mesa, CA'),
                    departments: [{ name: 'Avionics &#x26; Power' }],
                },
                ghJob(2, 'Buyer, Sensors &amp; Electronics', 'Costa Mesa, CA'),
            ],
        }).replace('Avionics & Electronics', 'Avionics \\u0026 Electronics');
        expect(body).toContain('\\u0026');
        expect(body).not.toContain('Avionics & Electronics');
        const fetchImpl = (async () => chunked(body, 200, 9)) as typeof fetch;
        const shown = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'] }),
            returnDescription: false,
        });
        expect(shown.rows.map((row) => row.title).sort()).toEqual([
            'Buyer, Sensors & Electronics',
            'DFx Manufacturing Engineer, Avionics & Electronics',
        ]);
        expect(shown.rows.map((row) => row.title).join('\n')).not.toContain('0026');
        expect(shown.rows.map((row) => row.title).join('\n')).not.toContain('&amp;');
        expect(shown.rows.find((row) => row.job_id === '1')?.department).toBe('Avionics & Power');

        const phrase = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'], descriptionIncludes: ['avionics electronics'] }),
            returnDescription: false,
        });
        expect(phrase.rows.map((row) => row.title)).toEqual(['DFx Manufacturing Engineer, Avionics & Electronics']);

        const sensors = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['Costa Mesa'], descriptionIncludes: ['sensors electronics'] }),
            returnDescription: false,
        });
        expect(sensors.rows.map((row) => row.title)).toEqual(['Buyer, Sensors & Electronics']);

        const leverBody =
            '[{"id":"lev-1","text":"Technician","categories":{"location":"Allentown, PA","allLocations":["Allentown, PA"]},"hostedUrl":"https://jobs.lever.co/acme/lev-1","createdAt":1759276800000,"descriptionPlain":"Daily avionics \\u0026 propulsion work on the line."}]';
        const lever = await scan({
            boards: [board('lever', 'acme')],
            client: clientFor((async () => chunked(leverBody, 200, 11)) as typeof fetch),
            filters: filters({ locations: ['PA'], descriptionIncludes: ['avionics propulsion'] }),
            returnDescription: false,
        });
        expect(lever.meta.jobs_matched).toBe(1);
        expect(lever.rows[0]?.title).toBe('Technician');
        expect(lever.rows[0]?.description_text).toBeNull();
    });

    it('sets next_board_cursor on a mid-list soft-stop and resumes without repeating boards', async () => {
        const cpu = { ms: 0 };
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            cpu.ms += 3_000;
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? 'x';
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Allentown, PA')] }), 200, 64);
        }) as typeof fetch;
        const boards = Array.from({ length: 10 }, (_, i) => board('greenhouse', `b${i}`));
        const client = clientFor(fetchImpl);
        const first = await scan({
            boards,
            client,
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            cpu,
            cpuBudgetMs: 8_000,
            concurrency: 6,
        });
        expect(first.meta.partial).toBe(true);
        expect(first.meta.complete).toBe(false);
        expect(first.meta.stop_reason).toBe('cpu_budget');
        expect(first.meta.next_board_cursor).toBe(first.meta.boards_reached);
        expect(first.meta.next_board_cursor).toBeGreaterThan(0);
        expect(first.meta.next_board_cursor).toBeLessThan(boards.length);
        expect(first.meta.boards_scanned).toBe(first.meta.boards_reached);
        const cursor = first.meta.next_board_cursor;
        if (cursor === null) throw new Error('soft-stop left nothing to resume');
        const firstSlugs = calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '');
        expect(firstSlugs).toHaveLength(cursor);
        expect(new Set(firstSlugs)).toEqual(new Set(boards.slice(0, cursor).map((b) => b.slug)));
        calls.length = 0;
        cpu.ms = 0;
        const second = await scan({
            boards,
            boardCursor: cursor,
            client,
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            cpu,
            cpuBudgetMs: 100_000,
            concurrency: 6,
        });
        const secondSlugs = calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '');
        expect(secondSlugs).toHaveLength(boards.length - cursor);
        expect(new Set(secondSlugs)).toEqual(new Set(boards.slice(cursor).map((b) => b.slug)));
        expect(second.meta.board_cursor).toBe(cursor);
        expect(second.meta.next_board_cursor).toBeNull();
        expect(second.meta.complete).toBe(true);
        expect(second.meta.partial).toBe(false);
        expect(new Set([...firstSlugs, ...secondSlugs]).size).toBe(boards.length);
    });

    it('does not rewind next_board_cursor when a later board finishes before an earlier error', async () => {
        const cpu = { ms: 0 };
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let later = 0;
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '';
            if (slug === 'slow') {
                await gate;
                cpu.ms = 50_000;
                throw new Error('socket hang up');
            }
            later += 1;
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Austin, TX')] }), 200, 64);
        }) as typeof fetch;
        const boards = Array.from({ length: 8 }, (_, i) => board('greenhouse', i === 2 ? 'slow' : `b${i}`));
        const pending = scan({
            boards,
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            cpu,
            cpuBudgetMs: 8_000,
            concurrency: 6,
        });
        const startedAt = Date.now();
        while (later < 5 && Date.now() - startedAt < 2_000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        release();
        const result = await pending;
        expect(later).toBeGreaterThanOrEqual(5);
        expect(calls.some((u) => u.includes('/boards/slow/'))).toBe(true);
        expect(result.meta.notes.join('\n')).toContain('NETWORK_ERROR');
        expect(result.meta.boards_failed).toBe(1);
        expect(result.meta.boards_scanned).toBe(result.meta.boards_reached);
        if (result.meta.next_board_cursor === null) {
            expect(result.meta.boards_reached).toBe(boards.length);
        } else {
            expect(result.meta.next_board_cursor).toBe(result.meta.board_cursor + result.meta.boards_reached);
            expect(result.meta.next_board_cursor).toBeGreaterThan(2);
        }
    });

    it('keeps a resume cursor when a board errors before later boards start', async () => {
        const cpu = { ms: 0 };
        const calls: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            const u = String(url);
            calls.push(u);
            const slug = /\/boards\/([^/]+)\/jobs/.exec(u)?.[1] ?? '';
            if (slug === 'b0') {
                cpu.ms = 50_000;
                throw new Error('network down');
            }
            return chunked(JSON.stringify({ jobs: [ghJob(1, `Role ${slug}`, 'Allentown, PA')] }), 200, 64);
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'b0'), board('greenhouse', 'b1'), board('greenhouse', 'b2')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            cpu,
            cpuBudgetMs: 8_000,
            concurrency: 1,
        });
        expect(calls.map((u) => /\/boards\/([^/]+)\/jobs/.exec(u)?.[1])).toEqual(['b0']);
        expect(result.meta.notes.join('\n')).toContain('NETWORK_ERROR');
        expect(result.meta.partial).toBe(true);
        expect(result.meta.complete).toBe(false);
        expect(result.meta.boards_reached).toBe(1);
        expect(result.meta.boards_scanned).toBe(1);
        expect(result.meta.boards_failed).toBe(1);
        expect(result.meta.next_board_cursor).toBe(1);
    });

    it('keeps the default place-scan pool at LOCATION_SCAN_CONCURRENCY', async () => {
        let active = 0;
        let peak = 0;
        const fetchImpl = (async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active--;
            return chunked(JSON.stringify({ jobs: [ghJob(1, 'Role', 'Austin, TX')] }), 200, 64);
        }) as typeof fetch;
        await scan({
            boards: Array.from({ length: 8 }, (_, i) => board('greenhouse', `b${i}`)),
            client: new AtsClient(new HostGate(8), fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
        });
        expect(peak).toBe(LOCATION_SCAN_CONCURRENCY);
    });

    it('retries one network failure then keeps the board', async () => {
        const calls: string[] = [];
        let failed = false;
        const fetchImpl = (async (url: string | URL) => {
            calls.push(String(url));
            if (!failed) {
                failed = true;
                throw new Error('socket hang up');
            }
            return chunked(JSON.stringify({ jobs: [ghJob(1, 'Avionics Technician', 'Pittsburgh, PA')] }), 200, 64);
        }) as typeof fetch;
        const startedAt = Date.now();
        const result = await scan({
            boards: [board('greenhouse', 'andurilindustries')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LOCATION_SCAN_RETRY_DELAY_MS - 30);
        expect(calls).toHaveLength(2);
        expect(calls.every((u) => u.includes('/boards/andurilindustries/'))).toBe(true);
        expect(result.meta.requests).toBe(2);
        expect(result.meta.boards_ok).toBe(1);
        expect(result.meta.boards_failed).toBe(0);
        expect(result.meta.partial).toBe(false);
        expect(result.meta.complete).toBe(true);
        expect(result.meta.next_board_cursor).toBeNull();
        expect(result.rows.map((row) => row.title)).toEqual(['Avionics Technician']);
        expect(result.meta.notes).toContain('greenhouse/andurilindustries: retrying once after NETWORK_ERROR');
        expect(result.meta.notes).not.toContain('greenhouse/andurilindustries: NETWORK_ERROR');
    });

    it('retries one HTTP 5xx then keeps the board', async () => {
        let n = 0;
        const fetchImpl = (async () => {
            n++;
            if (n === 1) return new Response('unavailable', { status: 503 });
            return chunked(JSON.stringify({ jobs: [ghJob(1, 'Avionics Technician', 'Hawthorne, CA')] }), 200, 64);
        }) as typeof fetch;
        const startedAt = Date.now();
        const result = await scan({
            boards: [board('greenhouse', 'spacex')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['CA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        const elapsed = Date.now() - startedAt;
        expect(n).toBe(2);
        expect(elapsed).toBeGreaterThanOrEqual(LOCATION_SCAN_RETRY_DELAY_MS - 30);
        // The single-board 5xx backoff is 800 ms. This scan uses the short delay.
        expect(elapsed).toBeLessThan(750);
        expect(result.meta.boards_ok).toBe(1);
        expect(result.meta.boards_failed).toBe(0);
        expect(result.rows.map((row) => row.title)).toEqual(['Avionics Technician']);
        expect(result.meta.notes).toContain('greenhouse/spacex: retrying once after ATS_HTTP_ERROR');
        expect(result.meta.notes).not.toContain('greenhouse/spacex: ATS_HTTP_ERROR');
    });

    it('records NETWORK_ERROR when the one retry also fails', async () => {
        let n = 0;
        const fetchImpl = (async () => {
            n++;
            throw new Error('timeout');
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'spacex'), board('greenhouse', 'oklo')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(n).toBe(4);
        expect(result.meta.requests).toBe(4);
        expect(result.meta.boards_failed).toBe(2);
        expect(result.meta.boards_reached).toBe(2);
        expect(result.meta.boards_ok).toBe(0);
        expect(result.meta.next_board_cursor).toBeNull();
        expect(result.meta.complete).toBe(true);
        expect(result.meta.notes).toContain('greenhouse/spacex: retrying once after NETWORK_ERROR');
        expect(result.meta.notes).toContain('greenhouse/spacex: NETWORK_ERROR');
        expect(result.meta.notes).toContain('greenhouse/oklo: NETWORK_ERROR');
        expect(result.rows).toEqual([]);
    });

    it('does not retry a 429 kill switch', async () => {
        let n = 0;
        const fetchImpl = (async () => {
            n++;
            return new Response('slow down', { status: 429 });
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'a'), board('greenhouse', 'b')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
        });
        expect(n).toBe(1);
        expect(result.meta.boards_failed).toBe(2);
        expect(result.meta.notes.join('\n')).toContain('HOST_BLOCKED boards-api.greenhouse.io');
        expect(result.meta.notes.join('\n')).not.toContain('retrying once');
        expect(result.meta.notes.join('\n')).not.toContain('NETWORK_ERROR');
    });

    it('does not retry when the wall clock cannot fit the delay', async () => {
        let n = 0;
        const fetchImpl = (async () => {
            n++;
            throw new Error('reset');
        }) as typeof fetch;
        const result = await scan({
            boards: [board('greenhouse', 'a'), board('greenhouse', 'b')],
            client: clientFor(fetchImpl),
            filters: filters({ locations: ['PA'] }),
            returnDescription: false,
            concurrency: 1,
            budgetMs: 100,
            clock: { now: () => 0 },
        });
        expect(n).toBe(2);
        expect(result.meta.requests).toBe(2);
        expect(result.meta.boards_failed).toBe(2);
        expect(result.meta.boards_reached).toBe(2);
        expect(result.meta.next_board_cursor).toBeNull();
        expect(result.meta.notes.join('\n')).not.toContain('retrying once');
        expect(result.meta.notes).toContain('greenhouse/a: NETWORK_ERROR');
        expect(result.meta.notes).toContain('greenhouse/b: NETWORK_ERROR');
    });
});
