/**
 * jobs_get_job tests (no network, no token printed).
 * Mocks fetch and drives the server in-process. Also checks the paid tool's price text is unchanged
 * and that manifest.json lists the same tools as tools/list.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => {
    console.error('FAIL', m);
    process.exit(1);
};

const COMING_SOON_LEAD = 'Indexed Jobs search is COMING SOON';
const STARTER_CREDIT = "Get 8,700+ boards free with Apify's $5 starter credit";

delete process.env.APIFY_TOKEN;

const { createServer } = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);

function jsonResponse(status, body) {
    const text = body == null ? '' : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

async function withClient(route, fn) {
    const calls = [];
    const prev = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('apify.com')) fail('jobs_get_job contacted Apify');
        const hit = route(u);
        if (!hit) return jsonResponse(404, null);
        return jsonResponse(hit.status, hit.body);
    };
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'fairquery-get-job-test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
        await fn(client, calls);
    } finally {
        await client.close();
        await server.close();
        globalThis.fetch = prev;
    }
}

function bodyOf(result) {
    const text = result.content?.[0]?.text ?? '';
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

const GH_JOB = {
    id: 8172503,
    title: 'Software Engineer',
    absolute_url: 'https://stripe.com/jobs/search?gh_jid=8172503',
    location: { name: 'New York, NY' },
    updated_at: '2026-10-01T00:00:00Z',
    first_published: '2026-09-01T00:00:00Z',
    company_name: 'Stripe',
    content: '<p>Build payments. Email jobs@stripe.com or call +1 415-555-0199.</p>',
    departments: [{ name: 'Engineering' }],
};

const LEVER_JOB = {
    id: 'abc-123',
    text: 'Forward Deployed Engineer',
    createdAt: 1786469891368,
    country: 'GB',
    workplaceType: 'remote',
    categories: { commitment: 'Full-time', department: 'Engineering', location: 'London', allLocations: ['London'] },
    descriptionPlain: 'Deploy software. Email jobs@palantir.com',
    hostedUrl: 'https://jobs.lever.co/palantir/abc-123',
    applyUrl: 'https://jobs.lever.co/palantir/abc-123/apply',
};

const ASHBY_OPEN = {
    id: 'job-1',
    title: 'Security Engineer',
    department: 'Engineering',
    location: 'New York',
    isListed: true,
    isRemote: false,
    publishedAt: '2026-04-07T17:12:35.753+00:00',
    descriptionPlain: 'Design systems. Email jobs@ramp.com',
    compensation: {
        compensationTierSummary: '$200K – $250K',
        summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 200000, maxValue: 250000 }],
    },
};

await withClient(() => {
    fail('tools/list or invalid input must not fetch');
    return { status: 500, body: null };
}, async (client, calls) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const declared = (manifest.tools ?? []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(declared)) fail(`manifest.tools ${declared} != tools/list ${names}`);
    const detail = tools.find((t) => t.name === 'jobs_get_job');
    if (!detail) fail('jobs_get_job missing');
    for (const s of ['WHAT:', 'WHEN:', 'WHEN NOT:', 'BEHAVIOR:', 'COST:', 'RETURNS:', 'PARAMETERS:', 'EXAMPLE:']) {
        if (!detail.description.includes(s)) fail(`jobs_get_job description lacks ${s}`);
    }
    const tokenMentions = detail.description.match(/APIFY_TOKEN/g) ?? [];
    if (!detail.description.startsWith(COMING_SOON_LEAD)) fail('jobs_get_job description does not lead with indexed search');
    if (!detail.description.includes(STARTER_CREDIT)) fail('jobs_get_job description missing $5 starter credit');
    if (tokenMentions.length !== 1) fail(`jobs_get_job description mentions APIFY_TOKEN ${tokenMentions.length} time(s)`);
    if (detail.annotations?.readOnlyHint !== true || detail.annotations?.openWorldHint !== true) fail('jobs_get_job annotations');
    const paid = tools.find((t) => t.name === 'jobs_search_companies');
    if (!paid?.description.includes('temporarily unavailable')) fail('jobs_search_companies is not described as offline');
    if (!paid.description.includes('does not run the Apify Actor')) fail('jobs_search_companies still offers the old Actor');
    if (paid.description.includes('pay-per-event')) fail('jobs_search_companies still advertises the old paid SKU');
    if (!paid.inputSchema?.properties?.confirmOpen?.description?.includes('temporarily offline')) fail('confirmOpen still describes a live billed re-check');
    if (paid.annotations?.openWorldHint !== false) fail('parked jobs_search_companies should not be open-world');

    const bad = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'nope' } });
    const badBody = bodyOf(bad);
    if (!bad.isError || badBody.error !== 'INVALID_INPUT' || !String(badBody.message).includes('jobKey must look like')) fail('malformed jobKey ' + JSON.stringify(badBody));
    const checkBad = await client.callTool({ name: 'jobs_check_open', arguments: { jobKey: 'nope' } });
    if (bodyOf(checkBad).message !== badBody.message) fail('jobs_check_open jobKey error drifted');
    const missing = await client.callTool({ name: 'jobs_get_job', arguments: {} });
    const missingBody = bodyOf(missing);
    if (!missing.isError || missingBody.error !== 'INVALID_INPUT' || !String(missingBody.message).includes('ats + slug + jobId')) fail('missing ref ' + JSON.stringify(missingBody));
    const dotted = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'greenhouse:a..b:1' } });
    if (bodyOf(dotted).error !== 'INVALID_INPUT') fail('dot-dot slug accepted');
    if (calls.length !== 0) fail(`invalid input fetched ${calls.length} URL(s)`);
    process.env.APIFY_TOKEN = 'apify_api_' + 'Ab3'.repeat(12);
    const parked = await client.callTool({ name: 'jobs_search_companies', arguments: { companies: ['stripe.com'] } });
    delete process.env.APIFY_TOKEN;
    const parkedBody = bodyOf(parked);
    if (!parked.isError || parkedBody.error !== 'COMING_SOON') fail('jobs_search_companies with a token should be COMING_SOON ' + JSON.stringify(parkedBody));
    if (!String(parkedBody.message).includes(STARTER_CREDIT)) fail('COMING_SOON message missing starter credit');
    if (calls.some((u) => u.includes('apify.com'))) fail('jobs_search_companies contacted Apify');
    console.log('PASS schema, indexed-search copy, parked paid tool makes no Apify request');
});

await withClient(
    (u) => {
        if (u === 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172503') return { status: 200, body: GH_JOB };
        return null;
    },
    async (client, calls) => {
        const r = await client.callTool({
            name: 'jobs_get_job',
            arguments: { jobKey: 'greenhouse:stripe:8172503', ats: 'lever', slug: 'palantir', jobId: 'other' },
        });
        const b = bodyOf(r);
        const row = b.items?.[0];
        if (r.isError || row?.type !== 'job' || row.job_key !== 'greenhouse:stripe:8172503') fail('greenhouse row ' + JSON.stringify(b).slice(0, 400));
        if (row.status !== 'open' || row.change !== null || row.company !== 'Stripe') fail('greenhouse fields ' + JSON.stringify(row).slice(0, 300));
        if (!row.description_text?.includes('Build payments') || row.description_text.includes('jobs@stripe.com')) fail('description not scrubbed: ' + row.description_text);
        if (!row.description_text.includes('[email removed]') || !row.description_text.includes('[phone removed]')) fail('expected redactions: ' + row.description_text);
        if (b.meta?.cost_usd !== 0 || b.meta?.requests !== 1) fail('meta ' + JSON.stringify(b.meta));
        if (calls.some((u) => !u.includes('/boards/stripe/jobs/8172503'))) fail('jobKey did not win: ' + calls.join(' '));
        console.log('PASS greenhouse detail, jobKey wins, description scrubbed, cost_usd 0');
    },
);

await withClient(
    (u) => {
        if (u === 'https://boards-api.greenhouse.io/v1/boards/missing/jobs/9') return { status: 404, body: null };
        if (u.startsWith('https://boards-api.greenhouse.io/v1/boards/missing/jobs')) return { status: 404, body: null };
        return null;
    },
    async (client, calls) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'greenhouse', slug: 'missing', jobId: '9' } });
        const b = bodyOf(r);
        if (!r.isError || b.error !== 'BOARD_NOT_FOUND') fail('expected BOARD_NOT_FOUND ' + JSON.stringify(b));
        if (calls.length !== 2) fail(`board-missing requests ${calls.length}`);
        console.log('PASS missing board -> BOARD_NOT_FOUND');
    },
);

await withClient(
    (u) => {
        if (u === 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1') return { status: 404, body: null };
        if (u.startsWith('https://boards-api.greenhouse.io/v1/boards/stripe/jobs')) return { status: 200, body: { jobs: [] } };
        return null;
    },
    async (client) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'greenhouse', slug: 'stripe', jobId: '1' } });
        const b = bodyOf(r);
        if (!r.isError || b.error !== 'JOB_CLOSED' || b.retryable !== false) fail('expected JOB_CLOSED ' + JSON.stringify(b));
        console.log('PASS unknown greenhouse id on a live board -> JOB_CLOSED');
    },
);

await withClient(
    (u) => (u === 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1' ? { status: 410, body: null } : { status: 200, body: { jobs: [] } }),
    async (client) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'greenhouse:stripe:1' } });
        if (bodyOf(r).error !== 'JOB_CLOSED') fail('410 should be JOB_CLOSED ' + JSON.stringify(bodyOf(r)));
        console.log('PASS greenhouse 410 -> JOB_CLOSED');
    },
);

await withClient(
    (u) => (u === 'https://api.lever.co/v0/postings/palantir/abc-123?mode=json' ? { status: 200, body: LEVER_JOB } : null),
    async (client, calls) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'lever', slug: 'palantir', jobId: 'abc-123' } });
        const row = bodyOf(r).items?.[0];
        if (r.isError || row?.job_key !== 'lever:palantir:abc-123' || row.company !== 'Palantir') fail('lever row ' + JSON.stringify(bodyOf(r)).slice(0, 400));
        if (!row.description_text?.includes('Deploy software') || row.description_text.includes('jobs@palantir.com')) fail('lever description ' + row.description_text);
        if (bodyOf(r).meta?.cost_usd !== 0) fail('lever cost');
        if (calls.length !== 1) fail('lever requests ' + calls.length);
        console.log('PASS lever detail');
    },
);

await withClient(
    (u) =>
        u.startsWith('https://api.ashbyhq.com/posting-api/job-board/ramp')
            ? { status: 200, body: { jobs: [ASHBY_OPEN, { id: 'hidden', title: 'Hidden', isListed: false, descriptionPlain: 'nope' }] } }
            : null,
    async (client) => {
        const open = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'ashby:ramp:job-1' } });
        const row = bodyOf(open).items?.[0];
        if (open.isError || row?.type !== 'job' || row.company !== 'Ramp' || row.job_id !== 'job-1') fail('ashby row ' + JSON.stringify(bodyOf(open)).slice(0, 400));
        if (!row.description_text?.includes('Design systems') || row.description_text.includes('jobs@ramp.com')) fail('ashby description ' + row.description_text);
        if (row.compensation?.currency !== 'USD' || bodyOf(open).meta?.cost_usd !== 0) fail('ashby compensation or cost');
        const hidden = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'ashby', slug: 'ramp', jobId: 'hidden' } });
        if (bodyOf(hidden).error !== 'JOB_CLOSED') fail('unlisted ashby job should be JOB_CLOSED');
        const absent = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'ashby', slug: 'ramp', jobId: 'nope' } });
        if (bodyOf(absent).error !== 'JOB_CLOSED') fail('missing ashby id should be JOB_CLOSED');
        console.log('PASS ashby detail, unlisted and missing ids -> JOB_CLOSED');
    },
);

await withClient(
    () => ({ status: 403, body: 'blocked' }),
    async (client) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'greenhouse:stripe:8172503' } });
        const b = bodyOf(r);
        if (!r.isError || b.error !== 'HOST_BLOCKED' || b.retryable !== true) fail('expected HOST_BLOCKED ' + JSON.stringify(b));
        console.log('PASS greenhouse 403 -> HOST_BLOCKED');
    },
);

await withClient(
    (u) => (u.startsWith('https://api.ashbyhq.com/posting-api/job-board/no-such-board-fq-test') ? { status: 404, body: null } : null),
    async (client) => {
        const r = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'ashby', slug: 'no-such-board-fq-test', jobId: '1' } });
        if (bodyOf(r).error !== 'BOARD_NOT_FOUND') fail('ashby missing board ' + JSON.stringify(bodyOf(r)));
        console.log('PASS missing ashby board -> BOARD_NOT_FOUND');
    },
);

await withClient(
    (u) =>
        String(u).includes('/boards/stripe/jobs')
            ? {
                  status: 200,
                  body: {
                      jobs: [
                          {
                              id: 1,
                              title: 'Support Associate',
                              location: { name: 'Tampa, FL' },
                              absolute_url: 'https://stripe.com/jobs/1',
                              first_published: '2026-10-01T00:00:00Z',
                              company_name: 'Stripe',
                          },
                          {
                              id: 2,
                              title: 'Engineer',
                              location: { name: 'New York, NY' },
                              absolute_url: 'https://stripe.com/jobs/2',
                              first_published: '2026-10-01T00:00:00Z',
                              company_name: 'Stripe',
                          },
                      ],
                  },
              }
            : null,
    async (client, calls) => {
        const before = calls.length;
        const empty = await client.callTool({ name: 'jobs_search_by_location', arguments: {} });
        const emptyBody = bodyOf(empty);
        if (!empty.isError || emptyBody.error !== 'INVALID_INPUT' || calls.length !== before) fail('place signal ' + JSON.stringify(emptyBody));
        const excl = await client.callTool({ name: 'jobs_search_by_location', arguments: { remote: 'exclude', locations: ['   '] } });
        if (!excl.isError || bodyOf(excl).error !== 'INVALID_INPUT' || calls.length !== before) fail('blank location ' + JSON.stringify(bodyOf(excl)));
        const bad = await client.callTool({ name: 'jobs_search_by_location', arguments: { locations: ['Tampa'], titleRegex: '(a+)+' } });
        if (!bad.isError || bodyOf(bad).error !== 'INVALID_INPUT' || calls.length !== before) fail('bad regex fetched');
        const hit = await client.callTool({ name: 'jobs_search_by_location', arguments: { locations: ['FL'], limit: 10 } });
        const body = bodyOf(hit);
        if (hit.isError) fail('search ' + JSON.stringify(body).slice(0, 400));
        const meta = body.meta ?? {};
        if (meta.cost_usd !== 0) fail('cost ' + meta.cost_usd);
        if (meta.jobs_matched !== 1 || body.items?.length !== 1) fail('matched ' + JSON.stringify(body).slice(0, 500));
        if (!JSON.stringify(body.items[0].locations).includes('Tampa')) fail('row ' + JSON.stringify(body.items[0].locations));
        if (body.items[0].title !== 'Support Associate') fail('title ' + body.items[0].title);
        if (meta.boards_scanned !== meta.boards_ok + meta.boards_failed || meta.boards_ok < 1 || meta.boards_failed < 1) fail('counts ' + JSON.stringify(meta));
        if (!JSON.stringify(meta.notes).includes('BOARD_NOT_FOUND')) fail('notes ' + JSON.stringify(meta.notes));
        if (JSON.stringify(meta.notes).includes('HOST_BLOCKED')) fail('unexpected block ' + JSON.stringify(meta.notes));
        if (calls.length - before !== meta.requests) fail(`requests ${calls.length - before} meta ${meta.requests}`);
        if (!String(meta.notice).includes(STARTER_CREDIT) || !String(meta.notice).includes('Indexed Jobs search is COMING SOON')) fail('notice ' + meta.notice);
        if (String(meta.notice).startsWith('Scanned')) fail('complete scan notice should not lead with a partial board count');
        if (meta.notes?.[0] !== meta.notice) fail('notice must be notes[0]');
        if (meta.partial !== false || meta.stop_reason != null || meta.complete !== true || meta.next_board_cursor !== null) {
            fail('coverage ' + JSON.stringify(meta));
        }
        if (meta.boards_total !== 135 || meta.boards_reached !== 135) fail('full pass ' + JSON.stringify(meta));
        console.log(`PASS jobs_search_by_location FL -> Tampa, scanned ${meta.boards_scanned}, cost_usd 0`);
    },
);

await withClient(
    (u) =>
        String(u).includes('/boards/stripe/jobs')
            ? {
                  status: 200,
                  body: {
                      jobs: [
                          {
                              id: 3,
                              title: 'Electrical Technician',
                              location: { name: 'Baltimore, MD' },
                              absolute_url: 'https://stripe.com/jobs/3',
                              first_published: '2026-10-01T00:00:00Z',
                              company_name: 'Stripe',
                              content: '<p>Supports avionics integration. Email jobs@stripe.com.</p>',
                          },
                          {
                              id: 4,
                              title: 'Integration Engineer',
                              location: { name: 'Annapolis, MD' },
                              absolute_url: 'https://stripe.com/jobs/4',
                              first_published: '2026-10-01T00:00:00Z',
                              company_name: 'Stripe',
                              content: '<p>Wiring harness.</p>',
                          },
                      ],
                  },
              }
            : null,
    async (client, calls) => {
        const before = calls.length;
        const hit = await client.callTool({
            name: 'jobs_search_by_location',
            arguments: { locations: ['Baltimore MD'], descriptionIncludes: ['avionics'], limit: 5 },
        });
        const body = bodyOf(hit);
        if (hit.isError) fail('description search ' + JSON.stringify(body).slice(0, 400));
        if (body.meta?.cost_usd !== 0) fail('description cost ' + body.meta?.cost_usd);
        if (body.meta?.jobs_matched !== 1 || body.items?.[0]?.title !== 'Electrical Technician') fail('description match ' + JSON.stringify(body).slice(0, 500));
        if (body.items[0].description_text) fail('description text returned without includeDescription');
        const shown = await client.callTool({
            name: 'jobs_search_by_location',
            arguments: { locations: ['BWI'], descriptionIncludes: ['avionics'], includeDescription: true, limit: 5 },
        });
        const shownBody = bodyOf(shown);
        if (shownBody.items?.[0]?.title !== 'Electrical Technician' || !String(shownBody.items[0].description_text).includes('avionics')) {
            fail('BWI description ' + JSON.stringify(shownBody).slice(0, 500));
        }
        if (String(shownBody.items[0].description_text).includes('jobs@stripe.com')) fail('description not scrubbed');
        const titleOnly = await client.callTool({
            name: 'jobs_search_by_location',
            arguments: { locations: ['Baltimore'], titleIncludes: ['avionics'], limit: 5 },
        });
        const empty = bodyOf(titleOnly);
        if (titleOnly.isError || empty.meta?.jobs_matched !== 0 || empty.items?.length !== 0) fail('title-only should miss ' + JSON.stringify(empty).slice(0, 400));
        const suggestions = empty.meta?.suggestions;
        if (!suggestions?.note?.includes('not every employer') || !suggestions.note.includes('Greenhouse, Lever and Ashby')) fail('suggestion note ' + JSON.stringify(suggestions));
        if (!suggestions.title_tokens_tried?.includes('avionics')) fail('tokens ' + JSON.stringify(suggestions));
        if (!suggestions.sample_open_titles?.includes('Electrical Technician')) fail('sample titles ' + JSON.stringify(suggestions));
        if (suggestions.sample_open_titles.includes('Integration Engineer')) fail('sample leaked a job outside Baltimore');
        const aliasNames = (suggestions.place_aliases_with_hits ?? []).map((h) => h.alias);
        if (!aliasNames.includes('baltimore') || !aliasNames.includes('md')) fail('aliases ' + JSON.stringify(suggestions.place_aliases_with_hits));
        if ((suggestions.place_aliases_with_hits ?? []).some((h) => h.jobs < 1)) fail('zero-hit alias');
        const noPlace = await client.callTool({ name: 'jobs_search_by_location', arguments: { descriptionIncludes: ['avionics'] } });
        // The two description searches re-read stripe with content=true after the lite list shows a Baltimore job.
        // The request ceiling is above the 135-board starter list, so these mocked boards finish in one call.
        const used = (body.meta.requests ?? 0) + (shownBody.meta.requests ?? 0) + (empty.meta.requests ?? 0);
        const contentCalls = calls.slice(before).filter((u) => u.includes('content=true')).length;
        if (!noPlace.isError || bodyOf(noPlace).error !== 'INVALID_INPUT' || calls.length - before !== used || contentCalls !== 2) {
            fail(`place still required or request count drifted calls=${calls.length - before} used=${used} content=${contentCalls} scanned=${body.meta.boards_scanned}`);
        }
        if (body.meta.partial !== false || body.meta.stop_reason != null || body.meta.complete !== true || body.meta.next_board_cursor !== null) {
            fail('description coverage ' + JSON.stringify(body.meta));
        }
        if (body.meta.boards_reached !== 135) fail('description full pass ' + JSON.stringify(body.meta));
        console.log('PASS description keyword, BWI alias, empty-result suggestions, cost_usd 0');
    },
);

console.log('GET JOB TEST PASS');
