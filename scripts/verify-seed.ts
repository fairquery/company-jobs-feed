/**
 * Re-verify the starter list against the live official ATS APIs (one list request per board,
 * SmartRecruiters paged). Prints a table and exits 1 if any board is missing or empty.
 * Usage: npm run verify-seed
 */
import { fetchBoard } from '../src/ats.js';
import { AtsClient, HostGate } from '../src/http.js';
import { SEED_BOARDS } from '../src/seed.js';

const client = new AtsClient(new HostGate());
let bad = 0;
let total = 0;
for (const s of SEED_BOARDS) {
    try {
        const f = await fetchBoard(client, s.ats, s.slug, { maxJobs: 50_000, withDescription: false, companyHint: s.company });
        const ok = !f.notFound && f.total > 0;
        if (!ok) bad++;
        total += f.total;
        console.log(`${ok ? 'OK  ' : 'FAIL'} ${s.ats.padEnd(16)} ${s.slug.padEnd(22)} jobs=${String(f.total).padStart(6)} (was ${s.jobs_at_verification}) api_company=${f.company ?? '-'}`);
    } catch (e) {
        bad++;
        console.log(`ERR  ${s.ats.padEnd(16)} ${s.slug.padEnd(22)} ${e instanceof Error ? e.message : String(e)}`);
    }
}
console.log(`\n${SEED_BOARDS.length - bad}/${SEED_BOARDS.length} boards OK, ${total} jobs`);
process.exit(bad ? 1 : 0);
