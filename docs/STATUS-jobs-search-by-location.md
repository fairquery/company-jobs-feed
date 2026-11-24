# STATUS: jobs by place and role

Ready for Fairquery to merge. Not published (no npm, Registry, Apify, or wrangler).

## How an agent should call “avionics jobs in Baltimore MD”

Call `jobs_search_by_location` immediately. Do not ask for a company. Do not call `jobs_find_board` or `jobs_get_board` first.

```json
{"locations":["Baltimore MD"],"descriptionIncludes":["avionics"]}
```

- A place is required: `locations`, `countries`, or `remote: "only"`. There is no company parameter.
- `Baltimore`, `Baltimore MD`, and `BWI` match each other. `MD` and `Maryland` match Maryland locations, including `Baltimore, MD`. A Baltimore search does not return every Maryland job.
- `descriptionIncludes` is a whole-word, case-insensitive match on the title, the department, or the scrubbed description. `avionics` can match an Avionics department on the lite list, or Electrical Technician when the posting body says avionics. Greenhouse matches title and department on the short list before any body request. A body is requested only when the keyword is still missing there, or `includeDescription` needs the text, and that list already has a job in the place. This free tool skips the Greenhouse body when the lite list has more than 1,000 jobs (Anduril's ~44 MB body does not fit the 128 MB isolate; local calls use the same rule). Those boards are named in `meta.title_only_boards`. Lever and Ashby descriptions are in the one list response. Set `includeDescription` only when the row should include `description_text`.
- If the scan hits its wall-clock budget (25 seconds), its CPU work budget, the 200-row match cap, or 300 ATS requests, it still returns MCP JSON. Both the CPU budget and the request cap are hard ceilings. One call does not run unbounded on Paid CPU or Paid subrequests. The CPU budget is 12,000 ms of estimated work: 8,000 JSON characters per millisecond, plus 0.08 ms for each row built. That is above the 1.1.15 Free-plan ceiling of 1,000 ms (which soft-stopped near starter board 26) and under the Paid default of about 30 seconds of CPU. Deployed Workers do not advance `performance.now()` during the synchronous parse, so the meter is characters walked and rows built. 300 requests covers one lite list for each of the 135 starter boards plus a Greenhouse body when a description is still needed and the board has at most 1,000 jobs (worst case about 223) and stays under Paid's 10,000 subrequests. `meta.partial` is true, `meta.stop_reason` is `time_budget`, `cpu_budget`, `row_cap`, or `subrequest_budget`, `meta.cost_usd` is 0, and the rows are only jobs already matched. A scan that throws still returns that JSON with `stop_reason` `error`. A board larger than 3 MB is cut off and the other boards continue. Nothing is invented.
- `offset` pages rows inside this response. It does not continue the board walk. `meta.next_board_cursor` is the first starter-list index this call did not start. Pass it as `boardCursor` with the same place and keywords. It is null only when every board from the current cursor through the end was started, or no boards remain. A board error does not pull it backward behind boards already started. `meta.complete` is true when this call started every board from `board_cursor` through the end and did not hit a budget. `meta.cut` is true when a board was byte-cut, a large body was skipped, or the walk stopped early. `meta.boards_reached` is how many boards this call started and matches the cursor: a numeric `next_board_cursor` is `board_cursor + boards_reached`.
- `titleIncludes` stays title-only. Do not put the same role word in both filters.
- `cost_usd` is 0. No Apify token. `meta.notice` (also `meta.notes[0]`) tells the user indexed search is coming soon (8,700+ boards, faster than this 135-board scan) and to create an Apify account and token at https://console.apify.com/settings/integrations for the $5 starter credit. When `meta.partial` is true, the notice starts with how many of `meta.boards_total` boards this call finished. Free limits are unchanged.
- When `jobs_matched` is 0 after a board answers, read `meta.suggestions`: tokens tried, place aliases that had open roles, a sample of titles in that place, and a note that the starter list is not every employer. Those fields are not job listings. Nothing is invented.
- The starter list is 135 public Greenhouse, Lever, and Ashby boards (51 from 2026-10-17 plus 84 verified 2026-10-27). Personio, Pinpoint, and Gem are named accounts only. Workday, LinkedIn, SmartRecruiters, Recruitee, Rippling, iCIMS, Taleo, and SuccessFactors are not covered.

Remote RN jobs in PA:

```json
{"locations":["PA"],"remote":"only","descriptionIncludes":["RN"]}
```

`RN` matches the whole word RN. It does not match “Registered Nurse”. Add `nurse` in `descriptionIncludes` when that word should count.

## Hosted retest (must pass before the Worker is considered fixed)

Do this on the hosted Free Worker after deploy. Do not treat a local `apify run` as this check. Each call must return MCP JSON. A Server error, an empty body, or an uncaught exception is a failure. `meta.cost_usd` stays 0. Nothing is stored.

1. Avionics in Costa Mesa. Call `jobs_search_by_location` with `{"locations":["Costa Mesa"],"descriptionIncludes":["avionics"]}` and `boardCursor` 0. One Paid call should get past board 26 and reach Anduril (starter index 32) without a follow-up cursor. Expect Anduril titles (the lite list is enough; Anduril has about 2,500 jobs, so the hosted path must not download the Greenhouse body). `meta.title_only_boards` includes `greenhouse/andurilindustries` when that board was reached and the body was skipped. If `meta.complete` is false, the remaining stop is the 25 second wall clock (`time_budget`), not `cpu_budget` or `subrequest_budget`: Lever is one request per second and there are 15 Lever boards, so a slow network can still page via `meta.next_board_cursor`. `meta.partial`, `meta.complete`, `meta.cut`, and `meta.stop_reason` must agree with how far the call got.
2. Avionics in Allentown. Call with `{"locations":["Allentown"],"descriptionIncludes":["avionics"]}`. The call must finish with JSON, not a Server error. Read `meta.complete`. If it is false and `meta.next_board_cursor` is a number, that number is the board to pass next, and `meta.stop_reason` says why this call stopped. Null means every remaining board was started; do not resume. Loop while `meta.next_board_cursor` is a number. An empty-keyword `{"locations":["PA"]}` must also return partial JSON (`stop_reason` `row_cap` once 200 jobs match), not a Server error.

Relevance ordering that would scan aerospace boards before the general tech list is not in this change. The Paid ceilings are meant to reach Anduril (index 32) and most of the 135 boards in one call. `boardCursor` remains the way to continue when the 25 second wall clock stops the walk.
