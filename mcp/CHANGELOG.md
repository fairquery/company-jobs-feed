# Changelog (@fairquery/company-jobs-feed-mcp)

## 1.1.19 - 2026-10-31
- `jobs_search_by_location`: every result includes `meta.notice` (also `meta.notes[0]`). Indexed Jobs search is coming soon (faster than this free 135-board live scan; indexed search covers 8,700+ boards). A partial or incomplete walk starts that note with how many of the starter boards this call finished. Every result says: Get 8,700+ boards free with Apify's $5 starter credit, and points at https://console.apify.com/settings/integrations. Free limits are unchanged (135 boards, 25 s wall clock, 12,000 ms CPU budget, 300 requests, row cap 200).
- `jobs_search_companies` returns `COMING_SOON` and does not start `fairquery/company-jobs-feed`, with or without `APIFY_TOKEN`. The call is not billed. Free tools stay.
- Tool text, package description, README, manifest, Gemini extension, and MCP registry description lead with the same coming-soon note. Not published from this change.

## 1.1.18 - 2026-10-27
- `jobs_search_by_location`: a board GET that fails before any job is read (network error, timeout, or HTTP 5xx) is retried once after 300 ms. The retry counts toward the 300-request cap and is named in `meta.notes` (`retrying once after NETWORK_ERROR` or `ATS_HTTP_ERROR`). A second failure is still skipped and named (`NETWORK_ERROR` or `ATS_HTTP_ERROR`). The board still counts as started, so `next_board_cursor` does not rewind. HTTP 403/429 still kill the host and are not retried. The retry is skipped when the CPU budget, the 25 s wall clock (not enough time left for the pause), or the request cap is already spent. Soft-stop ceilings are unchanged (CPU 12,000 ms, 300 ATS requests, row cap 200, title-only over 1,000 jobs, amp decode, `boardCursor`).
- In-flight starter boards for that scan: 6 → 4 (`LOCATION_SCAN_CONCURRENCY`). Per-host cap stays 2 (`HOST_CONCURRENCY`). The Actor multi-board pool stays 6. Greenhouse stays at two at a time so those boards still fit the 25 s wall clock. No index, no stored postings, no budget increase. Not published from this change.

## 1.1.17 - 2026-10-27
- `jobs_search_by_location`: titles and keyword text. Greenhouse (Rails) JSON encodes `&` as `\u0026`. The place-scan string reader treated that escape as the digits `0026`, so an Anduril title rendered as `Avionics 0026 Electronics`. The same bytes are now `&`. Literal `&amp;`, `&#38;`, and `&#x26;` in Greenhouse, Lever, Ashby, Pinpoint, and Gem titles, departments, and locations decode to the same character the row shows, and description excerpts are decoded before the keyword check. No budget, seed, or index change.
- `meta.next_board_cursor` is the first starter board this call did not start. It is null only when every board from `board_cursor` through the end was started, or none remain. A board that errors still counts as started, so the cursor does not rewind behind boards that already ran (a Costa Mesa pass could report cursor 86 while `boards_reached` was near the end of 135). A `cpu_budget`, `subrequest_budget`, `time_budget`, or `row_cap` stop in the middle of the list still sets the cursor. Pass it back as `boardCursor` with the same place and keywords. Not published from this change.

## 1.1.16 - 2026-10-27
- `jobs_search_by_location`: Paid Workers ceilings only. The hosted account is Workers Paid (~30 s CPU default, up to 5 minutes, 10,000 subrequests). The free-tool CPU soft-stop and the ATS request soft cap stay; neither is removed and neither run is unbounded. No index, no stored postings, no crawler, no paid SKU, no relevance-order change. No `limits.cpu_ms` in this repo, so the Paid CPU default is left in place. Not published from this change.
  - `LOCATION_SCAN_CPU_BUDGET_MS` 1,000 → 12,000 ms of charged work (still 8,000 JSON characters per millisecond, plus 0.08 ms per row). 1.1.15 soft-stopped a Costa Mesa + avionics scan near starter board 26 on `cpu_budget`. Anduril is index 32. Scaling that live stop across the starter list (~28,000 jobs) is about 4 seconds, so 12 seconds covers a typical place-and-keyword pass and still returns partial JSON (`meta.partial`, `meta.stop_reason` `cpu_budget`, `meta.next_board_cursor`) before the Paid ~30 s CPU kill.
  - `LOCATION_SCAN_MAX_REQUESTS` 36 → 300. Free allowed 50 subrequests, which is why 1.1.15 used 36. A full starter pass is 135 lite lists plus a Greenhouse body only when a place hit still needs a description and the board has at most 1,000 jobs. Anduril and SpaceX skip that body, so the worst case is 135 + 88 = 223 requests. 300 covers that and a few requests already in flight, and is far under 10,000. Hitting it still returns `stop_reason` `subrequest_budget` and `next_board_cursor`.
  - Title-only for Greenhouse boards over 1,000 jobs stays (Anduril's body is about 44 MB; the isolate is 128 MB). Row cap 200, partial JSON, `boardCursor`, and the handler catch stay.
  - The 25 s wall clock is unchanged. Lever is still one request per second (15 Lever boards). A slow call can still stop with `time_budget` and `next_board_cursor` before the last board. CPU and the request cap should no longer be what stops Costa Mesa + avionics before Anduril.

## 1.1.15 - 2026-10-27
- `jobs_search_by_location`: live Free-Worker fixes only. No index, no stored postings, no price change. Not published from this change.
  - A Greenhouse body request that throws after the CPU budget no longer drops title matches already found on the lite list.
  - Row building counts toward the CPU budget (0.08 ms per row, on top of 8,000 JSON characters per millisecond). A cap of 200 matched rows returns partial JSON with `meta.stop_reason` `row_cap` instead of dying on an empty-keyword place search (for example PA with no keyword).
  - Title and department are matched on the Greenhouse lite list before any body request. Boards with more than 1,000 jobs skip the body (hosted Free limit; the free tool uses the same rule locally) and are listed in `meta.title_only_boards`.
  - `boardCursor` / `meta.next_board_cursor` continue at the first board the previous call did not start. `offset` still pages rows inside one response.
  - Coverage: `meta.boards_reached`, `meta.complete`, `meta.cut`, `meta.stop_reason`, `meta.next_board_cursor`. A scan error returns that JSON (`stop_reason` `error`) instead of an uncaught Server error.
  - The tool text no longer says this searches all companies. The starter list is 135 Greenhouse, Lever and Ashby boards.

## 1.1.14 - 2026-10-27
- `jobs_search_by_location`: the hosted Free-plan Worker still died with `exceededCpu` (~2,010 ms of CPU, empty SSE body) because the CPU soft-stop was an 8,000 ms `performance.now()` budget. That clock does not advance during synchronous parsing on a deployed Worker, so the meter stayed near zero and the isolate was killed before any MCP JSON. The scan now charges the CPU budget from characters walked (8,000 per estimated millisecond, 1,000 ms budget, 8 MB) and still stops on the 25 second wall clock. A board over 3 MB is still cut and the other boards continue. An early stop returns the jobs already matched (`meta.partial`, `meta.stop_reason` `cpu_budget` or `time_budget`, `meta.cost_usd` 0). No price or pay-per-event change. Not published from this change.

## 1.1.13 - 2026-10-27
- `jobs_search_by_location`: the hosted Worker still died with exceededCpu while scanning 135 starter boards, before the 60 second wall budget could return JSON. The place scan now reads each board in 8 KB slices without a per-character await, skips description fields unless a place hit needs them, and cuts a board after 3 MB. It returns the jobs already matched when synchronous work reaches 8 seconds (`meta.partial`, `meta.stop_reason` `cpu_budget`) or the wall clock reaches 25 seconds (`time_budget`). `meta.cost_usd` stays 0. No price or pay-per-event change. Not published from this change.

## 1.1.12 - 2026-10-27
- `jobs_search_by_location`: the hosted Worker was answering HTTP 200 with an empty body. Greenhouse `content=true` for Anduril is about 44 MB (above the 40 MB read cap) and the Worker isolate is 128 MB, so buffering that body killed the isolate before any MCP JSON was written. The place scan now streams each board one job at a time and does not download Greenhouse job bodies unless `descriptionIncludes` or `includeDescription` needs them and the short list already has a job in that place. A text field longer than 80,000 characters is cut before matching. A board error is skipped. The scan stops at a 60 second time budget and returns the jobs already matched (`meta.partial`, `meta.stop_reason` `time_budget`, `meta.boards_skipped`). `meta.cost_usd` stays 0. No price or pay-per-event change. Not published from this change.

## 1.1.11 - 2026-10-27
- `jobs_search_by_location`: call this for a place or role with no company name ("avionics jobs in Baltimore MD", "remote RN jobs in PA"). Do not ask for a company and do not call `jobs_get_board` or `jobs_find_board` first. New `descriptionIncludes` matches a whole word in the title or the scrubbed description from the same board request (no extra host). `includeDescription` still controls whether `description_text` is returned. When a successful scan matches nothing, `meta.suggestions` lists tokens tried, place aliases that had open roles, a sample of titles in that place, and which CLEAR ATS the starter list covers. No fabricated jobs. `meta.cost_usd` stays 0.
- Location aliases: Baltimore, Baltimore MD and BWI match each other. MD and Maryland still match through the state pair, including "Baltimore, MD". Baltimore does not expand to every Maryland posting.
- Starter list: 51 -> 135. 84 Greenhouse, Lever and Ashby boards verified 2026-10-27 (`api_live_probe`) in aerospace, defense, healthcare, manufacturing and nearby industries. Personio, Pinpoint and Gem stay named accounts only. Workday, LinkedIn, SmartRecruiters, Recruitee, Rippling, iCIMS, Taleo and SuccessFactors stay out. No price or pay-per-event change. Not published from this change.

## 1.1.10 - 2026-10-27
- `jobs_search_by_location`: free local tool that scans the bundled starter boards and returns live jobs for a place. A place signal is required (`locations`, `countries`, or `remote: "only"`); otherwise `INVALID_INPUT` and no fetch. Example: `{"locations":["Tampa"]}`. Missing boards are skipped (`BOARD_NOT_FOUND` counted in `meta.notes`). `HOST_BLOCKED` stops that host for the session and is listed in `meta.notes`; other hosts continue. `meta` also reports `boards_scanned`, `boards_ok`, `boards_failed`, `jobs_matched` and `cost_usd` 0. No `APIFY_TOKEN`. The full starter list is scanned. No price or pay-per-event change. Not published from this change.
- Location filters expand US state names and postal codes both ways (Florida and FL, including Tampa, FL) and a short metro alias list (NYC / New York City, SF / Bay Area / San Fran, LA / Los Angeles, DC / D.C. / Washington DC, Philly, Tampa / Tampa Bay, plus Chicago, Boston, Seattle, Austin, Denver, Miami, Atlanta, Dallas, Houston, Phoenix, Portland, Detroit and Minneapolis on the name itself). Two-letter codes match as whole tokens, so `or` is not a substring alias. Shared by the Actor and the free tools via `src/filters.ts`. Countries stay ISO-2. No geocoding and no new ATS.

## 1.1.9 - 2026-10-26
- Pinpoint public career-page listings, named subdomains only. `jobs_get_board`, `jobs_get_job` and `jobs_check_open` accept `ats: "pinpoint"` plus the company subdomain you supply. The only job request is `GET https://{subdomain}.pinpointhq.com/postings.json` after that host's robots.txt (serial, at most 1 request/second per tenant). No login, no API key, no `/api/v1`. `description_text` stays empty; `job_url` is the listing link. Emails and phones are not kept. Subdomains are not discovered, not probed and not taken from careers-page links. `jobs_find_board` parses a Pinpoint URL or `pinpoint:subdomain` with no network call. Policy CLEAR-with-conditions after the 2026-10-26 ~8:00 PM ET AUP PDF skim (`policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md`). Lawyer note, not a hold: AUP preamble and §7 may reach non-customers. Privacy-page source list still needs Pinpoint when this ships; the site is not edited here.
- Gem public job-posts list, named vanity paths only. Same three tools accept `ats: "gem"` plus the vanity you supply. The only job request is `GET https://api.gem.com/job_board/v0/{vanity}/job_posts/`. No Gem API key, no POST applications, no departments or offices endpoints (those fields are inline). `description_text` stays empty; `job_url` points at `jobs.gem.com`. Vanities are not discovered or probed. ACCEPTED RISK: Policy's lean was BLOCK (browsewrap Terms plus AUP limit use to talent acquisition and bar sales and commercial marketing). Fairquery overrode that lean on 2026-10-26 (~7:50 PM EDT, via TM t757). Same policy draft.
- No price or pay-per-event change. LinkedIn, Workday, SmartRecruiters, Recruitee and Rippling stay unsupported. Workable stays excluded.

## 1.1.8 - 2026-10-24
- Personio public XML, named accounts only. `jobs_get_board`, `jobs_get_job` and `jobs_check_open` accept `ats: "personio"` plus the company subdomain you supply. The only job request is `GET https://{account}.jobs.personio.de/xml` after that host's robots.txt. Accounts are not discovered, not probed and not taken from careers-page links. `jobs_find_board` parses a Personio URL or `personio:account` with no network call. No price or pay-per-event change. LinkedIn, Workday, SmartRecruiters, Recruitee and Rippling stay unsupported.

## Unreleased
- `jobs_get_job`: free local tool that returns one published job's full detail (the same normalized job row as `jobs_get_board`, including scrubbed `description_text`) from the official Greenhouse, Lever or Ashby API. No `APIFY_TOKEN`. `meta.cost_usd` is 0. A missing or closed id is `JOB_CLOSED`; a missing board is `BOARD_NOT_FOUND`. No price or pay-per-event change. `jobs_check_open` stays the open/closed re-check.

## 1.1.7 - 2026-10-24
- Dependencies only (no tool, schema, limit or price changes): production `npm audit --omit=dev` is clean.
  - `zod` `^3.24.0` (locked 3.25.76) to `^4.6.6` (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections; no patched 3.x). `@modelcontextprotocol/sdk` already accepts `zod` `^4.0`.
  - Overrides keep transitive `body-parser` on `^2.4.0` (GHSA-27r3-jxmh-p828; express allows `^2.3.0`) and `fast-uri` on `^3.1.9` (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr and the low advisories fixed in the same release; ajv stays on fast-uri 3.x).

## 1.1.4 - 2026-10-20
- Contact details only (no tool, schema, limit or price changes): the package `author` is now `{"name":"Fairquery","email":"info@getfairquery.com"}`, the MCPB manifest and Cursor plugin author emails are info@getfairquery.com, and so is the contact in the HTTP User-Agent sent to the ATS APIs and careers pages.
- Tool text only (Glama conciseness pass; no behavior change): jobs_check_open PARAMETERS no longer repeats the jobKey-wins rule from the schema or the "closed job -> job = null" rule from RETURNS.

## 1.1.3 - 2026-10-19
- Metadata only (no code, tool, schema, limit or price changes): `mcpName` is now `com.getfairquery/company-jobs-feed-mcp`. The official MCP Registry entry moved to the getfairquery.com domain namespace; the old `io.github.fairquery/company-jobs-feed-mcp` entry is no longer updated.

## 1.1.2 - 2026-10-19
- Metadata and docs only (no code, tool, schema, limit or price changes): `bugs` now points to getfairquery.com (support: info@getfairquery.com), the `repository` field is removed, and README and MCPB manifest links point to getfairquery.com.

## 1.1.1 - 2026-10-18
- Packaging only (no code, tool, schema, limit or price changes):
  - `gemini-extension.json` at the repo root: install as a Gemini CLI extension from the source repository (no longer available). It runs `npx -y @fairquery/company-jobs-feed-mcp@1.1.1` and asks for one optional, sensitive setting (your own `APIFY_TOKEN`, only for jobs_search_companies).
  - `.mcp.json` and `.cursor-plugin/plugin.json` at the repo root for Cursor plugin directories (cursor.directory).
  - Security dependency overrides from the repo (basic-ftp, vitest) apply to the Actor at the repo root, not to this package.

## 1.1.0 - 2026-10-18
- `jobs_check_open`: new optional `includeDescription` (default false). When the job is open, the open_check row gets `job`: the same full job row jobs_get_board returns (title, location, compensation, posted_at, description_text, ...); closed jobs get `job: null`. No extra request on Greenhouse and Lever (the per-job response already holds the text); on Ashby the board download includes descriptions. Without the flag the row is unchanged.
- Smoke test (`--live`) covers Greenhouse, Ashby and a closed id with includeDescription.

## 1.0.6 - 2026-10-18
- Tool descriptions only (Glama conciseness pass; no behavior, input, limit or price changes):
  - All tools: "free" / no-token statements appear once (COST); RETURNS no longer repeats field lists that `outputSchema` defines.
  - `jobs_find_board`: RETURNS explains `via` / `confidence` and `NO_BOARD_FOUND`; PARAMETERS documents the company-name candidates (legal suffixes such as inc/llc/gmbh/plc stripped), probe order greenhouse -> lever -> ashby (first hit wins) and that a starter-list hit can return several high-confidence boards.
  - `jobs_check_open`: WHEN NOT points to `jobs_get_board` with `includeDescription=true` for a job's full text; RETURNS lists `INVALID_INPUT`, `BOARD_NOT_FOUND`, `HOST_BLOCKED`, `NETWORK_ERROR`; PARAMETERS notes the full-board download on Ashby and the extra board request after a Greenhouse/Lever 404.
  - `jobs_list_seed_boards`: RETURNS states the fixed bundled order grouped by ATS (34 Greenhouse, 4 Lever, 13 Ashby); `meta.by_ats` ignores the `ats` filter. Fix: the `limit` default is documented as 100 (the code default; the text said 50).

## 1.0.5 - 2026-10-18
- Tool descriptions only (no behavior, input, limit or price changes):
  - `jobs_check_open`: `ats`, `slug` and `jobId` now say "Required unless jobKey is given" (the schema keeps them optional because `jobKey` can replace them) and spell out the formats: `jobKey` = `"{ats}:{slug}:{job_id}"` with lowercase ats, slug charset/length, numeric Greenhouse ids vs. UUIDs on Lever/Ashby; a malformed `jobKey` returns `INVALID_INPUT`.
  - `jobs_search_companies`: `remote` lists `"any" | "only" | "exclude"` (default `"any"`) and what each keeps; `postedWithinDays` drops rows without an ATS publish date; `excludeStale` defines `long_open` (age > 60 days) and `reposted` (needs history in `stateStoreName`, never on a board's first tracked run). Closed rows are not filtered by either.
  - `jobs_find_board`: documents the 403/429 kill switch like its siblings: the host is stopped for the session (also for the other free tools), the call adds a `HOST_BLOCKED` note to `meta.notes` instead of failing, and later probes to a stopped host are skipped.
  - `jobs_get_board`, `jobs_list_seed_boards`: shorter RETURNS sections. Slug/jobKey format placeholders use `{slug}` instead of `<slug>` (some directories strip angle brackets as HTML).

## 1.0.4 - 2026-10-18
- Metadata: the Fairquery blog moved to https://getfairquery.com, so `homepage` (npm), `websiteUrl` (MCP Registry), the MCPB manifest author URL, homepage and privacy policy, and the HTTP User-Agent (`FairqueryJobsFeed/1.0 (+https://getfairquery.com; info@getfairquery.com)`) now point there (old fairquery.github.io links 301). No tool, input, limit or price changes.
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
