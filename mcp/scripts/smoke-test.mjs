/**
 * Smoke test (no token needed): initialize, tools/list, schema-quality checks, offline tool call,
 * jobs_search_companies -> COMING_SOON and does not call Apify. `--live` also calls the free tools against the real ATS APIs.
 * Never prints APIFY_TOKEN.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const live = process.argv.includes('--live');
const EXPECTED = ['jobs_get_board', 'jobs_get_job', 'jobs_find_board', 'jobs_check_open', 'jobs_list_seed_boards', 'jobs_search_by_location', 'jobs_search_companies'];
const SECTIONS = ['WHAT:', 'WHEN:', 'WHEN NOT:', 'BEHAVIOR:', 'COST:', 'RETURNS:', 'PARAMETERS:', 'EXAMPLE:'];
const fail = (m) => {
    console.error('FAIL', m);
    process.exit(1);
};

const env = { ...process.env };
delete env.APIFY_TOKEN;
const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], env, stderr: 'pipe' });
const client = new Client({ name: 'fairquery-smoke', version: '1.0.0' });
await client.connect(transport);
console.log('OK connect+initialize (no token)');

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify([...EXPECTED].sort())) fail('tool names ' + names.join(','));
for (const t of tools) {
    for (const s of SECTIONS) if (!t.description.includes(s)) fail(`${t.name} description lacks ${s}`);
    const a = t.annotations ?? {};
    if (a.readOnlyHint !== true || a.destructiveHint !== false || typeof a.openWorldHint !== 'boolean' || !a.title) fail(`${t.name} annotations`);
    if (!t.outputSchema) fail(`${t.name} outputSchema`);
    const walk = (props, where) => {
        for (const [k, v] of Object.entries(props ?? {})) {
            if (!v.description) fail(`${where}.${k} has no description`);
            if (v.items?.properties) walk(v.items.properties, `${where}.${k}[]`);
        }
    };
    walk(t.inputSchema.properties, t.name);
    console.log(`OK ${t.name}: 8 sections, annotations, outputSchema, all params described`);
}

const seed = await client.callTool({ name: 'jobs_list_seed_boards', arguments: { ats: 'lever' } });
if (!(seed.structuredContent?.items?.length >= 1)) fail('seed list empty');
console.log('OK jobs_list_seed_boards lever ->', seed.structuredContent.items.map((i) => i.slug).join(','));

const paid = await client.callTool({ name: 'jobs_search_companies', arguments: { companies: ['stripe.com'] } });
const paidText = JSON.stringify(paid);
if (!paid.isError || !paidText.includes('COMING_SOON') || !paidText.includes("Get 8,700+ boards free with Apify's $5 starter credit")) fail('expected COMING_SOON ' + paidText.slice(0, 240));
if (paidText.includes('APIFY_ACTOR_RUN_FAILED')) fail('parked tool tried to run the Actor');
console.log('OK jobs_search_companies -> COMING_SOON (no Actor run)');
const empty = await client.callTool({ name: 'jobs_search_companies', arguments: {} });
if (!JSON.stringify(empty).includes('COMING_SOON')) fail('expected COMING_SOON for empty input');
console.log('OK jobs_search_companies {} -> COMING_SOON');

const parsed = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'https://jobs.lever.co/palantir' } });
if (parsed.structuredContent?.items?.[0]?.slug !== 'palantir') fail('board URL parse');
console.log('OK jobs_find_board board URL -> lever/palantir (no network)');

const personio = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'https://acme.jobs.personio.de/xml?language=en' } });
const personioRow = personio.structuredContent?.items?.[0];
if (personioRow?.ats !== 'personio' || personioRow?.slug !== 'acme' || personioRow?.board_url !== 'https://acme.jobs.personio.de/xml') fail('personio URL parse ' + JSON.stringify(personioRow));
console.log('OK jobs_find_board personio URL -> personio/acme xml only (no network)');

const dotted = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'personio', slug: 'foo.bar' } });
if (!JSON.stringify(dotted).includes('INVALID_INPUT')) fail('personio dotted account should be INVALID_INPUT');
const dottedJob = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'personio:foo.bar:1' } });
if (!JSON.stringify(dottedJob).includes('INVALID_INPUT')) fail('personio dotted jobKey should be INVALID_INPUT');
console.log('OK personio dotted account -> INVALID_INPUT (no network)');

const pinpoint = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'https://acme.pinpointhq.com/jobs.json' } });
const pinpointRow = pinpoint.structuredContent?.items?.[0];
if (pinpointRow?.ats !== 'pinpoint' || pinpointRow?.slug !== 'acme' || pinpointRow?.board_url !== 'https://acme.pinpointhq.com/postings.json') fail('pinpoint URL parse ' + JSON.stringify(pinpointRow));
console.log('OK jobs_find_board pinpoint URL -> pinpoint/acme postings.json only (no network)');

const gem = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'https://jobs.gem.com/acme/some-id' } });
const gemRow = gem.structuredContent?.items?.[0];
if (gemRow?.ats !== 'gem' || gemRow?.slug !== 'acme' || gemRow?.board_url !== 'https://api.gem.com/job_board/v0/acme/job_posts/') fail('gem URL parse ' + JSON.stringify(gemRow));
console.log('OK jobs_find_board gem URL -> gem/acme job_posts only (no network)');

const pinpointDot = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'pinpoint', slug: 'foo.bar' } });
if (!JSON.stringify(pinpointDot).includes('INVALID_INPUT')) fail('pinpoint dotted subdomain should be INVALID_INPUT');
const gemDot = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'gem:foo.bar:1' } });
if (!JSON.stringify(gemDot).includes('INVALID_INPUT')) fail('gem dotted vanity should be INVALID_INPUT');
console.log('OK pinpoint/gem dotted slugs -> INVALID_INPUT (no network)');

const badJob = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: 'nope' } });
if (!JSON.stringify(badJob).includes('INVALID_INPUT')) fail('jobs_get_job malformed jobKey');
const noJob = await client.callTool({ name: 'jobs_get_job', arguments: {} });
if (!JSON.stringify(noJob).includes('INVALID_INPUT')) fail('jobs_get_job missing ref');
console.log('OK jobs_get_job invalid input -> INVALID_INPUT (no network)');

const placeTool = tools.find((t) => t.name === 'jobs_search_by_location');
if (!placeTool?.description.startsWith('Indexed Jobs search is COMING SOON')) fail('jobs_search_by_location does not lead with indexed search');
if (!placeTool.description.includes("Get 8,700+ boards free with Apify's $5 starter credit")) fail('jobs_search_by_location missing $5 starter credit');
if (!placeTool.description.includes('meta.notice')) fail('jobs_search_by_location RETURNS should name meta.notice');
if (!placeTool?.description.includes('Do not ask the user for a company')) fail('jobs_search_by_location WHEN is not explicit');
if (!placeTool.description.includes('descriptionIncludes')) fail('jobs_search_by_location missing descriptionIncludes');
if (!placeTool.inputSchema?.properties?.descriptionIncludes?.description) fail('descriptionIncludes param');
if (placeTool.description.includes('jobs_get_board or jobs_find_board first') === false) fail('jobs_search_by_location should say not to call board tools first');
console.log('OK jobs_search_by_location routes place/role asks without a company');

const noPlace = await client.callTool({ name: 'jobs_search_by_location', arguments: {} });
if (!JSON.stringify(noPlace).includes('INVALID_INPUT')) fail('jobs_search_by_location without a place');
const noPlaceRemote = await client.callTool({ name: 'jobs_search_by_location', arguments: { remote: 'exclude' } });
if (!JSON.stringify(noPlaceRemote).includes('INVALID_INPUT')) fail('jobs_search_by_location remote exclude is not a place signal');
console.log('OK jobs_search_by_location without a place -> INVALID_INPUT (no network)');

if (live) {
    const b = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'ashby', slug: 'ramp', titleIncludes: ['engineer'], limit: 2 } });
    if (b.isError) fail('get_board ' + JSON.stringify(b.content).slice(0, 300));
    const sc = b.structuredContent;
    console.log(`OK live jobs_get_board ashby/ramp engineer -> ${sc.total} matched of ${sc.meta.jobs_total}; first: ${sc.items[0]?.title}`);
    const key = sc.items[0]?.job_key;
    if (key) {
        const c = await client.callTool({ name: 'jobs_check_open', arguments: { jobKey: key } });
        console.log('OK live jobs_check_open ->', c.structuredContent?.items?.[0]?.status, c.structuredContent?.items?.[0]?.method);
    }
    const g = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'greenhouse', slug: 'stripe', limit: 1 } });
    const key2 = g.structuredContent?.items?.[0]?.job_key;
    const c2 = await client.callTool({ name: 'jobs_check_open', arguments: { jobKey: key2 } });
    console.log('OK live greenhouse check ->', key2, c2.structuredContent?.items?.[0]?.status);
    const c3 = await client.callTool({ name: 'jobs_check_open', arguments: { ats: 'greenhouse', slug: 'stripe', jobId: '1' } });
    console.log('OK live closed id ->', c3.structuredContent?.items?.[0]?.status);
    for (const k of [key2, key]) {
        if (!k) continue;
        const d = await client.callTool({ name: 'jobs_check_open', arguments: { jobKey: k, includeDescription: true } });
        const row = d.structuredContent?.items?.[0];
        if (row?.status !== 'open' || row.job?.job_key !== k || !(row.job.description_text?.length > 50)) fail('includeDescription ' + JSON.stringify(row).slice(0, 300));
        if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(row.job.description_text)) fail('description_text kept an e-mail address');
        console.log(`OK live jobs_check_open includeDescription ${row.method} -> "${row.job.title}", ${row.job.description_text.length} chars`);
    }
    const dc = await client.callTool({ name: 'jobs_check_open', arguments: { ats: 'greenhouse', slug: 'stripe', jobId: '1', includeDescription: true } });
    if (dc.structuredContent?.items?.[0]?.job !== null) fail('closed job should have job = null');
    console.log('OK live closed id + includeDescription -> job null');
    for (const k of [key2, key]) {
        if (!k) continue;
        const one = await client.callTool({ name: 'jobs_get_job', arguments: { jobKey: k } });
        const row = one.structuredContent?.items?.[0];
        if (one.isError || row?.type !== 'job' || row.job_key !== k || !(row.description_text?.length > 50) || one.structuredContent?.meta?.cost_usd !== 0) {
            fail('jobs_get_job ' + JSON.stringify(one.structuredContent ?? one.content).slice(0, 300));
        }
        if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(row.description_text)) fail('jobs_get_job description_text kept an e-mail address');
        console.log(`OK live jobs_get_job -> "${row.title}", ${row.description_text.length} chars, cost_usd 0`);
    }
    const closedDetail = await client.callTool({ name: 'jobs_get_job', arguments: { ats: 'greenhouse', slug: 'stripe', jobId: '1' } });
    if (!JSON.stringify(closedDetail).includes('JOB_CLOSED')) fail('expected JOB_CLOSED ' + JSON.stringify(closedDetail.content).slice(0, 200));
    console.log('OK live jobs_get_job closed id -> JOB_CLOSED');
    const nf = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'lever', slug: 'no-such-board-fq-test' } });
    console.log('OK live unknown board ->', JSON.parse(nf.content[0].text).error);
    const f = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'Hightouch' } });
    console.log('OK live jobs_find_board Hightouch ->', JSON.stringify(f.structuredContent.items.map((i) => [i.ats, i.slug, i.via, i.confidence])));
}
await client.close();
console.log('SMOKE OK');
