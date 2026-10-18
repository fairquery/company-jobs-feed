# Company Jobs Feed: live jobs from Greenhouse, Lever & Ashby (Apify Actor + MCP server)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Live job listings read **straight from employers' own applicant-tracking systems** through their official public job-board APIs, plus an MCP server so AI agents can use the same data. Every row says when it was verified as **currently published on the employer's own hiring system**, how old the posting is, whether it has been open a long time, and whether it looks like a repost.

- **Apify Actor:** [`fairquery/company-jobs-feed`](https://apify.com/fairquery/company-jobs-feed), pay per result: **$0.99 per 1,000 jobs** + $0.0005 per board scanned (+ $0.00029 per optional per-job re-check, $0.0019 per company found by discovery). Error, closed and merged rows are free.
- **MCP server** ([`mcp/`](./mcp)): four free tools that run on your machine with no token, and one paid tool that runs the Actor in your Apify account.

> Honest scope: "currently published" is not "guaranteed to be hiring". The feed gives age, long-open and repost signals so you can filter likely stale or evergreen listings; it does not claim to be ghost-free.

## Sources

| ATS | API used | Included |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` (Job Board API) | Yes |
| Lever | `api.lever.co/v0/postings/{slug}` (Postings API) | Yes |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` (public Job Postings API) | Yes |
| SmartRecruiters | its API host's robots.txt allows only LinkedIn's crawler | No (never contacted) |
| Recruitee | Careers Site API needs an employer token | No |
| Workable | public endpoints are documented only for the account's own careers page | No |
| Workday | no public job API | No |
| LinkedIn | not contacted at all | No |

Company names, domains and careers URLs can be resolved to boards (careers-page links with robots.txt respected, then at most 6 slug probes against the APIs). 51 verified starter boards ship in [`src/seed.ts`](./src/seed.ts).

## MCP server

### Install

Requires Node.js 20+. From npm: [`@fairquery/company-jobs-feed-mcp`](https://www.npmjs.com/package/@fairquery/company-jobs-feed-mcp). Claude Desktop / Cursor / VS Code (`mcpServers` config):

```json
{
  "mcpServers": {
    "fairquery-jobs-feed": {
      "command": "npx",
      "args": ["-y", "@fairquery/company-jobs-feed-mcp"],
      "env": { "APIFY_TOKEN": "<only needed for jobs_search_companies>" }
    }
  }
}
```

Gemini CLI: `gemini extensions install https://github.com/fairquery/company-jobs-feed` (runs the npm package with `npx`; one optional, sensitive setting for your own Apify token).

From source: `git clone https://github.com/fairquery/company-jobs-feed && cd company-jobs-feed/mcp && npm ci --ignore-scripts && npm run build && node dist/index.js`.

Docker: `docker build -t fairquery-jobs-feed-mcp . && docker run -i --rm fairquery-jobs-feed-mcp`.

### Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `jobs_get_board` | free, local | All jobs currently published on one board (ats + slug), normalized and filtered by title, location, country, remote and posted-within. Returns `posted_at`, `age_days`, `long_open`, `verified_open_at`, apply URL |
| `jobs_find_board` | free, local | Resolve a company name, domain or careers URL to its Greenhouse/Lever/Ashby board, with `via` and `confidence` |
| `jobs_check_open` | free, local | Re-check one job right now: `open` or `closed` (detail endpoint; Ashby via the board listing). With `includeDescription: true`, an open job also comes back with its full job row incl. `description_text` |
| `jobs_list_seed_boards` | free, offline | The verified starter boards (company, domain, ats, slug, verified_at) |
| `jobs_search_companies` | paid (Apify PPE) | Many companies at once with discovery, history (first/last seen, new/updated/closed), repost detection, optional re-checks and descriptions. Needs `APIFY_TOKEN` |

Every tool is read-only (`readOnlyHint: true`, `destructiveHint: false`), has an output schema, and describes every parameter. Descriptions follow a WHAT / WHEN / WHEN NOT / BEHAVIOR / COST / RETURNS / PARAMETERS / EXAMPLE layout. Without `APIFY_TOKEN`, `initialize`, `tools/list` and the four free tools work; the paid tool returns `APIFY_TOKEN_MISSING`.

## Use the Actor from code

```bash
curl -X POST "https://api.apify.com/v2/acts/fairquery~company-jobs-feed/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"companies":["stripe.com","ramp.com"],"titleIncludes":["engineer"],"countries":["US"]}'
```

```js
import { ApifyClient } from 'apify-client';
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor('fairquery/company-jobs-feed').call({
    companies: ['https://jobs.lever.co/palantir'],
    countries: ['US'], titleIncludes: ['engineer'], postedWithinDays: 180,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
```

Input, output fields, pricing examples, troubleshooting and FAQ: [`.actor/README.md`](./.actor/README.md).

## Example job row

Real row from a test run on 2026-10-17 (Ramp, Ashby; abbreviated):

```json
{
  "type": "job", "job_key": "ashby:ramp:34413f8d-26bf-4bbc-8ade-eb309a0e2245", "ats": "ashby", "board": "ramp",
  "company": "Ramp", "title": "Security Engineer, Cloud", "department": "Engineering",
  "locations": ["New York, NY (HQ)", "Remote (Canada)", "Remote (US)", "Miami, FL"], "countries": ["US", "CA"],
  "remote": true, "workplace_type": "hybrid",
  "posted_at": "2026-04-07T17:12:35.753Z", "age_days": 193, "age_basis": "posted_at", "long_open": true,
  "verified_open_at": "2026-10-17T22:54:03.924Z", "first_seen_at": "2026-10-17T22:54:03.924Z", "change": "new", "reposted": false,
  "compensation": { "summary": "$211.4K – $290.6K • Offers Equity", "min": 211400, "max": 290600, "currency": "USD", "interval": "1 YEAR" },
  "apply_url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application", "fingerprint": "646e3148231ba20d"
}
```

## Politeness and security

Only the three documented API hosts are called (HTTPS, no redirects). Careers pages are read only for domains you supply, with robots.txt (RFC 9309), SSRF protection (private IPs refused, DNS pinned) and a 3-page cap. Any 403/429 stops that host for the run. No login, no proxies, no evasion. See [SECURITY.md](./SECURITY.md).

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md). `npm test` (31 unit tests), `npm run mcp:build && npm run mcp:test` (MCP build + smoke test).

## More from Fairquery

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Contact & Company Enricher](https://apify.com/fairquery/website-contact-company-enricher): domain in, public business emails, phones, socials and company details out; $3 per 1,000 domains
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $0.007 per run
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; from $1.50 per 1,000 companies
- [Competitor Change Tracker: Pricing, Terms, Careers & Changelog](https://apify.com/fairquery/competitor-change-tracker): watch competitors' public pricing, terms, careers and changelog pages for real changes with plain-English summaries and webhook alerts; $0.00049 per page checked + $0.0049 per change
- [AI Exposure Scanner: Public Secrets, Files & AI-Crawler Policy](https://apify.com/fairquery/ai-exposure-scanner): passive, scored scan of your own domains and public GitHub repos for leaked secrets (masked), exposed files, AI-crawler policy, security headers and SPF/DMARC; $0.039 per domain + $0.0039 per repo + $0.0019 per finding
- **MCP server** [`@fairquery/agent-trust-mcp`](https://www.npmjs.com/package/@fairquery/agent-trust-mcp): one MCP server for Claude Desktop, Cursor and VS Code (`npx -y @fairquery/agent-trust-mcp`). It has 8 free tools that need no token, plus paid tools that call the PII, email, sanctions and OSV Actors with your own Apify token.

All Fairquery Actors: https://apify.com/fairquery

## License

MIT © 2026 Fairquery. Job data belongs to the employers. Not affiliated with Greenhouse, Lever, Ashby or LinkedIn.
