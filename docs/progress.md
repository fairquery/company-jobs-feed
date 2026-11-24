# CLEAR manifest progress

Climb committed quality **8914/8854**. Floor **MET**. Aggregators stripped. Ingest **HOLD**.

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 5,155 | 5,243 |
| ashby | 3,207 | 3,355 |
| lever | 552 | 256 |

`manifests/clear-boards-quality.jsonl` on this branch. Main `64949524404b352d1ca412701538c2223d6f5ebc` stays **8718/8854** until this climb lands. No ZipRecruiter, Indeed, Glassdoor, job-wrapping, or external-feed rows. GA is not done. No Apify push. No MCP deploy.

# CLEAR manifest progress

Committed quality **8718/8854**. Floor **MET**. Aggregators stripped. Ingest **HOLD**.

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 5,012 | 5,243 |
| ashby | 3,207 | 3,355 |
| lever | 499 | 256 |

`manifests/clear-boards-quality.jsonl` is the committed set. Greenhouse `ziprecruiter`, `artefactlinkedin` (LinkedIn Job Wrapping), and `teneolinkedin` (external LinkedIn feed) are not in it. GA is not done. Builder merges. No Apify push. No MCP deploy. Claude smoke is on hold.

## 2026-11-01T02:40Z — floor met, 8718/8854

`verified_count / 8854` = **8718 / 8854**. Greenhouse 5,012, Ashby 3,207, Lever 499. Every row is a public Greenhouse, Ashby, or Lever GET with HTTP 200 and at least one job. Lever above 256 is live company boards from `jobs.lever.co` and `jobs.eu.lever.co`.

## 2026-11-01T02:32Z — 8390 unique rows on disk, floor not met

`verified_count / 8854` = **8390 / 8854** unique manifest lines (one is Greenhouse `ziprecruiter` and will be stripped before any merge). Quality count **8389/8854**. Still **311** short of 8,700.

| ATS | In the file | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,843 | 5,243 |
| ashby | 3,206 | 3,355 |
| lever | 341 | 256 |

The in-process counter lags this file because two passes appended. Lever above 256 is live-verified company boards, not an aggregator scrape. Greenhouse on the current URL set is still the slow part. About 2,172 older-crawl Greenhouse slugs and 167 Ashby slugs are not in this file yet. They will be verified after the Lever pass finishes rewriting, so the two passes do not clobber each other. 404 and empty stay out. Wikipedia stays on 429 backoff. Ingest is on hold.

## 2026-11-01T02:30Z — 8297/8854, quality lock

`verified_count / 8854` = **8297 / 8854**. Floor **8,700** is not met.

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,795 | 5,243 |
| ashby | 3,195 | 3,355 |
| lever | 307 | 256 |

Lever passed its ceiling with live company boards (`jobs.lever.co` / `jobs.eu.lever.co` URLs, HTTP 200, ≥1 job). Greenhouse is flat at 4,795 while this pass's remaining checks are mostly HTTP 404. Those 404s are not kept. Pass rate on the current queue is about 11%, so this queue alone is projected under 8,700.

**Quality:** ZipRecruiter's own Greenhouse board is in the wave-1 file and will be removed. Glassdoor and Snagajob slugs are candidates only and are rejected as aggregator boards. Employer boards that only mention Indeed or LinkedIn in the Greenhouse name stay. No Indeed or ZipRecruiter scrape was used as a source. Wikipedia is still on 429 hard backoff and was not retried.

**Careers harvest** of the ISC remoteintech list plus two MIT READMEs fetched 1,827 pages and added **12** new board links. Low yield. The pages are mostly client-rendered.

**Next §5 source:** older Common Crawl indexes are still being read (`CC-MAIN-2024-30` through `CC-MAIN-2025-38`). New observed slugs from those crawls are not in this count yet. Dead URLs from them will be rejected, not counted.

Intermediate pull request (wave 1 file still 7137/8854): https://cursor.com/codebase/fairquery/company-jobs-feed/pull/24

## 2026-11-01T02:22Z — 8209/8854, careers harvest started, Wikipedia left alone

`verified_count / 8854` = **8209 / 8854**

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,795 | 5,243 |
| ashby | 3,195 | 3,355 |
| lever | 219 | 256 |

Greenhouse moved off the 4,696 plateau on newly observed Common Crawl slugs, then flattened again while most remaining Greenhouse checks are HTTP 404 (`not_found` is the bulk of this pass). Lever is still rising (107 → 219) from `jobs.lever.co` / `jobs.eu.lever.co` URLs in the 2025 crawls. No 429 on the ATS hosts.

Wikipedia category fetch returned HTTP 429. That source is on hard backoff and is not being retried.

**Next §5 source now running:** careers-page harvest of licensed public lists, not slug guesses. Targets are `careers_url` values from remoteintech/remote-jobs (ISC, commit `fa2253f1ed02`) plus link targets from poteto/hiring-without-whiteboards and j-delaney/easy-application (both MIT). The crawl reads robots.txt, stops a host on 429, and keeps a slug only when the page actually links to Greenhouse, Lever, or Ashby. About 2,000 URLs. Intermediate PR #24 stays open and is not marked done.

## 2026-11-01T02:10Z — wave 2 pass finished at 7974, next pass queued

`verified_count / 8854` = **7974 / 8854**

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,696 | 5,243 |
| ashby | 3,171 | 3,355 |
| lever | 107 | 256 |

Common Crawl union added 4,880 observed slugs (greenhouse 2,190, ashby 1,051, lever 1,639), mostly at the end of the harvest, so this pass only verified the slugs already on disk when it started. About 4,800 observed slugs were still unverified, including the Lever haul from `CC-MAIN-2025-43` (`jobs.lever.co` page 0 added 1,558; page 1 then added 791 more). That pass is running. Older crawls (`CC-MAIN-2024-30` through `CC-MAIN-2025-38`) are being read at the same time. Floor 8,700 is not met.

## 2026-11-01T02:05Z — wave 2 verifying Common Crawl union

`verified_count / 8854` = **7565 / 8854** and still climbing.

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,291 | 5,243 |
| ashby | 3,171 | 3,355 |
| lever | 103 | 256 |

Wave 2 has already added boards past the wave 1 snapshot (7,137). `sources/clear/wave-next.jsonl` was past 3,100 observed slugs and the crawl harvest had not finished. No 429 host stop. Anduril spot check was repeated at the start of this pass (HTTP 200, 2,562 jobs, 1,517 `engineer` titles).

**Blockers:** still under 8,700. Lever 103 versus 256. Greenhouse gain from this union is smaller than Ashby and Lever so far. `jobs.lever.co` pages keep returning 0 new slugs; `jobs.eu.lever.co` is where new Lever slugs showed up.

**Next §5 source after this pass:** older Common Crawl indexes (`CC-MAIN-2024-30` through `CC-MAIN-2025-38`) for the same public board hosts, observed URLs only.

## 2026-11-01T01:56:10Z — wave 1 finished, floor not met

`verified_count / 8854` = **7137 / 8854**

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,208 | 5,243 |
| ashby | 2,885 | 3,355 |
| lever | 44 | 256 |

Checked 9,105 candidate and name-probe requests at 6.6/s by the end. Rejects: no_jobs 673, not_found 1,297, company_missing 25, company_mismatch 29. No 429 host stop. Anduril spot check: HTTP 200, 2,562 jobs, 1,517 titles contain `engineer` (lite list, no `/embed/`, no `content=true`).

**Blockers:** Lever is 44 versus 256. `jobs.lever.co` CDX pages are often HTTP 504 or only `robots.txt`; `jobs.eu.lever.co` is producing some new slugs in wave 2. Greenhouse live boards from the first URL set stopped at 4,208 (later slugs were empty or gone). Ashby direct set stopped at 2,885 versus 3,355. Careers-page HTML harvest found no links. Greenhouse customer URLs 404. CC BY-NC slug lists were not used.

**Next §5 source:** Common Crawl CDX union already in progress (`CC-MAIN-2025-43` through `CC-MAIN-2026-39`). `sources/clear/wave-next.jsonl` passed 2,500 observed slugs that were not in wave 1, and the harvest had not finished. Those are verified in a follow-up pass. Still short of 8,700 until that pass (and any pass after it) lands real boards.

## 2026-11-01T01:52Z — wave 1 direct queue plateau

`verified_count / 8854` = **7125 / 8854**

| ATS | Verified | Ceiling |
| --- | ---: | ---: |
| greenhouse | 4,208 | 5,243 |
| ashby | 2,884 | 3,355 |
| lever | 33 | 256 |

Greenhouse stopped rising at 4,208 while later direct slugs 404 or have no jobs (no_jobs 666, not_found 918). Ashby direct queue finished at 2,884. Lever is 33. No 429 host stop. Anduril spot check this run: HTTP 200, 2,562 lite-list jobs, 1,517 titles contain `engineer`. Name probes are still running. Floor 8,700 is not met.

**Next §5 source, in progress:** Common Crawl CDX union (`CC-MAIN-2025-43` through `CC-MAIN-2026-39`) on the public Greenhouse, Ashby, and Lever board hosts. First pages already added hundreds of observed slugs that were not in the wave 1 queue (`sources/clear/wave-next.jsonl`, 975 lines and growing), including `jobs.eu.lever.co`. Those get the same public-GET verify after wave 1 exits. MIT `open-jobs-data` `companies.json` contributed 26 CLEAR slugs not already queued; blocked ATS rows were not copied.

Rejected so far: no_jobs 523, not_found 550, company_missing 20, company_mismatch 20.

**Blockers:** Lever candidates are a few dozen (Common Crawl `jobs.lever.co` is mostly `robots.txt` or HTTP 504; the CC BY-NC Lever list was not used). Ashby direct slugs are already short of 3,355 before dead boards. Greenhouse customer-page URLs 404. Wave-2 careers HTML had no board links.

**Next §5 source:** Common Crawl CDX union, crawls `CC-MAIN-2025-43` through `CC-MAIN-2026-39`, hosts `boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.ashbyhq.com`, `jobs.lever.co`, `jobs.eu.lever.co`. Observed URL slugs only, then the same public-GET verify. Also 26 Greenhouse/Lever/Ashby rows from MIT `ConorsCode/open-jobs-data` `companies.json` that were not already queued (blocked ATS rows dropped, job bodies not copied).

No pull request yet. An intermediate PR may land the pipeline and this manifest. It will not say the 8,700 floor is done.
