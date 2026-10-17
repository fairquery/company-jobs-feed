import { describe, expect, it } from 'vitest';

import { fetchBoard, listUrl, mapAshby, mapGreenhouse, mapLever, mapSmartRecruiters } from '../src/ats.js';
import { DuplicateTracker, mergeRoles } from '../src/dedupe.js';
import {
    extractBoardLinks,
    findCareersLinks,
    parseBoardUrl,
    probePlan,
    seedLookup,
    slugCandidates,
} from '../src/discovery.js';
import { compileFilters, matches } from '../src/filters.js';
import { countriesFromText, countryToIso2 } from '../src/gazetteer.js';
import { AtsClient, CareersFetcher, HostGate, HttpError } from '../src/http.js';
import { htmlToText, normTitle, scrubPII, wordMatch } from '../src/normalize.js';
import { isAllowed, parseRobots } from '../src/robots.js';
import { buildJobRow, jobFingerprint, type RowContext } from '../src/rows.js';
import { SEED_BOARDS } from '../src/seed.js';
import { isPrivateAddress, unsafeUrlReason } from '../src/ssrf.js';
import { applyHistory, type BoardState } from '../src/state.js';
import type { NormalizedJob } from '../src/types.js';

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
        expect(parseBoardUrl('https://careers.smartrecruiters.com/BoschGroup')).toEqual({
            ats: 'smartrecruiters',
            slug: 'BoschGroup',
        });
        expect(parseBoardUrl('ashby:ramp')).toEqual({ ats: 'ashby', slug: 'ramp' });
        expect(parseBoardUrl('https://www.linkedin.com/jobs/view/123')).toBeNull();
        expect(parseBoardUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers')).toBeNull();
        expect(parseBoardUrl('https://jobs.ashbyhq.com/api/non-user-graphql')).toBeNull();
    });

    it('extracts ATS links and Greenhouse embeds from a careers page', () => {
        const html = `<a href="https://jobs.lever.co/acme">Jobs</a>
            <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme2"></script>
            <iframe src="https:\\/\\/jobs.ashbyhq.com\\/acme3"></iframe>`;
        const links = extractBoardLinks(html).map((b) => `${b.ats}:${b.slug}`);
        expect(links).toEqual(expect.arrayContaining(['lever:acme', 'greenhouse:acme2', 'ashby:acme3']));
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
    });

    it('seed list resolves by domain and name, and every entry is well-formed', () => {
        expect(seedLookup('stripe.com')[0]).toMatchObject({ ats: 'greenhouse', slug: 'stripe' });
        expect(seedLookup('Ramp')[0]).toMatchObject({ ats: 'ashby', slug: 'ramp' });
        for (const s of SEED_BOARDS) {
            expect(['greenhouse', 'lever', 'ashby', 'smartrecruiters']).toContain(s.ats);
            expect(s.jobs_at_verification).toBeGreaterThan(0);
            expect(s.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
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

    it('ATS client only calls the four documented API hosts', async () => {
        const c = new AtsClient(
            new HostGate(),
            fakeFetch(() => ({ status: 200, body: {} })),
        );
        await expect(c.getJson('https://evil.example/v1/boards/x')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('https://jobs.ashbyhq.com/api/x')).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
        await expect(c.getJson('http://boards-api.greenhouse.io/v1/boards/x')).rejects.toMatchObject({
            code: 'URL_NOT_ALLOWED',
        });
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

    it('SmartRecruiters: releasedDate, structured country and remote', () => {
        const j = mapSmartRecruiters(
            'BoschGroup',
            {
                id: '744000156094999',
                name: 'Janitor',
                releasedDate: '2026-10-17T00:08:21.966Z',
                company: { identifier: 'BoschGroup', name: 'Bosch Group' },
                location: {
                    city: 'Mexicali',
                    country: 'mx',
                    remote: false,
                    hybrid: false,
                    fullLocation: 'Mexicali, BAJA CALIFORNIA, Mexico',
                },
                typeOfEmployment: { label: 'Full-time' },
            },
            'Bosch',
        );
        expect(j).toMatchObject({
            company: 'Bosch Group',
            countries: ['MX'],
            remote: false,
            remote_basis: 'ats',
            workplace_type: 'onsite',
            posted_at: '2026-10-17T00:08:21.966Z',
        });
    });

    it('SmartRecruiters pagination stops at totalFound and flags truncation', async () => {
        const c = new AtsClient(
            new HostGate(),
            fakeFetch((u) => {
                const offset = Number(new URL(u).searchParams.get('offset'));
                const content = Array.from({ length: offset < 200 ? 100 : 50 }, (_, i) => ({
                    id: String(offset + i),
                    name: 'Job',
                }));
                return { status: 200, body: { totalFound: 250, content } };
            }),
        );
        const all = await fetchBoard(c, 'smartrecruiters', 'X', { maxJobs: 1000, withDescription: false });
        expect(all).toMatchObject({ total: 250, complete: true, requests: 3 });
        expect(all.jobs).toHaveLength(250);
        const capped = await fetchBoard(c, 'smartrecruiters', 'X', { maxJobs: 100, withDescription: false });
        expect(capped).toMatchObject({ complete: false, requests: 1 });
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
    });

    it('gazetteer and normalizers', () => {
        expect(countriesFromText(['Austin, TX'])).toEqual(['US']);
        expect(countriesFromText(['Springfield, IL'])).toEqual(['US']);
        expect(countriesFromText(['Bengaluru, India'])).toEqual(['IN']);
        expect(countriesFromText(['London'])).toEqual(['GB']);
        expect(countryToIso2('USA')).toBe('US');
        expect(countryToIso2('de')).toBe('DE');
        expect(wordMatch('Sr. Software Engineer', 'software engineer')).toBe(true);
        expect(normTitle('Software Engineer (Req 12345)')).toBe('software engineer');
        expect(htmlToText('<p>A</p><ul><li>B</li></ul>')).toBe('A\n\n• B');
        expect(scrubPII('mail a@b.co').redactions).toBe(1);
    });
});
