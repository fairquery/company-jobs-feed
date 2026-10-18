# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest Apify Actor build and `main` branch | Yes |
| Older releases | No. Please upgrade first |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Email **fairquery@proton.me** with a description, the affected version, reproduction steps and the impact. Or
- Use **Report a vulnerability** on this repository's **Security** tab (GitHub private vulnerability reporting).

Response targets: acknowledgement within **3 business days**, initial assessment within **7 days**, and a fix or mitigation for critical issues within **30 days**, with coordinated disclosure and credit if you want it.

Please don't access other users' data or degrade any job board while testing. Report vulnerabilities in third-party platforms (Apify, Greenhouse, Lever, Ashby, npm, GitHub) to those vendors.

## Network and SSRF model

- **ATS calls** go only to three fixed hosts over HTTPS: `boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`. Redirects are not followed. Any other host is refused (`URL_NOT_ALLOWED`).
- **Careers pages** (discovery only) are fetched only for domains or URLs the user supplied, and only links on the same registrable domain (at most 3 pages per company). Each hop: http/https on ports 80/443 only, no credentials in URLs, no IP literals, no internal TLDs. DNS answers are checked against private, loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6, IPv4-mapped refused), and the connection is pinned to the checked address so DNS rebinding can't swap it. Redirects are re-checked hop by hop.
- **Excluded systems:** no host under `smartrecruiters.com`, `myworkdayjobs.com`, `workday.com`, `workable.com`, `recruitee.com` or `linkedin.com` is ever fetched, not even as a careers page or redirect target (`UNSUPPORTED_ATS`).
- **robots.txt** (RFC 9309) is read before any careers page: 4xx = allowed, 5xx/unreachable/too many redirects = not crawled.
- **Kill switch:** HTTP 403 or 429, or an HTML block page instead of JSON, stops all further requests to that host for the run (`HOST_BLOCKED`). No retries around blocks, no proxies, no login, no CAPTCHA solving.
- **Politeness:** at most 2 concurrent requests per host, Lever requests at least 1 s apart (its `Crawl-delay`), response caps (40 MB JSON, 2 MB HTML), 15 s timeouts.
- **Input caps:** 200 companies, 500 boards, 50,000 jobs per run; user regex limited to 200 characters and rejected if it has nested quantifiers (ReDoS).

## Data handling

This repository contains an Apify Actor and a local stdio MCP server (`mcp/`).

- **Actor runs** execute in *your own* Apify account. Results go to the run's default dataset; history (job ids, first/last seen, a content hash, title, location) goes to a named key-value store in your account (`stateStoreName`) that you control and can delete. Nothing is sent to Fairquery.
- Job descriptions are optional; when included, e-mail addresses and phone numbers are removed by default (`scrubPII`).
- **MCP server:** runs on your machine. Free tools call only the three ATS hosts (and, for `jobs_find_board` with a domain, that company's careers pages under the rules above). The paid tool runs the Actor with your own `APIFY_TOKEN`, which is read from the environment only when needed and is never logged or returned.
- The repository contains no credentials. LinkedIn is never contacted.
