/**
 * Fail when scripts/mcp-public-surface.ts no longer names the same symbols
 * mcp/src/index.ts imports from ./shared/. Knip reads the surface file; the MCP
 * server reads the generated copies.
 */
import { readFileSync } from 'node:fs';

const mcp = readFileSync(new URL('../mcp/src/index.ts', import.meta.url), 'utf8');
const surface = readFileSync(new URL('./mcp-public-surface.ts', import.meta.url), 'utf8');

function namedImports(source, specRe) {
    const map = new Map();
    const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(re)) {
        const spec = specRe.exec(match[2]);
        if (!spec) continue;
        const file = spec[1];
        const names = match[1]
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
        const set = map.get(file) ?? new Set();
        for (const name of names) set.add(name);
        map.set(file, set);
    }
    return map;
}

function diff(label, left, right) {
    const errors = [];
    const files = new Set([...left.keys(), ...right.keys()]);
    for (const file of [...files].sort()) {
        const a = left.get(file) ?? new Set();
        const b = right.get(file) ?? new Set();
        const missing = [...a].filter((name) => !b.has(name)).sort();
        const extra = [...b].filter((name) => !a.has(name)).sort();
        if (missing.length) errors.push(`${label} ${file} missing: ${missing.join(', ')}`);
        if (extra.length) errors.push(`${label} ${file} unexpected: ${extra.join(', ')}`);
    }
    return errors;
}

const fromMcp = namedImports(mcp, /^\.\/shared\/(.+)\.js$/);
const fromSurface = namedImports(surface, /^\.\.\/src\/(.+)\.js$/);
const errors = diff('mcp/src/index.ts vs scripts/mcp-public-surface.ts', fromMcp, fromSurface);
if (errors.length) {
    console.error('unused-symbol: MCP shared import surface drifted');
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
}
console.log('MCP shared import surface matches scripts/mcp-public-surface.ts');
