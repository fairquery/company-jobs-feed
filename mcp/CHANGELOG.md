# Changelog (@fairquery/company-jobs-feed-mcp)

## 1.0.2 - 2026-10-18
- Fix: an empty, placeholder or unsubstituted `APIFY_TOKEN` (for example `""`, `${user_config.apify_token}` as passed by Smithery's local runner when the optional token setting is left blank, `<your-apify-token>`, `{{APIFY_TOKEN}}`, `$APIFY_TOKEN`, `%APIFY_TOKEN%`, `undefined`, `null`) is now treated as missing, so `jobs_search_companies` returns `APIFY_TOKEN_MISSING` locally instead of calling Apify and failing with `APIFY_TOKEN_INVALID`. Surrounding whitespace and one layer of quotes are stripped from real tokens. The token is never logged.
- Tests: `scripts/test-token.mjs` (unit cases plus Smithery-runner and MCPB-host emulation of the manifest's `mcp_config`), run by `npm test` and by `npm run test:mcpb` against the unpacked bundle.
- Packaging: MCPB bundle (`mcp/manifest.json`, icon, `npm run build:mcpb` / `npm run test:mcpb`) for local installs. No tool, input, limit or price changes.

## 1.0.1 - 2026-10-17
- Fix the npm `bin` entry; add `server.json` for the official MCP Registry (`io.github.fairquery/company-jobs-feed-mcp`).

## 1.0.0 - 2026-10-17
- First npm release: 5 tools (free seed-board/ATS helpers, paid `jobs_search_companies` via the Fairquery Company Jobs Feed Actor).
