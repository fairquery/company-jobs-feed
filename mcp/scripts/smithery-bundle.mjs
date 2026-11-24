/**
 * Builds the Smithery upload variant of the MCPB bundle.
 *
 * Why: Smithery CLI 1.2.0 (`smithery mcp publish x.mcpb`) copies manifest.json `tools` verbatim into an MCP server card,
 * and Smithery's API validates each card tool as an MCP Tool, which requires an `inputSchema` object. The MCPB 0.3 manifest
 * schema only allows {name, description} per tool, so a spec-valid bundle that lists tools is rejected with
 * 400 "Invalid input: expected object, received undefined" (one per tool).
 *
 * What: copies the spec-valid bundle and replaces only manifest.json, adding each tool's inputSchema / outputSchema /
 * annotations taken from the built server's own tools/list (so the card always matches the code). Everything else
 * (files, permissions, mcp_config, user_config) is byte-identical. Hosts that parse MCPB manifests loosely (Smithery's
 * runner, @anthropic-ai/mcpb loose schemas) ignore or strip the extra keys; the canonical bundle stays spec-valid.
 *
 * Usage: node scripts/smithery-bundle.mjs <stageDir> <canonical.mcpb> <out-smithery.mcpb>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [stage, canonical, out] = process.argv.slice(2).map((p) => path.resolve(p));
if (!stage || !canonical || !out) throw new Error('usage: smithery-bundle.mjs <stageDir> <canonical.mcpb> <out.mcpb>');
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const env = { ...process.env };
delete env.APIFY_TOKEN; // tools/list needs no token; never use this machine's token
const client = new Client({ name: 'fairquery-smithery-card', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(stage, manifest.server.entry_point)], env, stderr: 'pipe' }));
const { tools: live } = await client.listTools();
await client.close();
const byName = new Map(live.map((t) => [t.name, t]));
const declared = manifest.tools.map((t) => t.name);
if (declared.length !== live.length || declared.some((n) => !byName.has(n))) {
    throw new Error(`manifest.tools (${declared.join(',')}) != tools/list (${live.map((t) => t.name).join(',')})`);
}
manifest.tools = manifest.tools.map((t) => {
    const l = byName.get(t.name);
    if (!l.inputSchema || typeof l.inputSchema !== 'object') throw new Error(`${t.name}: no inputSchema`);
    return {
        name: t.name,
        description: t.description,
        inputSchema: l.inputSchema,
        ...(l.outputSchema ? { outputSchema: l.outputSchema } : {}),
        ...(l.annotations ? { annotations: l.annotations } : {}),
    };
});
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smithery-manifest-')), 'manifest.json');
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
// Re-zip with Python's zipfile: copy every entry (incl. unix permissions) and swap only manifest.json.
execFileSync('python3', ['-c', `
import sys, zipfile
src, dst, man = sys.argv[1:4]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zo:
    names = zi.namelist()
    assert 'manifest.json' in names
    for info in zi.infolist():
        data = open(man, 'rb').read() if info.filename == 'manifest.json' else zi.read(info.filename)
        zo.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
`, canonical, out, tmp]);
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(`Built ${path.relative(process.cwd(), out)} (${manifest.tools.length} tools with inputSchema for Smithery's server card)`);
