# Development

This file covers local development of the **Company Jobs Feed** Apify Actor. The Apify Store README is [`.actor/README.md`](./.actor/README.md) (`readme` in `.actor/actor.json`). The GitHub [README.md](./README.md) adds the MCP server notes.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | Actor entry: input checks, board resolution, scan, history, filters, dedupe, charging |
| `src/ats.ts` | Greenhouse, Lever, Ashby, Personio, Pinpoint and Gem: URLs, mappers, Greenhouse large-board fallback |
| `src/personio.ts` | Documented Personio `/xml` parser, robots gate, salary normalization |
| `src/pinpoint.ts` | Documented Pinpoint `/postings.json` parser, per-tenant robots gate |
| `src/gem.ts` | Documented Gem `/job_posts/` parser. Link out; ad body is not stored |
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
npm run verify-seed  # live check of the starter list (135 GETs)
```

Optional local pay-per-event dry run: `ACTOR_TEST_PAY_PER_EVENT=1 npx apify run`.

## MCP server

```bash
npm run mcp:build                                   # = npm --prefix mcp ci --ignore-scripts && npm --prefix mcp run build
cd mcp && npm run sync                              # after editing ../src: refresh mcp/src/shared
npm test                                            # stale-copy check + smoke test + jobs_get_job (no token, no network)
node scripts/smoke-test.mjs --live                  # also calls the free tools against the real ATS APIs
```

## Notes

- Sample values in the input schema are `prefill` only, never `default`. An API call without input fails fast with `INPUT_EMPTY` and is not billed. Keep it that way.
- Never add a host to `ATS_API_HOSTS` without confirming its API is documented for outside use. SmartRecruiters (its API robots.txt allows only LinkedIn's crawler), Recruitee, Workable, Workday, Rippling and LinkedIn are deliberately not supported and blocked by `EXCLUDED_HOST_SUFFIXES` (see README). Personio, Pinpoint and Gem are not in that map and are never probed or added to the starter list. Personio fetches only `https://{account}.jobs.personio.de/xml` after robots.txt. Pinpoint fetches only `https://{subdomain}.pinpointhq.com/postings.json` after that tenant's robots.txt, keeps metadata and a listing link, and does not store the ad body. Pinpoint is CLEAR-with-conditions after the 2026-10-26 ~8:00 PM ET AUP PDF skim. The AUP preamble and §7 reach to non-customers is a lawyer note, not a hold. Gem fetches only `https://api.gem.com/job_board/v0/{vanity}/job_posts/` (no API key, no robots preflight: Policy recorded HTTP 403 on `api.gem.com/robots.txt`, and 403 is the kill switch). Gem is Fairquery's accepted-risk override of Policy's BLOCK lean (`policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md`, 2026-10-26 ~7:50 PM EDT via TM t757), documented separately from Pinpoint. Do not edit getfairquery-site here; the privacy source list needs an update when these feeds ship.
- Rows are charged only after they are pushed; error, closed and merged rows are free. The emitter never pushes a charged row the run's max-cost budget can't cover.
- History for a board is saved only when its output was delivered in full, so `onlyNew` never loses jobs after a stop.
- The Actor is deployed to Apify as source files (`apify push`), not from this Git repo.
- Contributions and issues: https://github.com/fairquery/company-jobs-feed/issues
