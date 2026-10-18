# fairquery-jobs-feed MCP server

stdio MCP server for [Company Jobs Feed](https://github.com/fairquery/company-jobs-feed). Free local tools `jobs_get_board`, `jobs_find_board`, `jobs_check_open`, `jobs_list_seed_boards`; paid `jobs_search_companies` (Apify Actor `fairquery/company-jobs-feed`, needs `APIFY_TOKEN`).

```bash
npx -y @fairquery/company-jobs-feed-mcp   # from npm
# from source:
npm ci --ignore-scripts && npm run build && node dist/index.js
npm test   # shared-source check + smoke test (no token, no network)
```

`src/shared/` is generated from `../src` by `npm run sync`; do not edit it here. See the [repository README](../README.md) for tool details and [SECURITY.md](../SECURITY.md).
