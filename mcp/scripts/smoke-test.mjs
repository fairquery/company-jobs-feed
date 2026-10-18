/**
 * Smoke test (no token needed): initialize, tools/list, schema-quality checks, offline tool call,
 * paid tool without token -> APIFY_TOKEN_MISSING. `--live` also calls the free tools against the real ATS APIs.
 * Never prints APIFY_TOKEN.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const live = process.argv.includes('--live');
const EXPECTED = ['jobs_get_board', 'jobs_find_board', 'jobs_check_open', 'jobs_list_seed_boards', 'jobs_search_companies'];
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
if (!JSON.stringify(paid).includes('APIFY_TOKEN_MISSING')) fail('expected APIFY_TOKEN_MISSING');
console.log('OK jobs_search_companies without token -> APIFY_TOKEN_MISSING');
const empty = await client.callTool({ name: 'jobs_search_companies', arguments: {} });
if (!JSON.stringify(empty).includes('INPUT_EMPTY')) fail('expected INPUT_EMPTY');
console.log('OK jobs_search_companies {} -> INPUT_EMPTY');

const parsed = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'https://jobs.lever.co/palantir' } });
if (parsed.structuredContent?.items?.[0]?.slug !== 'palantir') fail('board URL parse');
console.log('OK jobs_find_board board URL -> lever/palantir (no network)');

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
    const nf = await client.callTool({ name: 'jobs_get_board', arguments: { ats: 'lever', slug: 'no-such-board-fq-test' } });
    console.log('OK live unknown board ->', JSON.parse(nf.content[0].text).error);
    const f = await client.callTool({ name: 'jobs_find_board', arguments: { company: 'Hightouch' } });
    console.log('OK live jobs_find_board Hightouch ->', JSON.stringify(f.structuredContent.items.map((i) => [i.ats, i.slug, i.via, i.confidence])));
}
await client.close();
console.log('SMOKE OK');
