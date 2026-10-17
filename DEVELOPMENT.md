# Development

This file covers local development of the **Company Jobs Feed** Apify Actor. The Apify Store README is [`.actor/README.md`](./.actor/README.md) (`readme` in `.actor/actor.json`). The GitHub [README.md](./README.md) adds the MCP server notes.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | Actor entry: input checks, board resolution, scan, history, filters, dedupe, charging |
| `src/ats.ts` | The four official ATS APIs: URLs, mappers, SmartRecruiters paging, Greenhouse large-board fallback |
| `src/http.ts` | `AtsClient` (fixed hosts, kill switch, per-host gate) and `CareersFetcher` (SSRF guard, DNS pinning, robots.txt) |
| `src/discovery.ts` | Board URL parsing, careers-page link extraction, slug probes (max 6) |
| `src/state.ts` | History per board: first/last seen, updated/closed, repost detection |
| `src/seed.ts` | Verified starter boards; re-check with `npm run verify-seed` |
| `.actor/Dockerfile` | Actor image (Apify) |
| `Dockerfile` | MCP server image (Glama and other MCP hosts) |
| `mcp/` | stdio MCP server; `mcp/src/shared` is a generated copy of the Actor's network-only modules |

## Run locally

```bash
npm install
# input in storage/key_value_stores/default/INPUT.json, for example:
# {"boards": ["ashby:ramp"], "titleIncludes": ["engineer"]}
npx apify run
npm test             # unit tests (vitest), no network
npm run verify-seed  # live check of the starter list (about 60 GETs)
```

Optional local pay-per-event dry run: `ACTOR_TEST_PAY_PER_EVENT=1 npx apify run`.

## MCP server

```bash
npm run mcp:build                                   # = npm --prefix mcp ci --ignore-scripts && npm --prefix mcp run build
cd mcp && npm run sync                              # after editing ../src: refresh mcp/src/shared
npm test                                            # stale-copy check + smoke test (no token, no network)
node scripts/smoke-test.mjs --live                  # also calls the free tools against the real ATS APIs
```

## Notes

- Sample values in the input schema are `prefill` only, never `default`. An API call without input fails fast with `INPUT_EMPTY` and is not billed. Keep it that way.
- Never add a host to `ATS_API_HOSTS` without confirming its API is documented for outside use. Recruitee, Workable, Workday and LinkedIn are deliberately not supported (see README).
- Rows are charged only after they are pushed; error, closed and merged rows are free. The emitter never pushes a charged row the run's max-cost budget can't cover.
- History for a board is saved only when its output was delivered in full, so `onlyNew` never loses jobs after a stop.
- The Actor is deployed to Apify as source files (`apify push`), not from this Git repo.
- Contributions and issues: https://github.com/fairquery/company-jobs-feed/issues
