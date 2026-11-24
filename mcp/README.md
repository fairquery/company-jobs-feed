# fairquery-jobs-feed MCP server

**Indexed Jobs search is coming soon:** faster and more comprehensive than the free 135-board live scan. Indexed search covers 8,700+ boards. **Get 8,700+ boards free with Apify's $5 starter credit:** create an Apify account and an API token at https://console.apify.com/settings/integrations. `jobs_search_companies` is temporarily offline until that release and does not run the old paid Actor `fairquery/company-jobs-feed` (the call is not billed).

stdio MCP server for [Company Jobs Feed](https://getfairquery.com/tools/). Free local tools `jobs_get_board`, `jobs_get_job`, `jobs_find_board`, `jobs_check_open`, `jobs_list_seed_boards`, `jobs_search_by_location` read Greenhouse, Lever and Ashby official APIs, plus Personio's documented XML feed, Pinpoint's documented `postings.json` feed, and Gem's documented `job_posts` list when you name the account, subdomain or vanity. The free place scan stays at 135 starter boards, with the same wall-clock, CPU, and request budgets. `jobs_search_by_location` needs no company name and no token (for example `{"locations":["Baltimore MD"],"descriptionIncludes":["avionics"]}`). Its `meta.notice` (also `meta.notes[0]`) repeats the coming-soon note; a partial scan says how many of the 135 boards that call finished. Personio, Pinpoint and Gem are not discovered. Pinpoint and Gem rows link out and do not copy the ad. Pinpoint is CLEAR-with-conditions after the 2026-10-26 ~8:00 PM ET AUP PDF skim (`policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md`). Gem is separate: an accepted-risk override of Policy's BLOCK lean. This package is not published from this change.

```bash
npx -y @fairquery/company-jobs-feed-mcp   # from npm
# from source:
npm ci --ignore-scripts && npm run build && node dist/index.js
npm test   # shared-source check + smoke test + jobs_get_job (no token, no network)
```

`src/shared/` is generated from `../src` by `npm run sync`; do not edit it here. Docs and details: https://getfairquery.com/tools/. Security: https://getfairquery.com/security/.

## MCPB bundle (Smithery local install, Claude Desktop)
`manifest.json` describes an [MCPB](https://github.com/modelcontextprotocol/mcpb) bundle that runs this server locally over stdio. The bundle asks for one optional, sensitive setting: **your own** Apify API token, for when indexed search returns. Leave it empty to use the free tools. `jobs_search_companies` returns `COMING_SOON` and does not start an Actor run.

```bash
npm run build:mcpb   # -> build/fairquery-company-jobs-feed-mcp-<version>.mcpb (dist + production node_modules)
npm run test:mcpb    # unpack, initialize, tools/list, free call, jobs_search_companies -> COMING_SOON
```

`build:mcpb` also writes `<name>-smithery.mcpb`, the file to upload to Smithery. It is the same bundle with only `manifest.json` changed: each tool also carries its `inputSchema`, `outputSchema` and `annotations`, taken from the server's own `tools/list`. Smithery's publish API needs these for its server card, but the MCPB 0.3 manifest schema allows only `name`/`description` per tool, so the canonical `.mcpb` keeps the spec-valid manifest. `test:mcpb` tests both bundles and checks that they differ only in those tool schemas.
