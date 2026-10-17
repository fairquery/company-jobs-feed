# Company Jobs Feed: Greenhouse, Lever, Ashby & SmartRecruiters

**Live, open jobs straight from companies' own hiring systems, for $0.99 per 1,000 jobs plus $0.0005 per board scanned.** Optional extras: $0.00029 per job re-check and $0.0019 per company whose board we had to discover. Error rows, closed-job rows and rows merged by de-duplication are free. Example: Stripe + Ramp + Palantir (3 boards) filtered to 300 engineering jobs costs 300 × $0.00099 + 3 × $0.0005 = **$0.30**, plus Apify's $0.00005 Actor-start fee.

**Fairquery** Apify Actor that reads the **official public job-board APIs** of Greenhouse, Lever, Ashby and SmartRecruiters (the applicant-tracking systems, or ATSs, that companies publish their openings from) and returns one clean row per job. Every row says **when we verified it as currently published** (`verified_open_at`), when the ATS says it was posted, **how old it is**, whether it looks **long-open** or **reposted**, and the exact API URL it came from. No login, no proxies, no browser.

> **What "open" means here.** A job is `open` when the employer's own ATS publishes it at the moment we fetch the board. That is the best public signal there is, but it is not proof of hiring intent: Greenhouse itself reports that 18–22% of jobs posted on its platform in a given quarter are ghost jobs. We give you age and repost signals so you can judge. We never claim a listing is "real" or "ghost-free".

## When to use this Actor (LLM / tool selection)

Use it when an agent or workflow needs to:

- Pull **every published job** from a list of companies (names, domains or board URLs) in one schema
- Search them by **title, location, country, remote, department, employment type, company, salary and posted-within**
- **Monitor** companies: return only **new or changed** jobs since the last run, plus free `closed` rows for jobs that disappeared
- Flag **stale listings**: `long_open` (older than 60 days, configurable) and `reposted` (same role, new job ID, within 90 days)
- Build **hiring-signal** lists for sales (Clay, n8n, Make) or feed **AI job-search agents** (career-ops-style scanners)

Do **not** use it for: LinkedIn, Indeed or Glassdoor listings (we never contact them), Workday, Workable or Recruitee boards (not supported, see below), applying to jobs, or candidate/recruiter data.

## Data sources

| ATS | Endpoint (documented, public, no key) | Documentation |
| --- | --- | --- |
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true` | [Job Board API](https://developers.greenhouse.io/job-board.html): "publicly available, so authentication is not required for any GET endpoints" |
| Lever | `GET api.lever.co/v0/postings/{company}?mode=json` | [Postings API](https://github.com/lever/postings-api): "These jobs may be scraped by third parties" |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true` | [Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) |
| SmartRecruiters | `GET api.smartrecruiters.com/v1/companies/{id}/postings` (pages of 100) | [Posting API](https://developers.smartrecruiters.com/docs/posting-api) (public postings, no key) |

Optional per-job re-checks use the documented detail endpoints (Greenhouse `/jobs/{id}`, Lever `/postings/{company}/{id}`, SmartRecruiters `/postings/{id}`). Ashby has no documented per-job endpoint, so its rows say `detail_not_supported`.

**Not included, and why:** **Workday** has no documented public API. **Recruitee**'s Careers Site API now requires the employer's own token (calls without it will return 401 from 10 February 2027). **Workable** documents its public job endpoints only for an account owner's own careers page, not for third-party use. **LinkedIn** is never contacted.

## How it behaves (politeness and safety)

- Calls **only** the four ATS API hosts above, plus, for discovery only, pages on the **company website you supplied**.
- At most 2 parallel requests per host; Lever's `Crawl-delay: 1` is honoured. Identifying User-Agent `FairqueryJobsFeed/1.0`.
- **Kill switch:** any HTTP 403 or 429 (or an HTML block page where JSON was expected) stops all further requests to that host for the rest of the run. We never retry through other IPs or proxies.
- Careers pages: `robots.txt` is respected (5xx or unreachable robots.txt = we don't crawl), at most 3 pages per company, private/internal IP addresses and non-standard ports are refused, every redirect is re-checked.
- No login, no apply-page loads, no `POST`s, no applicant or recruiter data. Descriptions are optional and e-mail addresses and phone numbers are scrubbed from them by default.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `companies` | `string[]` | — | Names, domains or board URLs (max 200). Board URLs and companies in the starter list resolve for free |
| `boards` | `{ats,slug}[]` / `"ats:slug"` | — | Exact boards (max 500) |
| `useSeedList` | bool | `false` | Scan the verified starter list (59 company boards) |
| `discover` | bool | `true` | Find boards for unknown companies (careers page, then ≤6 API probes; cached 30 days) |
| `titleIncludes` / `titleExcludes` | `string[]` | — | Whole-word, case-insensitive, any-of |
| `titleRegex` | string | — | Optional, ≤200 chars |
| `locations` | `string[]` | — | Substring match on location text; `remote` also matches ATS remote flags |
| `countries` | `string[]` | — | ISO-2 codes (`US`, `DE`); structured where the ATS has it, else place-name list (`country_basis`) |
| `remote` | `any`\|`only`\|`exclude` | `any` | ATS remote flag where present, else location text (`remote_basis`) |
| `companyFilter`, `departments`, `employmentTypes` | `string[]` | — | Substring filters |
| `postedWithinDays` | int | — | ATS publish date at most N days ago (`includeUnknownPostedDate` keeps jobs without one) |
| `maxAgeDays`, `hasSalary`, `excludeStale`, `longOpenDays` | | `60` | Age, pay and stale-signal filters |
| `onlyNew` | bool | `false` | Only new/changed jobs since the last tracked run |
| `trackChanges`, `emitClosed`, `stateStoreName` | | `true`, `true`, `fairquery-jobs-feed-state` | History in a named key-value store in your account |
| `dedupe` | `exact`\|`role`\|`none` | `exact` | `role` merges one role listed per city into one row |
| `includeDescription` | `none`\|`text` | `none` | Plain-text description (≤20,000 chars) |
| `scrubPII` | bool | `true` | Remove e-mails and phone numbers from descriptions |
| `confirmOpen` | `none`\|`detail` | `none` | Re-check each emitted job on its detail endpoint ($0.00029 each, `maxOpenChecks` default 200) |
| `maxJobs` / `maxJobsPerBoard` | int | `5000` / `10000` | Spend and safety caps (max 50,000 / 20,000) |

### Example input

```json
{
  "companies": ["stripe.com", "https://jobs.lever.co/palantir"],
  "boards": [{ "ats": "ashby", "slug": "ramp" }, { "ats": "smartrecruiters", "slug": "BoschGroup" }],
  "titleIncludes": ["engineer"],
  "titleExcludes": ["intern"],
  "countries": ["US", "DE"],
  "postedWithinDays": 30
}
```

## Output

Every row has `schema_version` (`1.0.0`), `type` (`job` | `board` | `company` | `error`) and `checked_at`.

### Job row

```json
{
  "type": "job", "ats": "ashby", "board": "ramp", "company": "Ramp", "company_domain": "ramp.com",
  "job_id": "34413f8d-26bf-4bbc-8ade-eb309a0e2245", "job_key": "ashby:ramp:34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "title": "Security Engineer, Cloud", "department": "Engineering", "team": "Backend",
  "locations": ["New York, NY (HQ)", "Remote (Canada)", "Remote (US)", "Miami, FL"],
  "countries": ["US", "CA"], "country_basis": "ats", "remote": true, "remote_basis": "ats", "workplace_type": "hybrid",
  "employment_type": "Full-time",
  "compensation": { "summary": "$211.4K – $290.6K • Offers Equity", "min": 211400, "max": 290600, "currency": "USD", "interval": "1 YEAR" },
  "posted_at": "2026-04-07T17:12:35.753Z", "ats_updated_at": null,
  "status": "open", "open_check": "listed", "verified_open_at": "2026-10-17T22:46:37.060Z",
  "first_seen_at": "2026-10-17T22:46:37.060Z", "last_seen_at": "2026-10-17T22:46:37.060Z",
  "age_days": 193, "age_basis": "posted_at", "long_open": true, "reposted": false, "stale_signal": "long_open", "repost_of": null,
  "change": "new", "fingerprint": "646e3148231ba20d", "duplicate_group": null, "duplicate_of": null, "merged_job_ids": [],
  "apply_url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application",
  "job_url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "source_url": "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true",
  "description_text": null
}
```

**Freshness fields**

| Field | Meaning |
| --- | --- |
| `verified_open_at` | When this run saw the job published by the employer's ATS (or re-checked it with `confirmOpen`) |
| `posted_at` | The ATS's own publish/created time: Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`, SmartRecruiters `releasedDate`. `null` when absent, never guessed |
| `ats_updated_at` | Last-modified time where the ATS gives one (Greenhouse) |
| `first_seen_at` / `last_seen_at` | From your per-board history (named key-value store). On the first run both are now |
| `age_days`, `age_basis` | now − `posted_at`, or now − `first_seen_at` when there is no ATS date |
| `long_open`, `reposted`, `stale_signal` | Heuristics, labelled as such: older than `longOpenDays`; or a new job ID with the same company + title + location as a job that closed within 90 days (`repost_of`). Reposts are only detectable from the second tracked run |
| `change` | `new`, `updated`, `unchanged` or `closed` (free row: open last run, gone from a complete fetch now) |

**De-duplication.** The primary key is `job_key` = `ats:board:job_id`. `fingerprint` = sha1(company domain or name + normalized title + primary location) links the same role across boards or after an ATS migration: later rows get `duplicate_of`, and every multi-row group is listed in the `DUPLICATE_GROUPS` record. Nothing is silently dropped, except that `dedupe: "role"` merges one board's per-city copies into one row (`merged_job_ids`), and merged rows are free.

### Board, company and error rows

- **Board row** (one per board scanned, `board-scanned`): `jobs_total`, `jobs_matched`, `jobs_emitted`, `complete`, `new`, `updated`, `closed`, `reposted`, `requests`, `discovered_via`.
- **Company row** (when discovery ran): `boards[]` with `via` (`careers_page` = high confidence, `slug_probe` = medium), `careers_pages_fetched`, `probes`, `cached`. Charged `company-discovered` only when discovery actually ran **and** found a board; cached lookups and failures are free.
- **Error rows** (free): `INPUT_EMPTY`, `INVALID_INPUT`, `INVALID_BOARD`, `INPUT_CAPPED`, `COMPANY_NOT_RESOLVED`, `NO_BOARD_FOUND`, `BOARD_NOT_FOUND`, `BOARD_TRUNCATED`, `BOARD_SKIPPED`, `HOST_BLOCKED`, `NETWORK_ERROR`, `ATS_HTTP_ERROR`, `ROBOTS_DISALLOWED`, `ROBOTS_UNAVAILABLE`, `URL_NOT_ALLOWED`, `DNS_FAILED`, `STATE_SAVE_FAILED`.

### Run summary

Key-value store record **`RUN_SUMMARY`**: counts, events, requests per host, stopped hosts, echoed input.

## Pricing

| Event | Price | When |
| --- | --- | --- |
| `job-result` | $0.00099 | Each open job row delivered (after filters and de-duplication) |
| `board-scanned` | $0.0005 | Each board fetched successfully (even if no job matched your filters) |
| `open-confirmed` | $0.00029 | Each detail re-check, only with `confirmOpen: "detail"` |
| `company-discovered` | $0.0019 | Each company whose board we found by discovery (not for board URLs, starter-list companies or cached results) |
| `apify-actor-start` | $0.00005 | Once per run, per GB of memory (Apify default event) |

Error rows, `closed` rows and merged rows are **never** charged.

**Worked examples:** monitor 500 companies daily with `onlyNew`: 500 × $0.0005 = **$0.25 per check** plus $0.99 per 1,000 new jobs. Search the whole starter list (59 boards, ~21,500 listed jobs on 2026-10-17) for remote engineering roles posted in the last 14 days: 59 × $0.0005 + matching jobs × $0.00099.

To cap spend, set a maximum cost per run in the run options; the Actor stops cleanly before the limit and never delivers unpaid rows. `maxJobs` caps job rows per run.

## Memory / runtime

Default **256 MB** (max 512 MB), timeout 900 s. HTTP only (no browser, no proxy). A Greenhouse, Lever or Ashby board is one request (0.1–2 s); a SmartRecruiters board is one request per 100 postings (Bosch, ~5,000 postings: 51 requests, ~25 s).

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) with Actor `fairquery/company-jobs-feed`, or use the local stdio MCP server in the GitHub repo (free `jobs_get_board`, `jobs_find_board`, `jobs_check_open`, `jobs_list_seed_boards`, and paid `jobs_search_companies`).

```json
{
  "actor": "fairquery/company-jobs-feed",
  "input": { "companies": ["ramp.com"], "titleIncludes": ["engineer"], "remote": "only" }
}
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Run fails at once with `INPUT_EMPTY` | No `companies`, `boards` or `useSeedList`. Console sample values are prefill only and are not sent with API calls |
| `NO_BOARD_FOUND` | The company doesn't use a supported ATS publicly, or its slug differs. Pass the board URL from its careers page (e.g. `https://jobs.lever.co/acme`) |
| `ROBOTS_DISALLOWED` / `ROBOTS_UNAVAILABLE` | The company's robots.txt doesn't allow us to read that careers page; we then only try API probes. Pass the board URL instead |
| `HOST_BLOCKED` | An ATS answered 403/429 and the kill switch stopped that host for this run. Rows are free; re-run later with fewer boards |
| `BOARD_TRUNCATED` | The board has more postings than `maxJobsPerBoard`; closed-job detection is skipped for that board |
| Everything is `change: "new"` | First tracked run (baseline). From the second run on you get `unchanged`/`updated`/`closed` |
| Wrong company matched | A `slug_probe` match (confidence `medium`) can be a different company with the same name; pass the exact board |

## FAQ

**Are these jobs real / not ghost jobs?**

We can show that a job is **currently published on the employer's own hiring system**, how old it is and whether it was reposted. We cannot prove the employer intends to hire. Use `excludeStale`, `maxAgeDays` and `postedWithinDays` to focus on fresh listings.

**Is this a LinkedIn scraper?**

No. We never contact LinkedIn. Many roles you see on job boards originate in these ATS feeds, so this is a rules-respecting way to get them first-hand.

**Why not Workday, Workable or Recruitee?**

We only use endpoints the ATS documents for public, third-party use. See "Not included, and why" above.

**Is there a global search over all companies?**

No global index: search covers the boards in your run. Set `useSeedList: true` to search the 59 verified starter boards, or bring your own list.

**How much does it cost?**

$0.99 per 1,000 jobs + $0.0005 per board, plus optional $0.00029 per re-check and $0.0019 per discovered company. Errors are free.

**Can an AI agent call it?**

Yes, through [Apify MCP](https://mcp.apify.com) with Actor `fairquery/company-jobs-feed`, or the stdio MCP server in the GitHub repo (the single-board tool runs free on your machine).

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $0.007 per run
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; from $1.50 per 1,000 companies
- **MCP server** [`@fairquery/agent-trust-mcp`](https://www.npmjs.com/package/@fairquery/agent-trust-mcp): one MCP server for Claude Desktop, Cursor and VS Code (`npx -y @fairquery/agent-trust-mcp`).

All Fairquery Actors: https://apify.com/fairquery

## Disclaimer

Job data comes from each employer's public ATS job board and belongs to the employer. Fields are passed through as published (with light normalization); age, remote, country and stale signals are heuristics where labelled. No warranty that a listed job is still being hired for. Fairquery is not affiliated with Greenhouse, Lever, Ashby, SmartRecruiters or LinkedIn.

## Links

- Apify Store: https://apify.com/fairquery/company-jobs-feed
- GitHub: https://github.com/fairquery/company-jobs-feed
- Contact: fairquery@proton.me
- License: MIT
