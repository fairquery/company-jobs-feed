# Greenhouse, Lever, Ashby, Personio, Pinpoint & Gem Jobs API: Company Jobs Feed

## What does it do?

This **jobs API** reads the **official public job-board APIs of Greenhouse, Lever and Ashby**, plus the **documented Personio XML feed**, the **documented Pinpoint postings.json feed**, and a **named Gem job board** when you supply the account, subdomain or vanity. It returns one clean row per job. Give it company names, domains or board URLs and it finds a Greenhouse, Lever or Ashby board for you. Personio, Pinpoint and Gem are not discovered: you pass the name.

Every row says **when we verified it as currently published**, when the ATS says it was posted, **how old it is**, whether it looks **long-open** or **reposted**, and the exact API URL it came from. Filter by title, location, country, remote, department, salary and posting date, or run it on a schedule to get **only new or changed jobs**. No login, no proxies, no browser. LinkedIn, Workday, SmartRecruiters, Recruitee, Rippling and Workable are not supported. Rows are the result of your run. This Actor does not publish a public jobs directory.

**Coming soon:** indexed Jobs search, faster and more comprehensive than the free 135-board live scan. Indexed search covers 8,700+ boards. Get 8,700+ boards free with Apify's $5 starter credit: create an Apify account and an API token at https://console.apify.com/settings/integrations. The free starter list stays at 135 boards. The MCP tool `jobs_search_companies` is temporarily offline and does not start this Actor.

## How much does it cost?

Pay per event, no subscription. Prices per 1,000 events:

| Event | Free plan | Starter (Bronze) | Scale (Silver) | Business (Gold) |
|---|---|---|---|---|
| `job-result` (primary) | $0.99 | $0.95 | $0.85 | $0.75 |
| `board-scanned` | $0.50 | $0.50 | $0.50 | $0.50 |
| `open-confirmed` (optional) | $0.29 | $0.29 | $0.29 | $0.29 |
| `company-discovered` (only when discovery runs) | $1.90 | $1.90 | $1.90 | $1.90 |

The [Apify Free plan](https://apify.com/pricing) includes **$5 of usage every month**, no credit card needed, and this Actor's event charges come out of that $5. That covers about **5,000 job rows from 25 boards a month** (5,000 × ($0.99/1,000) + 25 × ($0.50/1,000) = $4.96) when you give the boards directly. A company name or domain that needs careers-page discovery adds $1.90 per 1,000 companies found. Closed-job rows, merged duplicates and error rows are never charged.

**Example (Free-plan prices):** Three boards given as board URLs or `{ats, slug}`, filtered to 300 engineering jobs: 300 × ($0.99/1,000) + 3 × ($0.50/1,000) = about **$0.30** ($298.50 per 1,000 runs). Entered as company names that all need discovery, the same run is still about $0.30, or $298.50 + 3 × $1.90 = **$304.20 per 1,000 runs**.

Paid Apify plans get the Store discount automatically: Starter = Bronze, Scale = Silver, Business = Gold. Set a maximum cost per run in the run options and the Actor stops cleanly at that limit.

## How to use it

1. Enter **Companies** (names, domains or board URLs such as `https://jobs.lever.co/palantir`) or exact **Boards** (`{"ats": "ashby", "slug": "ramp"}`). For a named feed, pass it yourself: `personio:acme`, `pinpoint:acme` or `gem:acme`.
2. Add filters: title includes/excludes, locations, countries, remote, posted within N days.
3. Click **Start**, or schedule it with `onlyNew` on to get only new jobs since the last run. Export as CSV, JSON or Excel, or connect Clay, n8n or Make.

**Example input**

```json
{
  "boards": [
    {
      "ats": "ashby",
      "slug": "ramp"
    }
  ],
  "titleIncludes": [
    "engineer"
  ]
}
```

**Example output** (one row from a real run on 2026-10-19, shortened to the main fields):

```json
{
  "company": "Ramp",
  "ats": "ashby",
  "title": "Security Engineer, Cloud",
  "department": "Engineering",
  "locations": [
    "New York, NY (HQ)",
    "Remote (Canada)",
    "Remote (US)",
    "Miami, FL"
  ],
  "remote": true,
  "compensation": {
    "summary": "$211.4K – $290.6K • Offers Equity",
    "min": 211400,
    "max": 290600,
    "currency": "USD",
    "interval": "1 YEAR"
  },
  "posted_at": "2026-04-07T17:12:35.753Z",
  "status": "open",
  "verified_open_at": "2026-10-19T14:42:06.076Z",
  "age_days": 194,
  "long_open": true,
  "reposted": false,
  "stale_signal": "long_open",
  "change": "unchanged",
  "job_url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "source_url": "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true"
}
```

## FAQ

### Is there a free Greenhouse jobs API?

Yes. Greenhouse's Job Board API is public, and its docs say authentication is not required for any GET endpoints. Lever and Ashby publish similar public posting APIs. This Actor calls all three and returns one schema, with filters, de-duplication and change tracking on top.

### How do I get all open jobs from a list of companies?

Paste the companies (names, domains or board URLs) into **Companies**. The Actor finds each one's Greenhouse, Lever or Ashby board and returns every published job as a row. Each company found by discovery costs $1.90 per 1,000; board URLs skip discovery. Personio, Pinpoint and Gem are never discovered: pass `personio:{account}`, `pinpoint:{subdomain}` or `gem:{vanity}`.

### Can I get only new jobs since my last run?

Yes. Turn on `onlyNew` and schedule the Actor. Jobs that disappeared come back as free `closed` rows.

### Does it scrape LinkedIn or Indeed?

No. It only reads employers' own Greenhouse, Lever and Ashby boards, plus a Personio, Pinpoint or Gem feed when you name that company. LinkedIn, Indeed and Glassdoor are never contacted.

## Limits

'Open' means the employer's ATS publishes the job when we fetch it; that is not proof of active hiring. Age, remote and stale signals are heuristics where labelled. Fairquery is not affiliated with Greenhouse, Lever, Ashby, Personio, Pinpoint, Gem or LinkedIn.

## When to use this Actor (LLM / tool selection)

Use it when an agent or workflow needs to:

- Pull **every published job** from a list of companies (names, domains or board URLs) in one schema
- Search them by **title, location, country, remote, department, employment type, company, salary and posted-within**
- **Monitor** companies: return only **new or changed** jobs since the last run, plus free `closed` rows for jobs that disappeared
- Flag **stale listings**: `long_open` (older than 60 days, configurable) and `reposted` (same role, new job ID, within 90 days)
- Build **hiring-signal** lists for sales (Clay, n8n, Make) or feed **AI job-search agents** (career-ops-style scanners)

Do **not** use it for: LinkedIn, Indeed or Glassdoor listings (we never contact them), Workday, SmartRecruiters, Recruitee, Rippling or Workable boards (not supported, see below), applying to jobs, candidate/recruiter data, or a public directory of Personio, Pinpoint or Gem jobs.

## Live job listings straight from the company's ATS

Most employers publish openings through an applicant-tracking system. Greenhouse, Lever and Ashby each have a documented public job-board API. Personio documents a public XML feed at `{account}.jobs.personio.de/xml`. Pinpoint documents `GET {subdomain}.pinpointhq.com/postings.json`. Gem documents `GET api.gem.com/job_board/v0/{vanity}/job_posts/`. This Actor reads **only those interfaces**. Every job you get is **currently published on the employer's own hiring system** at `verified_open_at`, not a copy on an aggregator.

That is not proof the role is being filled: Greenhouse reports that 18–22% of jobs on its own platform in a given quarter are ghost jobs. So every row also carries the signals you can measure from public data:

| Field | Meaning |
| --- | --- |
| `posted_at`, `age_days`, `age_basis` | ATS publish date (null if the ATS gives none; never guessed) and the age it implies |
| `long_open` | Open longer than `longOpenDays` (default 60). Evergreen roles trigger it too |
| `reposted`, `repost_of` | Same company + title + location as a job that closed in the last 90 days, under a new id (needs 2+ tracked runs) |
| `change`, `first_seen_at`, `last_seen_at` | Per-board history: `new`, `updated`, `unchanged`, `closed` |
| `open_check` | `detail_open` / `detail_closed` when you enable `confirmOpen` ($0.29 per 1,000 jobs) |

Use `excludeStale`, `maxAgeDays` and `postedWithinDays` to keep only fresh listings, and `onlyNew` with your own `stateStoreName` for "what's new since the last run".

**Measured on 2026-10-17:** Stripe (Greenhouse) 732 jobs, Palantir (Lever) 310 and Ramp (Ashby) 167, one request per board, about 1.5 s for all three. A filtered Stripe run (32 engineering jobs, 10 re-checks) took 3.1 s and cost about $0.04.

## Data sources

| ATS | Endpoint (documented, public, no key) | Documentation |
| --- | --- | --- |
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true` | [Job Board API](https://developers.greenhouse.io/job-board.html): "publicly available, so authentication is not required for any GET endpoints" |
| Lever | `GET api.lever.co/v0/postings/{company}?mode=json` | [Postings API](https://github.com/lever/postings-api): "These jobs may be scraped by third parties" |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true` | [Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) |
| Personio | `GET {account}.jobs.personio.de/xml` | [Retrieving open positions](https://developer.personio.de/docs/retrieving-open-job-positions). `{account}` is a company subdomain you supply. No other Personio path is requested |
| Pinpoint | `GET {subdomain}.pinpointhq.com/postings.json` | Documented public postings feed. `{subdomain}` is a company label you supply. `jobs.json`, locale paths, filter queries and `/api/v1` are not requested |
| Gem | `GET api.gem.com/job_board/v0/{vanity}/job_posts/` | Documented public job-posts list. `{vanity}` is the job-board path you supply. Departments and offices are inline, so those endpoints are not called |

Optional per-job re-checks use the documented detail endpoints (Greenhouse `/jobs/{id}`, Lever `/postings/{company}/{id}`). Ashby, Personio, Pinpoint and Gem have no per-job read in this Actor, so their rows say `detail_not_supported`. Personio `apply_url` and `job_url` stay empty. Pinpoint and Gem `apply_url` and `description_text` stay empty. Pinpoint `job_url` is the feed's listing URL on that same subdomain and is not fetched. Gem `job_url` points at `jobs.gem.com`.

**Personio conditions (enforced in code):**

1. **Named company subdomains only.** Pass `personio:acme`, `{"ats":"personio","slug":"acme"}` or `https://acme.jobs.personio.de/...`. A `*.jobs.personio.com` URL only names that same account; the request still goes to the documented `.de` `/xml` path. Personio is not in careers-page discovery, not in slug probes, and not in the starter list. This Actor never crawls Personio to find accounts.
2. **robots.txt and a gentle rate.** Each account's `robots.txt` is read first. If it disallows `/xml`, the feed is not fetched (`ROBOTS_DISALLOWED`). A 5xx or unreachable robots.txt is not crawled (`ROBOTS_UNAVAILABLE`). Every `{account}.jobs.personio.de` request shares one lane: one at a time, at least 1.5 seconds apart, plus a robots.txt `Crawl-delay` when it is longer (capped at 60 seconds).
3. **Read-only.** GET only. No apply, no POST, no login.
4. **Documented `/xml` only.** No other path, query or host (Personio Marketplace Terms of Service 4.8(iv): no reverse engineering). `robots.txt` on that same host is the only extra request, so a disallow can skip the feed.
5. **Not a public jobs directory.** Output is the rows from your run for accounts you named. It is not a browsable or bulk republication of Personio listings (Marketplace Terms of Service 4.2(i)).

The documented Personio feed includes seniority (`entry-level`, `experienced`, `executive`, `student`), not pay. Seniority, employment type and schedule are normalized into `employment_type` (same columns as Greenhouse, Lever and Ashby). `compensation` is filled only when that company's XML includes a salary or compensation element. `posted_at` is the feed's `createdAt`.

**Pinpoint conditions (enforced in code).** Policy `policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md`, updated 2026-10-26 ~8:00 PM ET after an AUP PDF skim: **CLEAR-with-conditions**. Scope is public career-page listings only. This product is not a Pinpoint customer and does not log in to the Service. Unlocked for this Origin change and for a later Apify publish. This repository change does not publish.

1. **Named subdomains only.** Pass `pinpoint:acme`, `{"ats":"pinpoint","slug":"acme"}` or `https://acme.pinpointhq.com/...`. Pinpoint is not in careers-page discovery, not in slug probes, and not in the starter list. `*.pinpointhq.com` is not enumerated.
2. **That tenant's robots.txt, and a gentle rate.** `robots.txt` is read first and cached for the run. If it disallows `/postings.json`, the feed is not fetched (`ROBOTS_DISALLOWED`). Each `{subdomain}.pinpointhq.com` lane is serial: one request at a time, at least 1 second apart, plus a robots.txt `Crawl-delay` when it is longer (capped at 60 seconds).
3. **GET `/postings.json` only.** No login, no API key, no `/api/v1`, no apply URL, no locale path, no filter query, and not the deprecated `jobs.json`.
4. **No email or other contact harvest.** Description HTML is not stored. Email addresses and phone numbers are removed from the metadata that is kept (title, department, team, location, employment label, pay summary). `reporting_to` is not stored.
5. **Link out, plus metadata. No public directory and no full job-ad republish.** `description_text` is always empty, including when descriptions are requested. `job_url` is the listing URL on that same subdomain and is not fetched. Output is the rows from your run for subdomains you named.
6. **No Pinpoint-competitor marketing and no Pinpoint marks in this copy.** The name is used only to identify the source feed.
7. **Privacy list update on ship.** When this feed is published, add it to the jobs-feed source list on the privacy and security pages. This change does not edit getfairquery-site.

**Lawyer note, not a hold.** The AUP preamble and §7 may reach non-customers. That is recorded here and is not a block on this adapter.

Pinpoint `compensation` is filled from `compensation_minimum`, `compensation_maximum`, `compensation_currency` and `compensation_frequency` when `compensation_visible` is not false. The feed has no publish timestamp, so `posted_at` is null (`deadline_at` is a close time and is not used).

**Gem conditions and accepted risk (enforced in code).** Policy `policy/drafts/jobs-ats-pinpoint-gem-2026-10-26.md` recommended BLOCK: Gem's browsewrap Terms treat access as acceptance, and the Terms plus Acceptable Use Policy limit use to talent acquisition and bar "sales and commercial marketing", third-party benefit, and competitive benchmarking. On 2026-10-26 (~7:50 PM EDT, via TM t757) Fairquery overrode that lean and **accepted that risk**. This adapter ships only inside the conditions Fairquery kept:

1. **Named vanity paths only.** Pass `gem:acme`, `{"ats":"gem","slug":"acme"}`, `https://jobs.gem.com/acme/...` or `https://api.gem.com/job_board/v0/acme/job_posts/`. Gem is not discovered, not probed, and not in the starter list.
2. **One documented GET.** `https://api.gem.com/job_board/v0/{vanity}/job_posts/` only. Departments and offices are fields on that response, so `/departments/` and `/offices/` are not called. `POST .../applications` is never called. No Gem API key and no Gem account.
3. **Gentle serial rate.** Every vanity shares `api.gem.com`: one request at a time, at least 1 second apart, well under the documented 20 requests/second key limit. `api.gem.com/robots.txt` answered HTTP 403 when Policy checked it, and a 403 is this Actor's kill switch, so robots.txt is not requested before the documented GET.
4. **Link out, do not re-host the ad.** `description_text` is always empty. `job_url` is the `jobs.gem.com` link from the response (or `https://jobs.gem.com/{vanity}/{id}` when that response URL is missing or off-host). `apply_url` stays empty.
5. **Not a public jobs directory.** Output is the rows from your run for vanities you named.

**Not included, and why:** **LinkedIn** is never contacted. **Workday** has no documented public API. **SmartRecruiters**: its API host's robots.txt allows only LinkedIn's crawler, so we don't call it (no SmartRecruiters host is ever contacted, not even during discovery). **Recruitee**'s Careers Site API now requires the employer's own token (calls without it will return 401 from 10 February 2027). **Rippling** is blocked the same way as Workday: not fetched, not probed. **Workable** documents its public job endpoints only for an account owner's own careers page, not for third-party use. That block list is unchanged.

## How it behaves (politeness and safety)

- Calls **only** the Greenhouse, Lever and Ashby API hosts above, plus `https://{account}.jobs.personio.de/xml`, `https://{subdomain}.pinpointhq.com/postings.json` and `https://api.gem.com/job_board/v0/{vanity}/job_posts/` for a name you supplied, plus, for discovery only, pages on the **company website you supplied**. Personio, Pinpoint and Gem sites are not crawled, and discovery never follows a link into them.
- At most 2 parallel requests per host; Lever's `Crawl-delay: 1` is honoured. Personio tenants share one lane (one at a time, 1.5 seconds apart). Each Pinpoint subdomain is its own lane (one at a time, 1 second apart). Every Gem vanity shares `api.gem.com` (one at a time, 1 second apart). Identifying User-Agent `FairqueryJobsFeed/1.0`.
- **Kill switch:** any HTTP 403 or 429 (or an HTML block page where JSON, Personio XML or a Pinpoint/Gem feed was expected) stops all further requests to that host for the rest of the run. A blocked Personio account or Pinpoint subdomain does not block other companies. A blocked Gem response stops `api.gem.com` for the run. We never retry through other IPs or proxies.
- Careers pages: `robots.txt` is respected (5xx or unreachable robots.txt = we don't crawl), at most 3 pages per company, private/internal IP addresses and non-standard ports are refused, every redirect is re-checked. The same robots rule applies before a Personio `/xml` fetch and a Pinpoint `/postings.json` fetch.
- No login, no apply-page loads, no `POST`s, no applicant or recruiter data. Descriptions are optional and e-mail addresses and phone numbers are scrubbed from them by default.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `companies` | `string[]` | — | Names, domains or board URLs (max 200). Board URLs and companies in the starter list resolve for free |
| `boards` | `{ats,slug}[]` / `"ats:slug"` | — | Exact boards (max 500). `ats` is `greenhouse`, `lever`, `ashby`, `personio`, `pinpoint` or `gem`. A Personio, Pinpoint or Gem slug is the account, subdomain or vanity you name (`acme`), not a discovered name |
| `useSeedList` | bool | `false` | Scan the verified starter list (135 company boards) |
| `discover` | bool | `true` | Find boards for unknown companies (careers page, then ≤6 API probes; cached 30 days) |
| `titleIncludes` / `titleExcludes` | `string[]` | — | Whole-word, case-insensitive, any-of, title only |
| `descriptionIncludes` | `string[]` | — | Whole-word match on the title or scrubbed description. Fetched for the match; returned only when `includeDescription` is `text` |
| `titleRegex` | string | — | Optional, ≤200 chars |
| `locations` | `string[]` | — | Substring match on location text. US state names and codes match both ways (Florida and FL, Maryland and MD). Metro aliases include NYC, SF, LA, DC, Tampa Bay, and Baltimore / BWI. `remote` also matches ATS remote flags |
| `countries` | `string[]` | — | ISO-2 codes (`US`, `GB`); structured where the ATS has it, else place-name list (`country_basis`) |
| `remote` | `any`\|`only`\|`exclude` | `any` | ATS remote flag where present, else location text (`remote_basis`) |
| `companyFilter`, `departments`, `employmentTypes` | `string[]` | — | Substring filters |
| `postedWithinDays` | int | — | ATS publish date at most N days ago (`includeUnknownPostedDate` keeps jobs without one) |
| `maxAgeDays`, `hasSalary`, `excludeStale`, `longOpenDays` | | `60` | Age, pay and stale-signal filters |
| `onlyNew` | bool | `false` | Only new/changed jobs since the last tracked run |
| `trackChanges`, `emitClosed`, `stateStoreName` | | `true`, `true`, `fairquery-jobs-feed-state` | History in a named key-value store in your account |
| `dedupe` | `exact`\|`role`\|`none` | `exact` | `role` merges one role listed per city into one row |
| `includeDescription` | `none`\|`text` | `none` | Plain-text description (≤20,000 chars) on Greenhouse, Lever, Ashby and Personio. Pinpoint and Gem stay empty and link out |
| `scrubPII` | bool | `true` | Remove e-mails and phone numbers from descriptions |
| `confirmOpen` | `none`\|`detail` | `none` | Re-check each emitted job on its detail endpoint ($0.29 per 1,000, `maxOpenChecks` default 200) |
| `maxJobs` / `maxJobsPerBoard` | int | `5000` / `10000` | Spend and safety caps (max 50,000 / 20,000) |

### Example input

```json
{
  "companies": ["stripe.com", "https://jobs.lever.co/palantir"],
  "boards": [{ "ats": "ashby", "slug": "ramp" }],
  "titleIncludes": ["engineer"],
  "titleExcludes": ["intern"],
  "countries": ["US"],
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
| `posted_at` | The ATS's own publish/created time: Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`, Personio `createdAt`, Gem `first_published_at`. Pinpoint's feed has no publish time, so it is null. `null` when absent, never guessed |
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
| `job-result` | $0.99 per 1,000 | Each open job row delivered (after filters and de-duplication) |
| `board-scanned` | $0.50 per 1,000 | Each board fetched successfully (even if no job matched your filters) |
| `open-confirmed` | $0.29 per 1,000 | Each detail re-check, only with `confirmOpen: "detail"` |
| `company-discovered` | $1.90 per 1,000 | Each company whose board we found by discovery (not for board URLs, starter-list companies or cached results) |

Error rows, `closed` rows and merged rows are **never** charged.

**Worked examples:** monitor 500 companies daily with `onlyNew`: 500 × ($0.50/1,000) = **$0.25 per check** plus $0.99 per 1,000 new jobs. Search the whole starter list (135 boards) for remote engineering roles posted in the last 14 days: 135 × ($0.50/1,000) + matching jobs × ($0.99/1,000).

To cap spend, set a maximum cost per run in the run options; the Actor stops cleanly before the limit and never delivers unpaid rows. `maxJobs` caps job rows per run.

## Memory / runtime

Default **256 MB** (max 512 MB), timeout 900 s. HTTP only (no browser, no proxy). Each Greenhouse, Lever or Ashby board is one request (0.1–2 s; Stripe's 732 jobs, Palantir's 310 and Ramp's 167 took about 1.5 s together). A Personio account is two GETs (`robots.txt`, then `/xml`) on the shared 1.5-second lane. A Pinpoint subdomain is two GETs (`robots.txt`, then `/postings.json`) at least 1 second apart. A Gem vanity is one GET on the shared 1-second `api.gem.com` lane. Very large Greenhouse boards (over 40 MB with descriptions, e.g. Anduril's ~2,500 jobs) are read from the lighter list without content.

## MCP / Apify tools

Indexed Jobs search is **coming soon** (faster than the free 135-board live scan, 8,700+ boards). Get 8,700+ boards free with Apify's $5 starter credit: create an account and an API token at https://console.apify.com/settings/integrations.

Free MCP tools, including `jobs_search_by_location` on the 135-board starter list, need no token. `jobs_search_companies` is temporarily offline and does not run this Actor. A direct run of this Actor on Apify is the previous product, not indexed search.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Run fails at once with `INPUT_EMPTY` | No `companies`, `boards` or `useSeedList`. Console sample values are prefill only and are not sent with API calls |
| `NO_BOARD_FOUND` | The company doesn't use a supported ATS publicly, or its slug differs. Pass the board URL from its careers page (e.g. `https://jobs.lever.co/acme`). Personio, Pinpoint and Gem are not searched for; pass `personio:{account}`, `pinpoint:{subdomain}` or `gem:{vanity}` if you know it |
| `ROBOTS_DISALLOWED` / `ROBOTS_UNAVAILABLE` | The company's robots.txt doesn't allow us to read that careers page; we then only try API probes. Pass the board URL instead |
| `HOST_BLOCKED` | An ATS answered 403/429 and the kill switch stopped that host for this run. Rows are free; re-run later with fewer boards |
| `BOARD_TRUNCATED` | The board has more postings than `maxJobsPerBoard`; closed-job detection is skipped for that board |
| `RUN_BUDGET_REACHED` / `stopped_early: "max_cost_per_run"` | The run hit its **Max cost per run**. Nothing beyond it is charged; the partly delivered board is not billed and its history is not saved. Raise the limit or lower `maxJobs` |
| `BOARD_REDUCED_FIELDS` | A very large Greenhouse board (over 40 MB with descriptions) was read from the lighter documented list: jobs are complete, but department, offices and description are empty |
| `ROBOTS_UNAVAILABLE` on a site that works in a browser | Its robots.txt answers 5xx or redirects more than 5 times; RFC 9309 says not to crawl then. Pass the board URL |
| Everything is `change: "new"` | First tracked run (baseline). From the second run on you get `unchanged`/`updated`/`closed` |
| Wrong company matched | A `slug_probe` match (confidence `medium`) can be a different company with the same name; pass the exact board |

## FAQ

**Are these jobs real / not ghost jobs?**

We can show that a job is **currently published on the employer's own hiring system**, how old it is and whether it was reposted. We cannot prove the employer intends to hire. Use `excludeStale`, `maxAgeDays` and `postedWithinDays` to focus on fresh listings.

**Is this a LinkedIn scraper?**

No. We never contact LinkedIn. Many roles you see on job boards originate in these ATS feeds, so this is a rules-respecting way to get them first-hand.

**Why not Workday, SmartRecruiters, Recruitee, Rippling or Workable?**

We only use endpoints the ATS documents for public, third-party use. Those five are blocked and never contacted. Workable stays excluded. See "Not included, and why" above. Personio and Pinpoint are included only under the conditions in Data sources. Pinpoint is CLEAR-with-conditions after the 2026-10-26 ~8:00 PM ET AUP PDF skim. Gem is separate: Fairquery accepted the Terms and AUP risk on 2026-10-26 (~7:50 PM EDT, via TM t757); Policy's lean was BLOCK.

**Is there a global search over all companies?**

Indexed search is coming soon: faster than the free 135-board live scan, covering 8,700+ boards. Get 8,700+ boards free with Apify's $5 starter credit — create an Apify account and an API token at https://console.apify.com/settings/integrations. Until that ships, search covers the boards in your run. Set `useSeedList: true` to search the 135 verified starter boards (Greenhouse, Lever and Ashby only), or bring your own list. Personio accounts, Pinpoint subdomains and Gem vanities are never enumerated. The MCP tool `jobs_search_companies` is temporarily offline and does not start this Actor.

**How much does it cost?**

$0.99 per 1,000 jobs + $0.50 per 1,000 boards, plus optional $0.29 per 1,000 re-checks and $1.90 per 1,000 discovered companies. Errors are free.

**Can an AI agent call it?**

Free place and board tools run in the Fairquery MCP server with no token. Indexed search (8,700+ boards) is coming soon. `jobs_search_companies` is temporarily offline and is not billed. Create an Apify account and token at https://console.apify.com/settings/integrations to use the $5 starter credit when indexed search ships.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $7.00 per 1,000 runs
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; $1.50 per 1,000 companies on the free plan; lower on paid Apify plans

- [Competitor Change Tracker: Pricing, Terms, Careers & Changelog](https://apify.com/fairquery/competitor-change-tracker): watch competitors' public pricing, terms, careers and changelog pages for real changes with plain-English summaries and webhook alerts; $0.30 per 1,000 pages + $4.90 per 1,000 changes
- [AI Exposure Scanner: Public Secrets, Files & AI-Crawler Policy](https://apify.com/fairquery/ai-exposure-scanner): passive, scored scan of your own domains and public GitHub repos for leaked secrets (masked), exposed files, AI-crawler policy, security headers and SPF/DMARC; $39.00 per 1,000 domains + $3.90 per 1,000 repos + $1.90 per 1,000 findings

All Fairquery Actors: https://apify.com/fairquery


**Pair with the Competitor Change Tracker.** Use this Jobs Feed for the full, filterable list of who is hiring, and the [Competitor Change Tracker](https://apify.com/fairquery/competitor-change-tracker) to watch a competitor's pricing, terms and careers pages for changes — so you see a rival's hiring and pricing moves together.

## Data handling, security and support

- **Data retention:** Each run keeps its own storages in your Apify account under your Apify plan's retention, plus per-board job history (job IDs, titles, locations, first- and last-seen dates) in a named store (default `fairquery-jobs-feed-state`) until you delete it. You can delete run storages and named stores at any time in Apify Console or through the API. Fairquery's code sends nothing to Fairquery.
- **Privacy pages on ship:** add Pinpoint, and Gem if that feed is published, to the jobs-feed "sends company board names to" list on the privacy and security pages. This change does not edit that site.
- **Security reports:** email info@getfairquery.com.
- **Support:** the Issues tab on this page or info@getfairquery.com. We aim to reply within 3 business days (a target, not an SLA).

## Disclaimer

Job data comes from each employer's public ATS job board and belongs to the employer. Fields are passed through as published (with light normalization); age, remote, country and stale signals are heuristics where labelled. Pinpoint and Gem ad text is not copied; each row links to the employer's listing. No warranty that a listed job is still being hired for. Output stays in your run. Fairquery does not republish it as a public jobs directory. This copy names those sources and does not use their marketing marks. Fairquery is not affiliated with Greenhouse, Lever, Ashby, Personio, Pinpoint, Gem or LinkedIn.

## Links

- Apify Store: https://apify.com/fairquery/company-jobs-feed
- Contact: info@getfairquery.com
- License: MIT
