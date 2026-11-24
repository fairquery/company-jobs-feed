/**
 * APIFY_TOKEN handling tests (no network, never prints a token).
 * 1) Unit: normalizeApifyToken() treats empty / placeholder / unsubstituted values as missing and keeps real-looking tokens.
 * 2) Runner emulation: resolves manifest.json mcp_config exactly like Smithery's local runner (CLI 1.2.0: ${user_config.X}
 *    left as the literal placeholder when the value is absent, no manifest defaults) and like an MCPB host (defaults applied),
 *    spawns the server and checks jobs_search_companies returns COMING_SOON and does not require a token.
 * Usage: node scripts/test-token.mjs [rootDir]   (rootDir = repo/package dir or an unpacked .mcpb; default: package dir)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PAID_CALL = { name: 'jobs_search_companies', arguments: { companies: ['stripe.com'] } };
const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const fail = (m) => { console.error('FAIL', m); process.exit(1); };

// 1) Unit
const { normalizeApifyToken } = await import(pathToFileURL(path.join(root, 'dist', 'common.js')).href);
const missing = [undefined, null, '', '   ', '\n', '${user_config.apify_token}', '${user_config.APIFY_TOKEN}', ' ${APIFY_TOKEN} ',
    '"${user_config.apify_token}"', "''", '""', '<optional-your-apify-token>', '<APIFY_TOKEN>', '{{APIFY_TOKEN}}', '{{ apify_token }}',
    '$APIFY_TOKEN', '%APIFY_TOKEN%', 'undefined', 'null', 'None', 'your-apify-token', 'YOUR_APIFY_TOKEN', 'your_api_token',
    'paste your token here'];
for (const v of missing) if (normalizeApifyToken(v) !== undefined) fail(`placeholder not treated as missing: ${JSON.stringify(v)}`);
const fake = 'apify_api_' + 'Ab3'.repeat(12); // synthetic, not a real token
if (normalizeApifyToken(fake) !== fake) fail('real-looking token rejected');
if (normalizeApifyToken(`  ${fake}\n`) !== fake) fail('token not trimmed');
if (normalizeApifyToken(`"${fake}"`) !== fake) fail('quoted token not unquoted');
console.log(`PASS unit: ${missing.length} empty/placeholder values -> missing; real-looking token kept (trim, quotes)`);

// 2) Runner emulation
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const cfg = manifest.server.mcp_config;
// Exact substitution logic of Smithery CLI 1.2.0 local runner (function W$): no defaults, unknown keys left verbatim.
const smitherySub = (s, config, dir) => s.replace(/\$\{([^}]+)\}/g, (m, k) => {
    if (k === '__dirname' && dir) return dir;
    if (k.startsWith('user_config.')) {
        let a = config;
        for (const part of k.replace('user_config.', '').split('.')) {
            if (a && typeof a === 'object' && !Array.isArray(a)) a = a[part]; else return m;
        }
        return a != null ? String(a) : m;
    }
    return m;
});
// MCPB host (@anthropic-ai/mcpb getMcpConfigForManifest): manifest defaults, then user values.
const mcpbConfig = (user) => {
    const merged = {};
    for (const [k, v] of Object.entries(manifest.user_config ?? {})) if (v.default !== undefined) merged[k] = v.default;
    return { ...merged, ...user };
};
const scenarios = [
    { label: 'Smithery runner, token omitted (config {})', config: {}, sub: smitherySub },
    { label: 'Smithery runner, token null', config: { apify_token: null }, sub: smitherySub },
    { label: 'Smithery runner, token ""', config: { apify_token: '' }, sub: smitherySub },
    { label: 'Smithery runner, token "   "', config: { apify_token: '   ' }, sub: smitherySub },
    { label: 'MCPB host, token left blank (default "")', config: mcpbConfig({}), sub: smitherySub },
    { label: 'APIFY_TOKEN env not set at all', noEnv: true },
    { label: 'APIFY_TOKEN set to a real-looking token (must still not run the Actor)', token: 'apify_api_' + 'Ab3'.repeat(12) },
];
for (const sc of scenarios) {
    const env = { ...process.env };
    delete env.APIFY_TOKEN; // never use this machine's token
    if (sc.token) env.APIFY_TOKEN = sc.token;
    else if (!sc.noEnv) for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = sc.sub(v, sc.config, root);
    const args = sc.noEnv ? [path.join(root, 'dist', 'index.js')] : cfg.args.map((a) => smitherySub(a, sc.config ?? {}, root));
    const client = new Client({ name: 'fairquery-token-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' }));
    const r = await client.callTool(PAID_CALL);
    await client.close();
    const txt = r.content?.[0]?.text ?? '';
    if (!r.isError || !txt.includes('COMING_SOON') || !txt.includes("Get 8,700+ boards free with Apify's $5 starter credit")) {
        fail(`${sc.label}: expected COMING_SOON, got ${txt.slice(0, 180)}`);
    }
    if (txt.includes('APIFY_ACTOR_RUN_FAILED') || txt.includes('fairquery~company-jobs-feed')) fail(`${sc.label}: parked tool tried to run the Actor`);
    console.log(`PASS ${sc.label} -> COMING_SOON`);
}
console.log('TOKEN TEST PASS');
