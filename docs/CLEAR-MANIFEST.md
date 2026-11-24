# CLEAR board manifest

Paid index ingest list for Greenhouse, Lever, and Ashby. The free live scan is unchanged: `SEED_BOARDS` in `src/seed.ts` stays the 135-board starter list, and `jobs_search_by_location` does not read this manifest.

Parity ceiling: **8,854** boards. That is Greenhouse 5,243 + Ashby 3,355 + Lever 256, the CLEAR-family counts in orbifetch's own 2026-09-27 coverage table, as recorded in the 2026-10-27 jobs postmortem. This pipeline does not fetch, scrape, or buy orbifetch or TheirStack. The number is a target, not an input.

Verified count for the run that produced `manifests/clear-boards.jsonl` is in [Progress](#progress). The checker prints `verified/8854` as it goes and writes the same ratio to `manifests/clear-progress.json`.

## Progress

Floor is **MET** on the committed quality file. See `docs/progress.md`. Ingest is on hold. GA is not done.

Committed quality snapshot `manifests/clear-boards-quality.jsonl`: **8718 / 8854**.

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 5,012 | 5,243 |
| ashby | 3,207 | 3,355 |
| lever | 499 | 256 |

Three rows were stripped and are not in that count: Greenhouse `ziprecruiter` (ZipRecruiter), `artefactlinkedin` (LinkedIn Job Wrapping), and `teneolinkedin` (Teneo external feed for LinkedIn). Live passes were still appending when the snapshot was taken, so the count can rise. Ingest is on hold. Pull request #24 is not a merge request.

Wave 1 finished 2026-11-01T01:56:10Z. `verified_count / 8854` = **7137 / 8854**.

| | Greenhouse | Ashby | Lever | Total |
| --- | ---: | ---: | ---: | ---: |
| Parity ceiling | 5,243 | 3,355 | 256 | **8,854** |
| Wave 1 direct candidates | 5,309 | 3,261 | 40 | 8,610 |
| Verified after wave 1 | 4,208 | 2,885 | 44 | **7,137** |

Wave 1 rejects: no_jobs 673, not_found 1,297, company_missing 25, company_mismatch 29. No 429 host stop. The next wave is a Common Crawl union of earlier crawls (`sources/clear/wave-next.jsonl`), observed host URLs only, verified with the same GET rules. That queue is still growing and is not in the 7,137.

Direct candidates are slugs that already appeared in a saved source. Name probes (sector list, Lehigh Valley Wikipedia titles, Ashby customer logos, Lever case-study headings) run after that queue. A guessed slug is not written to the manifest unless the live API returns a board whose company name matches.

## What a verified row is

`manifests/clear-boards.jsonl` has one JSON object per line. Ingest can read `ats`, `slug`, and optional `company`. The other fields are the verification record.

```json
{"ats":"greenhouse","slug":"andurilindustries","company":"Anduril Industries","jobs":2562,"http_status":200,"verified_at":"2026-11-01","verified_by":"api_live_probe","company_match":"api_company_name","source_url":"https://boards-api.greenhouse.io/v1/boards/andurilindustries/jobs","sources":["fairquery_seed"]}
```

Quality is company-direct boards only. ZipRecruiter, Indeed, Glassdoor, SimplyHired, Snagajob, CareerBuilder, and Monster are not boards in this manifest, and neither are Greenhouse tokens whose company name is a job-wrapping or external feed. An employer board that merely mentions a channel in its Greenhouse name (Stone's own board named "Stone - Indeed") stays. Dead, 404, and empty boards are not written. Aggregator sites are not a source.

A row is written only when all of these hold:

- `ats` is `greenhouse`, `lever`, or `ashby`. Personio, Pinpoint, Gem, Workday, LinkedIn, SmartRecruiters, Rippling, Recruitee, and the other blocked families are not requested.
- The slug matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` and does not contain `..`.
- The GET is the documented list endpoint, with `User-Agent: FairqueryJobsFeed/1.0 (+https://getfairquery.com; info@getfairquery.com)`:
  - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` (no `content=true`). `robots.txt` disallows `/embed/`. This crawl never requests `/embed/`.
  - Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`, then `https://api.eu.lever.co/...` only after a US 404. At least 1 second between Lever starts (`Crawl-delay: 1` on `api.lever.co`). The same lane covers `jobs.lever.co` and `jobs.eu.lever.co`.
  - Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`. Jobs with `isListed: false` are dropped. Description fields are parsed only to be discarded. Nothing in the manifest is a description body.
- HTTP status is 200 and at least one published job remains after the Ashby filter.
- Company match:
  - Greenhouse: `company_name` on the list payload. When the candidate named a company, the long-word sets must be equal (`Apex Space` does not match `Apex Eye`; `Hinge Health` does not match `Hinge`).
  - Lever and Ashby: the public list JSON has no company field. The crawl reads `<title>` from `jobs.lever.co/{slug}` or `jobs.ashbyhq.com/{slug}` (first 12 KB, HTML not stored) and applies the same match. `jobs.ashbyhq.com/api/` is not fetched (`robots.txt` disallows `/api/`).
- Redirects are not followed. HTTP 403 stops that host. HTTP 429 waits 60s, then 120s, then 240s (or `Retry-After` if longer), capped at 15 minutes. The third 429 stops that host for the rest of the run. There is no second IP and no proxy.

## Egress

Run `npm run clear-manifest` on a normal machine or a CI runner with ordinary egress. The process exits before any fetch if `CF_WORKER`, `CLOUDFLARE_WORKER`, or `CF_PAGES` is set, or if the runtime exposes Cloudflare Worker `caches.default` and `WebSocketPair`.

Do not point this crawl at a Cloudflare Worker. Worker egress is a shared address pool with a subrequest cap, and the free location scan already spends that budget. A corpus crawl from a Worker would sit on the same egress as live scans and would hammer Greenhouse, Lever, and Ashby from Cloudflare addresses. The free scan stays on its own Worker path and does not call this script.

## Where candidates come from

Discovery follows the six sources in the 2026-10-27 postmortem, section 5. Snapshots, hashes, and the rejected lists are in `sources/clear/`.

1. **Careers-page link harvest.** For each wave-2 company that has a domain (not an excluded host), the crawl GETs `/robots.txt`, then `/` and `/careers` when the robots group allows them, and keeps Greenhouse / Lever / Ashby slugs from links in the HTML. The 2026-11-01 pass fetched 58 pages and found no board links. Those career sites are client-rendered, so the slug was not in the HTML. `rippling.com` is not fetched.
2. **Sector names and alternate slugs.** The wave-1 "no 200" names (Hadrian, Varda, Boom, Joby, Axiom, Stoke, True Anomaly, Castelion, Hinge Health, Tempus, and the rest of that list) plus Wikipedia category titles for companies based in the Lehigh Valley, Lehigh County, Northampton County, Allentown, and Bethlehem. Slugs come from `slugCandidates` and `probePlan` in `src/discovery.ts` (at most six probes, Greenhouse / Lever / Ashby only). A probe that 404s or matches a different company is dropped.
3. **Rival and marketing pages.** Not used as data. orbifetch and TheirStack were not requested. The only orbifetch sample named in the postmortem is the placeholder "Acme", which was not probed.
4. **Public OSS and crawl URL lists.**
   - `groundtruthtools/ats-jobs-mcp` `directory.json` at commit `1b840c47cfad`, SHA-256 `ef84af06db88355a6fae395e406b670652da00e447c6624b28de5eacee46402b`, MIT, copyright 2026 Ground Truth. The upstream note says each row was checked against the vendor API on 2026-08-24 and that Common Crawl was used only to find candidate slugs. This repo stores that file, checks the hash before use, and re-verifies every token itself. `companyfacts.dev` is not called. The file has Greenhouse and Ashby tokens only (no Lever).
   - Common Crawl CDX `CC-MAIN-2026-43` URL paths on `job-boards.greenhouse.io`, `boards.greenhouse.io`, and `jobs.ashbyhq.com`. Only the first path segment is kept. `jobs.lever.co/*` on that crawl returned HTTP 504. `CC-MAIN-2026-39` page 0 returned a small Lever URL set (plus many `robots.txt` hits). Older Lever crawls were almost entirely `robots.txt`.
   - Not used: the Riley Dorrington company datasets (CC BY-NC 4.0), including the copy vendored under `saeedkolivand/ai-job-hunter-app` (`greenhouse.txt.gz` 8,324, `lever.txt.gz` 4,365, `ashby.txt.gz` 3,161). Commercial use needs permission. SimplifyJobs READMEs have no license file and were not copied.
5. **Official ATS customer pages, names only.** Ashby `https://www.ashbyhq.com/customers` logo `alt` text where `src` is under `/customers/profiles/` (47 names). Testimonial photos were not stored. Lever `https://www.lever.co/customers` (redirects to case studies): company names taken from headings. Greenhouse `https://www.greenhouse.com/customers` and the case-study URLs tried on 2026-11-01 returned HTTP 404, so no Greenhouse customer name list was saved. Doc examples that are placeholders (`your-board-token`, "Acme") are not probed.
6. **This repo's own discovery path.** The 135 `SEED_BOARDS` rows are re-verified into the manifest. They are not edited. There is no production query log in this repo, so no user identifiers are in the candidate files.

## Anduril spot check

Before the queue, the same client requests the lite Greenhouse list (no `/embed/`, no `content=true`) and counts title hits. On 2026-11-01:

| Board | HTTP | Jobs | Title scan |
| --- | ---: | ---: | --- |
| `greenhouse/andurilindustries` | 200 | 2,562 | 1,517 titles contain the whole word `engineer` |
| `greenhouse/spacex` | 200 | 2,874 | 1,415 titles contain `engineer` |
| `lever/veeva` | 200 | 892 | 231 titles contain `manager` |

Sample Anduril titles from that lite list included "2026 Early Career Electrical Engineer" and "2026 Early Career Software Engineer". The check shows the large-board list is readable without the description body. It does not change the free location scan.

## Rate, ETA, blockers

Politeness caps the run near 5 requests/second per API host (200 ms between starts, a few in flight) and 1/second for every Lever host. A full pass of the ~8,610 direct candidates is on the order of 15–25 minutes at the rate in `manifests/clear-progress.json`, plus a few minutes of name probes. That is the ETA for this queue, not a promise that the verified count reaches 8,854.

Blockers between this queue and 8,854:

- **Lever.** The MIT directory has no Lever rows. Common Crawl's recent `jobs.lever.co` captures are `robots.txt` plus a few dozen real slugs. The CC BY-NC list that does contain thousands of Lever slugs was not used. About 216 of the 256 Lever ceiling has no Policy-safe slug source yet.
- **Empty and dead boards.** A 200 with zero jobs, or a 404, is not verified. August 2026 directory rows go stale. Replacements have to be new real slugs, not invented ones.
- **Ashby candidate gap.** Direct Ashby slugs in this snapshot are still short of 3,355 before dead boards are removed.
- **Careers pages.** The wave-2 domains did not expose board links in the first HTML response.
- **Greenhouse customer index.** The public customer URLs 404'd, so source 5 did not add Greenhouse names.
- **Common Crawl flakes.** `jobs.lever.co` on `CC-MAIN-2026-43` returned 504. `job-boards.greenhouse.io` page 1 returned 502 on the first try and succeeded on a retry.

`eta_to_8854_at_this_rate_min` in the progress file divides the gap to 8,854 by the check rate. That number assumes later checks keep succeeding and that more slugs exist. Use `eta_remaining_queue_min` for this snapshot. The lever and dead-board gaps above are why the verified total stops short of 8,854 even after the queue finishes.

## Run

```bash
npm run clear-manifest -- collect
npm run clear-manifest -- verify
npm run clear-manifest -- verify --limit 60
```

`verify` refuses to start on Cloudflare Worker egress. It resumes from lines already in the manifest. `src/seed.ts` is not an output of either command.
