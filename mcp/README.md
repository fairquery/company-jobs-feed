# fairquery-jobs-feed MCP server

stdio MCP server for [Company Jobs Feed](https://github.com/fairquery/company-jobs-feed). Free local tools `jobs_get_board`, `jobs_find_board`, `jobs_check_open`, `jobs_list_seed_boards`; paid `jobs_search_companies` (Apify Actor `fairquery/company-jobs-feed`, needs `APIFY_TOKEN`).

```bash
npx -y @fairquery/company-jobs-feed-mcp   # from npm
# from source:
npm ci --ignore-scripts && npm run build && node dist/index.js
npm test   # shared-source check + smoke test (no token, no network)
```

`src/shared/` is generated from `../src` by `npm run sync`; do not edit it here. See the [repository README](../README.md) for tool details and [SECURITY.md](../SECURITY.md).

## MCPB bundle (Smithery local install, Claude Desktop)
`manifest.json` describes an [MCPB](https://github.com/modelcontextprotocol/mcpb) bundle that runs this server locally over stdio. The bundle asks for one optional, sensitive setting: **your own** Apify API token, only needed for `jobs_search_companies`. Leave it empty to use only the free tools.

```bash
npm run build:mcpb   # -> build/fairquery-company-jobs-feed-mcp-<version>.mcpb (dist + production node_modules)
npm run test:mcpb    # unpack, initialize, tools/list, free call, paid call without token -> APIFY_TOKEN_MISSING
```

`build:mcpb` also writes `<name>-smithery.mcpb`, the file to upload to Smithery. It is the same bundle with only `manifest.json` changed: each tool also carries its `inputSchema`, `outputSchema` and `annotations`, taken from the server's own `tools/list`. Smithery's publish API needs these for its server card, but the MCPB 0.3 manifest schema allows only `name`/`description` per tool, so the canonical `.mcpb` keeps the spec-valid manifest. `test:mcpb` tests both bundles and checks that they differ only in those tool schemas.
