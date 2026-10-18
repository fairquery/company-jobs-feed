/**
 * Tests a built .mcpb bundle the way an MCPB host runs it:
 * unpack -> resolve manifest mcp_config (${__dirname}, ${user_config.*} with manifest defaults) ->
 * spawn with NO APIFY_TOKEN from this machine -> initialize, tools/list, one free call,
 * paid call without token must return APIFY_TOKEN_MISSING. Never prints any token.
 * Usage: node scripts/test-mcpb.mjs build/<bundle>.mcpb
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
const bundle = process.argv[2];
if (!bundle || !fs.existsSync(bundle)) { console.error('usage: node scripts/test-mcpb.mjs <bundle.mcpb>'); process.exit(2); }
const fail = (m) => { console.error('FAIL', m); process.exit(1); };

const size = fs.statSync(bundle).size;
if (size > 25 * 1024 * 1024) fail(`bundle is ${size} bytes (> Smithery 25 MB limit)`);
console.log(`bundle size: ${(size / 1024 / 1024).toFixed(2)} MB`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-test-'));
execFileSync('npx', ['--yes', MCPB_CLI, 'unpack', bundle, dir], { stdio: 'ignore' });
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

// No secrets or env files inside the bundle.
const files = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
const bad = files.filter((f) => /(^|\/)\.env(\.|$)|\.npmrc$|\.pem$|id_rsa/.test(f));
if (bad.length) fail('unexpected files in bundle: ' + bad.join(', '));
console.log(`bundle files: ${files.length}, none of .env/.npmrc/keys`);

// Resolve mcp_config like an MCPB host (defaults from user_config, user leaves token empty).
const vars = { __dirname: dir };
for (const [k, v] of Object.entries(manifest.user_config ?? {})) if (v.default !== undefined) vars[`user_config.${k}`] = String(v.default);
const sub = (s) => s.replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const cfg = manifest.server.mcp_config;
const childEnv = { ...process.env };
delete childEnv.APIFY_TOKEN; // never pass this machine's token
for (const [k, v] of Object.entries(cfg.env ?? {})) childEnv[k] = sub(v);
if (childEnv.APIFY_TOKEN !== '') fail('APIFY_TOKEN did not resolve to empty string with default config');
console.log('APIFY_TOKEN resolves to empty string when the user leaves it blank');

const command = cfg.command === 'node' ? process.execPath : cfg.command;
const transport = new StdioClientTransport({ command, args: cfg.args.map(sub), env: childEnv, stderr: 'pipe' });
const client = new Client({ name: 'fairquery-mcpb-test', version: '1.0.0' });
await client.connect(transport);
const info = client.getServerVersion();
console.log(`PASS initialize: server ${info?.name} ${info?.version}`);

const { tools } = await client.listTools();
const live = tools.map((t) => t.name).sort();
const declared = (manifest.tools ?? []).map((t) => t.name).sort();
if (JSON.stringify(live) !== JSON.stringify(declared)) fail(`manifest.tools ${declared} != tools/list ${live}`);
console.log(`PASS tools/list: ${live.length} tools, matches manifest.tools`);

const freeCall = JSON.parse(process.env.MCPB_TEST_FREE_CALL);
const fr = await client.callTool(freeCall);
if (fr.isError) fail(`free tool ${freeCall.name} returned error: ${fr.content?.[0]?.text?.slice(0, 200)}`);
console.log(`PASS free tool ${freeCall.name} (no token)`);

const paidCall = JSON.parse(process.env.MCPB_TEST_PAID_CALL);
const pr = await client.callTool(paidCall);
const txt = pr.content?.[0]?.text ?? '';
if (!pr.isError || !txt.includes('APIFY_TOKEN_MISSING')) fail(`paid tool ${paidCall.name} without token: ${txt.slice(0, 200)}`);
console.log(`PASS paid tool ${paidCall.name} without token -> APIFY_TOKEN_MISSING (no network call)`);

await client.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('MCPB TEST PASS');
