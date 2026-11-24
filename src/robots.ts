interface RobotsGroup {
    agents: string[];
    rules: { allow: boolean; path: string }[];
    /** Non-standard Crawl-delay, milliseconds. Null when the group does not set one. */
    crawlDelayMs: number | null;
}

export interface Robots {
    groups: RobotsGroup[];
    sitemaps: string[];
}

export function parseRobots(text: string): Robots {
    const groups: RobotsGroup[] = [];
    const sitemaps: string[] = [];
    let cur: RobotsGroup | null = null;
    let lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'user-agent') {
            if (!cur || !lastWasAgent) {
                cur = { agents: [], rules: [], crawlDelayMs: null };
                groups.push(cur);
            }
            cur.agents.push(val.toLowerCase());
            lastWasAgent = true;
        } else if (key === 'allow' || key === 'disallow') {
            lastWasAgent = false;
            if (cur && (val || key === 'allow')) cur.rules.push({ allow: key === 'allow', path: val });
        } else if (key === 'crawl-delay') {
            lastWasAgent = false;
            const sec = Number(val);
            if (cur && Number.isFinite(sec) && sec >= 0) cur.crawlDelayMs = Math.max(cur.crawlDelayMs ?? 0, sec * 1000);
        } else if (key === 'sitemap') {
            if (val) sitemaps.push(val);
        } else {
            lastWasAgent = false;
        }
    }
    return { groups, sitemaps };
}

function pathMatches(pattern: string, path: string): number {
    // returns match length (specificity) or -1
    const anchored = pattern.endsWith('$');
    const p = anchored ? pattern.slice(0, -1) : pattern;
    const re = new RegExp(
        `^${p
            .split('*')
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}${anchored ? '$' : ''}`,
    );
    return re.test(path) ? pattern.length : -1;
}

/** Groups applying to an agent: most specific product-token match, else '*'. */
function groupsFor(robots: Robots, agent: string): RobotsGroup[] {
    const a = agent.toLowerCase();
    const specific = robots.groups.filter((g) => g.agents.some((x) => x !== '*' && a.startsWith(x)));
    return specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
}

/**
 * Crawl-delay for an agent, in milliseconds. Uses the matching group and, when that group is
 * more specific than `*`, also the `*` group. 0 when none is set.
 */
export function crawlDelayMs(robots: Robots, agent: string): number {
    const matched = groupsFor(robots, agent);
    const star = robots.groups.filter((g) => g.agents.includes('*'));
    const pool = matched.some((g) => g.agents.includes('*')) ? matched : [...matched, ...star];
    let max = 0;
    for (const g of pool) if (g.crawlDelayMs != null && g.crawlDelayMs > max) max = g.crawlDelayMs;
    return max;
}

/** RFC 9309 longest-match evaluation; allow wins ties. */
export function isAllowed(robots: Robots, agent: string, path: string): boolean {
    const rules = groupsFor(robots, agent).flatMap((g) => g.rules);
    let best = -1;
    let allow = true;
    for (const r of rules) {
        const len = pathMatches(r.path, path);
        if (len > best || (len === best && r.allow)) {
            if (len >= 0) {
                best = len;
                allow = r.allow;
            }
        }
    }
    return allow;
}
