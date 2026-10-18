# Changelog (@fairquery/company-jobs-feed-mcp)

## 1.0.5 - 2026-10-18
- Tool descriptions only (no behavior, input, limit or price changes):
  - `jobs_check_open`: `ats`, `slug` and `jobId` now say "Required unless jobKey is given" (the schema keeps them optional because `jobKey` can replace them) and spell out the formats: `jobKey` = `"{ats}:{slug}:{job_id}"` with lowercase ats, slug charset/length, numeric Greenhouse ids vs. UUIDs on Lever/Ashby; a malformed `jobKey` returns `INVALID_INPUT`.
  - `jobs_search_companies`: `remote` lists `"any" | "only" | "exclude"` (default `"any"`) and what each keeps; `postedWithinDays` drops rows without an ATS publish date; `excludeStale` defines `long_open` (age > 60 days) and `reposted` (needs history in `stateStoreName`, never on a board's first tracked run). Closed rows are not filtered by either.
  - `jobs_find_board`: documents the 403/429 kill switch like its siblings: the host is stopped for the session (also for the other free tools), the call adds a `HOST_BLOCKED` note to `meta.notes` instead of failing, and later probes to a stopped host are skipped.
  - `jobs_get_board`, `jobs_list_seed_boards`: shorter RETURNS sections. Slug/jobKey format placeholders use `{slug}` instead of `<slug>` (some directories strip angle brackets as HTML).

## 1.0.4 - 2026-10-18
- Metadata: the Fairquery blog moved to https://getfairquery.com, so `homepage` (npm), `websiteUrl` (MCP Registry), the MCPB manifest author URL, homepage and privacy policy, and the HTTP User-Agent (`FairqueryJobsFeed/1.0 (+https://getfairquery.com; fairquery@proton.me)`) now point there (old fairquery.github.io links 301). No tool, input, limit or price changes.
- Packaging: `npm run build:mcpb` also builds `<name>-smithery.mcpb` for Smithery uploads. Smithery CLI 1.2.0 passes manifest `tools` straight into an MCP server card, and Smithery's API rejects tools that have no `inputSchema` (`400 Invalid input: expected object, received undefined`, once per tool). The MCPB 0.3 manifest allows only `name`/`description`, so the variant adds each tool's `inputSchema`/`outputSchema`/`annotations` from the server's own `tools/list`, and changes nothing else. `test:mcpb` checks both bundles, the Smithery card (valid MCP Tools, optional `apify_token`), and that the two differ only in those tool schemas.

## 1.0.3 - 2026-10-18
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
