import { Actor, log } from 'apify';

/**
 * Buffers dataset rows and pushes/charges them in batches (one pushData + one Actor.charge({count}) per
 * event per batch). A row may carry several events (e.g. job-result + open-confirmed).
 * Rows are always saved before they are charged; rows with no events (errors, boards merged by de-dup,
 * closed rows) are never charged. On a pay-per-event run, a charged row that would exceed the user's
 * max-cost-per-run budget is not pushed at all, so nothing is delivered unpaid and nothing is charged
 * beyond the budget.
 */
export class Emitter {
    private buf: { row: object; events: string[] }[] = [];
    private pendingUsd = 0;
    private ppe: boolean | null = null;
    private prices: Record<string, number> = {};
    private maxUsd = Infinity;
    limitReached = false;
    readonly charged: Record<string, number> = {};
    pushed = 0;

    constructor(private readonly batchSize = 200) {}

    /** Returns false (and pushes nothing) when the run's charge budget can't cover the row. */
    async emit(row: object, events: string[] = []): Promise<boolean> {
        if (events.length && this.isPpe()) {
            const cost = events.reduce((s, e) => s + (this.prices[e] ?? 0), 0);
            if (cost > 0 && cost > this.remainingUsd() + 1e-12) {
                if (!this.limitReached) log.warning('Max cost per run reached; stopping cleanly.');
                this.limitReached = true;
                return false;
            }
            this.pendingUsd += cost;
        }
        this.buf.push({ row, events });
        if (this.buf.length >= this.batchSize) await this.flush();
        return true;
    }

    async flush(): Promise<void> {
        if (!this.buf.length) return;
        const batch = this.buf;
        this.buf = [];
        await Actor.pushData(batch.map((b) => b.row));
        this.pushed += batch.length;
        const counts = new Map<string, number>();
        for (const b of batch) for (const e of b.events) counts.set(e, (counts.get(e) ?? 0) + 1);
        for (const [eventName, count] of counts) this.charged[eventName] = (this.charged[eventName] ?? 0) + count;
        if (!this.isPpe()) return;
        for (const [eventName, count] of counts) {
            try {
                const res = await Actor.charge({ eventName, count });
                if (res.eventChargeLimitReached) {
                    log.warning(`Charge limit reached for ${eventName}`);
                    this.limitReached = true;
                }
            } catch (e) {
                log.debug(`Actor.charge failed for ${eventName}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        this.pendingUsd = 0;
    }

    private remainingUsd(): number {
        if (!Number.isFinite(this.maxUsd)) return Infinity;
        let spent = 0;
        const cm = Actor.getChargingManager();
        for (const [e, p] of Object.entries(this.prices)) spent += cm.getChargedEventCount(e) * p;
        return this.maxUsd - spent - this.pendingUsd;
    }

    private isPpe(): boolean {
        if (this.ppe === null) {
            try {
                const info = Actor.getChargingManager().getPricingInfo();
                this.ppe = info.isPayPerEvent;
                this.prices = info.perEventPrices ?? {};
                this.maxUsd = info.maxTotalChargeUsd ?? Infinity;
            } catch {
                this.ppe = false;
            }
        }
        return this.ppe;
    }
}
