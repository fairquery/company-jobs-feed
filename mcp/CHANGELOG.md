# Changelog (@fairquery/company-jobs-feed-mcp)

## Unreleased (repo only, not an npm release; npm package unchanged)
- Packaging: `npm run build:mcpb` also builds `<name>-smithery.mcpb` for Smithery uploads. Smithery CLI 1.2.0 passes manifest `tools` straight into an MCP server card, and Smithery's API rejects tools that have no `inputSchema` (`400 Invalid input: expected object, received undefined`, once per tool). The MCPB 0.3 manifest allows only `name`/`description`, so the variant adds each tool's `inputSchema`/`outputSchema`/`annotations` from the server's own `tools/list`, and changes nothing else. `test:mcpb` checks both bundles, the Smithery card (valid MCP Tools, optional `apify_token`), and that the two differ only in those tool schemas.

## 1.0.3 - unreleased (staged 2026-10-18)
- Tool descriptions (no behavior change): `jobs_find_board` documents its rate limits and retries (max 2 parallel requests per host, Lever 1 s spacing, 15 s timeout, network/5xx retried at most twice with backoff, 403/429 never retried) and its worst-case request count; `jobs_get_board` and `jobs_list_seed_boards` RETURNS no longer repeat the output-schema field list.
- npm metadata: more `keywords` (mcp-server, model-context-protocol, job-listings, job-postings, greenhouse-api, lever-api, ai-agents, claude, cursor, recruiting); `homepage` points to the guide.
- No tool, input, limit or price changes.

## 1.0.2 - 2026-10-18
- Fix: an empty, placeholder or unsubstituted `APIFY_TOKEN` (for example `""`, `${user_config.apify_token}` as passed by Smithery's local runner when the optional token setting is left blank, `<your-apify-token>`, `{{APIFY_TOKEN}}`, `$APIFY_TOKEN`, `%APIFY_TOKEN%`, `undefined`, `null`) is now treated as missing, so `jobs_search_companies` returns `APIFY_TOKEN_MISSING` locally instead of calling Apify and failing with `APIFY_TOKEN_INVALID`. Surrounding whitespace and one layer of quotes are stripped from real tokens. The token is never logged.
- Tests: `scripts/test-token.mjs` (unit cases plus Smithery-runner and MCPB-host emulation of the manifest's `mcp_config`), run by `npm test` and by `npm run test:mcpb` against the unpacked bundle.
- Packaging: MCPB bundle (`mcp/manifest.json`, icon, `npm run build:mcpb` / `npm run test:mcpb`) for local installs. No tool, input, limit or price changes.

## 1.0.1 - 2026-10-17
- Fix the npm `bin` entry; add `server.json` for the official MCP Registry (`io.github.fairquery/company-jobs-feed-mcp`).

## 1.0.0 - 2026-10-17
- First npm release: 5 tools (free seed-board/ATS helpers, paid `jobs_search_companies` via the Fairquery Company Jobs Feed Actor).
