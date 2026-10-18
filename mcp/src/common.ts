/**
 * Shared helpers: MCP result shaping, paging and the Apify Actor proxy.
 * APIFY_TOKEN is read from the environment only when the paid tool is called; it is never logged or returned.
 */
import { z } from 'zod';

const APIFY_BASE = 'https://api.apify.com/v2';
export const ACTOR_ID = 'fairquery~company-jobs-feed';

export const READ_ONLY_OPEN_WORLD = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const READ_ONLY_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Paged output schema shared by every tool. */
export const pagedOutputSchema = {
    count: z.number().int().describe('Number of items in this page'),
    total: z.number().int().describe('Total items after filters, before paging'),
    offset: z.number().int().describe('Offset of the first item in this page'),
    hasMore: z.boolean().describe('True if more items exist after this page'),
    nextOffset: z.number().int().nullable().describe('Offset to pass for the next page, or null when done'),
    items: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
            'Result rows. Each has "type": "job" (job_key, title, company, locations, countries, remote, posted_at, verified_open_at, age_days, long_open, apply_url, source_url, ...), "board", "company", "seed_board", "open_check" or "error" (code, message, retryable)',
        ),
    meta: z.record(z.string(), z.unknown()).optional().describe('Tool-specific context: board totals, request counts, cost notes'),
};

export type ToolResult = {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

export function paged(all: unknown[], limit: number, offset: number, meta?: Record<string, unknown>): ToolResult {
    const items = all.slice(offset, offset + limit) as Record<string, unknown>[];
    const next = offset + items.length;
    const structured: Record<string, unknown> = {
        count: items.length,
        total: all.length,
        offset,
        hasMore: next < all.length,
        nextOffset: next < all.length ? next : null,
        items,
    };
    if (meta) structured.meta = meta;
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

export function errorResult(code: string, message: string, retryable = false): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error: code, message, retryable }, null, 2) }], isError: true };
}

/**
 * Normalizes a user-supplied APIFY_TOKEN. Returns undefined (treated as "missing", so paid tools return
 * APIFY_TOKEN_MISSING) when the value is empty or is an unfilled placeholder / unsubstituted template, e.g.
 * '', '${user_config.apify_token}' (MCPB/Smithery runners leave this when the optional setting is blank),
 * '<your-apify-token>', '{{APIFY_TOKEN}}', '$APIFY_TOKEN', '%APIFY_TOKEN%', 'undefined', 'null'.
 * The value itself is never logged or returned to the client.
 */
export function normalizeApifyToken(raw: string | undefined | null): string | undefined {
    if (raw == null) return undefined;
    let v = String(raw).trim();
    // Strip one layer of matching surrounding quotes ("..." or '...') left by some config UIs.
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
    if (!v) return undefined;
    if (v.includes('${') || v.includes('{{') || v.includes('}}')) return undefined; // unsubstituted template
    if (/^<[^>]*>$/.test(v)) return undefined; // <your-apify-token>
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return undefined; // $APIFY_TOKEN (unexpanded shell var)
    if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v)) return undefined; // %APIFY_TOKEN% (unexpanded Windows var)
    if (/^(undefined|null|none|nil|false|0|changeme|your[-_ ]?(apify[-_ ]?)?(api[-_ ]?)?token|apify[-_]token)$/i.test(v)) return undefined;
    if (/\s/.test(v)) return undefined; // tokens never contain whitespace; e.g. "paste your token here"
    return v;
}

export function getToken(): string | undefined {
    return normalizeApifyToken(process.env.APIFY_TOKEN);
}

export const MISSING_TOKEN_MESSAGE =
    'Set the APIFY_TOKEN environment variable to your Apify API token (https://console.apify.com/settings/integrations). The free tools, initialize and tools/list work without a token.';

/** Runs the Actor synchronously (max 300 s wait) and returns its dataset items. */
export async function runActor(input: Record<string, unknown>, token: string): Promise<unknown[]> {
    const res = await fetch(`${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?timeout=300`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    if (!res.ok) {
        const detail = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor run failed (HTTP ${res.status}): ${detail.slice(0, 1500)}`);
    }
    return Array.isArray(body) ? body : [body];
}

export function compact(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
    return out;
}
