import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import zlib from 'node:zlib';

import { isAllowed, parseRobots, type Robots } from './robots.js';
import { isPrivateAddress, unsafeUrlReason } from './ssrf.js';
import {
    ATS_API_HOSTS,
    HOST_CONCURRENCY,
    HOST_MIN_INTERVAL_MS,
    MAX_HTML_BYTES,
    MAX_JSON_BYTES,
    REQUEST_TIMEOUT_MS,
    ROBOTS_AGENT,
    USER_AGENT,
} from './types.js';

export class HttpError extends Error {
    constructor(
        message: string,
        public code: string,
        public retryable: boolean,
        public status?: number,
        public host?: string,
    ) {
        super(message);
    }
}

const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });

/**
 * Per-host politeness + kill switch. At most HOST_CONCURRENCY requests in flight per host and an optional
 * minimum interval between request starts. Any 403/429 (or a non-JSON block page from an API host) "kills"
 * the host for the rest of the run: every later request to it fails fast with HOST_BLOCKED. Never retried
 * through another IP or proxy.
 */
export class HostGate {
    private active = new Map<string, number>();
    private waiters = new Map<string, (() => void)[]>();
    private lastStart = new Map<string, number>();
    readonly killed = new Map<string, { status: number | null; reason: string; at: string }>();
    requests = new Map<string, number>();

    constructor(private readonly concurrency = HOST_CONCURRENCY) {}

    isKilled(host: string): boolean {
        return this.killed.has(host);
    }

    kill(host: string, status: number | null, reason: string): void {
        if (!this.killed.has(host)) this.killed.set(host, { status, reason, at: new Date().toISOString() });
        // release everyone waiting so they can fail fast
        for (const w of this.waiters.get(host) ?? []) w();
        this.waiters.set(host, []);
    }

    async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
        this.assertAlive(host);
        while ((this.active.get(host) ?? 0) >= this.concurrency) {
            await new Promise<void>((r) => {
                const list = this.waiters.get(host) ?? [];
                list.push(r);
                this.waiters.set(host, list);
            });
            this.assertAlive(host);
        }
        this.active.set(host, (this.active.get(host) ?? 0) + 1);
        try {
            const gap = HOST_MIN_INTERVAL_MS[host] ?? 0;
            if (gap) {
                const wait = (this.lastStart.get(host) ?? 0) + gap - Date.now();
                this.lastStart.set(host, Math.max(Date.now(), (this.lastStart.get(host) ?? 0) + gap));
                if (wait > 0) await sleep(wait);
            }
            this.assertAlive(host);
            this.requests.set(host, (this.requests.get(host) ?? 0) + 1);
            return await fn();
        } finally {
            this.active.set(host, (this.active.get(host) ?? 1) - 1);
            const next = this.waiters.get(host)?.shift();
            if (next) next();
        }
    }

    totalRequests(): number {
        let n = 0;
        for (const v of this.requests.values()) n += v;
        return n;
    }

    private assertAlive(host: string): void {
        const k = this.killed.get(host);
        if (k)
            throw new HttpError(
                `Host ${host} stopped for this run after ${k.status ?? 'a block'} (${k.reason}). Not retried.`,
                'HOST_BLOCKED',
                true,
                k.status ?? undefined,
                host,
            );
    }
}

export interface JsonResult<T> {
    status: number;
    json: T | null;
    bytes: number;
    url: string;
}

const API_HOSTS = new Set(Object.values(ATS_API_HOSTS));

/** Client for the four documented ATS API hosts only. Any other host is refused (no SSRF). */
export class AtsClient {
    constructor(
        readonly gate: HostGate,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    ) {}

    async getJson<T>(url: string, attempt = 0): Promise<JsonResult<T>> {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !API_HOSTS.has(u.hostname) || u.port) {
            throw new HttpError(`Refusing non-ATS URL ${u.origin}`, 'URL_NOT_ALLOWED', false);
        }
        const host = u.hostname;
        let res: Response;
        let body: string;
        try {
            ({ res, body } = await this.gate.run(host, async () => {
                const r = await this.fetchImpl(url, {
                    redirect: 'manual',
                    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
                return { res: r, body: await readCapped(r, MAX_JSON_BYTES) };
            }));
        } catch (e) {
            if (e instanceof HttpError) throw e;
            if (attempt < 2) {
                await sleep(500 * 2 ** attempt);
                return this.getJson<T>(url, attempt + 1);
            }
            throw new HttpError(`GET ${url} failed: ${errText(e)}`, 'NETWORK_ERROR', true, undefined, host);
        }
        if (res.status === 403 || res.status === 429) {
            this.gate.kill(host, res.status, `HTTP ${res.status}`);
            throw new HttpError(
                `${host} answered HTTP ${res.status}; scanning of this host stopped for the run (kill switch).`,
                'HOST_BLOCKED',
                true,
                res.status,
                host,
            );
        }
        if (res.status === 404 || res.status === 410)
            return { status: res.status, json: null, bytes: body.length, url };
        if (res.status >= 500) {
            if (attempt < 2) {
                await sleep(800 * 2 ** attempt);
                return this.getJson<T>(url, attempt + 1);
            }
            throw new HttpError(`GET ${url} -> HTTP ${res.status}`, 'ATS_HTTP_ERROR', true, res.status, host);
        }
        if (res.status >= 300) {
            throw new HttpError(
                `GET ${url} -> HTTP ${res.status} (redirects not followed)`,
                'ATS_HTTP_ERROR',
                false,
                res.status,
                host,
            );
        }
        try {
            return { status: res.status, json: JSON.parse(body) as T, bytes: body.length, url };
        } catch {
            if (/^\s*</.test(body)) {
                // An HTML page where JSON was expected is treated as a block/challenge page.
                this.gate.kill(host, res.status, 'HTML block page instead of JSON');
                throw new HttpError(
                    `${host} returned HTML instead of JSON; host stopped (kill switch).`,
                    'HOST_BLOCKED',
                    true,
                    res.status,
                    host,
                );
            }
            throw new HttpError(`GET ${url}: invalid JSON`, 'ATS_BAD_RESPONSE', true, res.status, host);
        }
    }
}

export async function readCapped(res: Response, max: number): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= max) {
            await reader.cancel();
            throw new HttpError(`Response larger than ${max} bytes`, 'RESPONSE_TOO_LARGE', false);
        }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function errText(e: unknown): string {
    if (!(e instanceof Error)) return String(e);
    const code = (e as { cause?: { code?: string } }).cause?.code;
    return code ? `${e.message} (${code})` : e.message;
}

// ---------------------------------------------------------------------------------------------
// Careers-page fetcher (discovery only): user-supplied domains, SSRF-guarded, robots.txt-respecting.
// ---------------------------------------------------------------------------------------------

export interface PageResult {
    url: string;
    status: number;
    body: string;
    contentType: string | null;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

export class CareersFetcher {
    private robots = new Map<string, Promise<Robots | HttpError>>();
    pagesFetched = 0;

    constructor(
        readonly gate: HostGate,
        private readonly resolver: Resolver = defaultResolver,
        private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    ) {}

    /** Validates, resolves and pins a public IP for the host (prevents DNS rebinding to private ranges). */
    async resolvePublic(u: URL): Promise<{ address: string; family: number }> {
        const reason = unsafeUrlReason(u);
        if (reason) throw new HttpError(`${u.hostname}: ${reason}`, 'URL_NOT_ALLOWED', false);
        let addrs: { address: string; family: number }[];
        try {
            addrs = await this.resolver(u.hostname);
        } catch (e) {
            throw new HttpError(`DNS lookup failed for ${u.hostname}: ${errText(e)}`, 'DNS_FAILED', false);
        }
        if (!addrs.length) throw new HttpError(`No address for ${u.hostname}`, 'DNS_FAILED', false);
        if (addrs.some((a) => isPrivateAddress(a.address))) {
            throw new HttpError(`${u.hostname} resolves to a private or reserved address`, 'URL_NOT_ALLOWED', false);
        }
        return addrs[0];
    }

    async robotsAllows(u: URL): Promise<boolean> {
        const key = u.origin;
        if (!this.robots.has(key)) this.robots.set(key, this.loadRobots(u));
        const r = await this.robots.get(key)!;
        if (r instanceof HttpError) throw r;
        return isAllowed(r, ROBOTS_AGENT, u.pathname + u.search);
    }

    /** RFC 9309: 2xx = rules; 4xx = no rules (allowed); 5xx or unreachable = treat as fully disallowed. */
    private async loadRobots(u: URL): Promise<Robots | HttpError> {
        const url = new URL('/robots.txt', u.origin);
        try {
            const res = await this.rawGet(url, 'text/plain,*/*;q=0.5', 500_000, 0);
            if (res.status >= 200 && res.status < 300) return parseRobots(res.body);
            if (res.status >= 400 && res.status < 500) return parseRobots('');
            return new HttpError(
                `robots.txt on ${u.hostname} answered HTTP ${res.status}; not crawling (RFC 9309)`,
                'ROBOTS_UNAVAILABLE',
                true,
                res.status,
                u.hostname,
            );
        } catch (e) {
            if (e instanceof HttpError && ['HOST_BLOCKED', 'URL_NOT_ALLOWED', 'DNS_FAILED'].includes(e.code)) return e;
            return new HttpError(
                `robots.txt on ${u.hostname} unreachable (${errText(e)}); not crawling`,
                'ROBOTS_UNAVAILABLE',
                true,
                undefined,
                u.hostname,
            );
        }
    }

    /** Fetch one careers page: guarded, robots-checked, redirects re-validated hop by hop. */
    async getPage(url: string, maxHops = 3): Promise<PageResult> {
        let u = new URL(url);
        for (let hop = 0; hop <= maxHops; hop++) {
            if (!(await this.robotsAllows(u))) {
                throw new HttpError(`robots.txt on ${u.hostname} disallows ${u.pathname}`, 'ROBOTS_DISALLOWED', false);
            }
            this.pagesFetched += 1;
            const res = await this.rawGet(u, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', MAX_HTML_BYTES, 0);
            if (res.status >= 300 && res.status < 400 && res.location) {
                u = new URL(res.location, u);
                continue;
            }
            return { url: u.toString(), status: res.status, body: res.body, contentType: res.contentType };
        }
        throw new HttpError(`Too many redirects from ${url}`, 'TOO_MANY_REDIRECTS', false);
    }

    private async rawGet(
        u: URL,
        accept: string,
        maxBytes: number,
        _reserved = 0,
    ): Promise<{ status: number; body: string; contentType: string | null; location: string | null }> {
        const pinned = await this.resolvePublic(u);
        const host = u.hostname;
        const lookup: LookupFunction = (_h, opts, cb) => {
            if ((opts as { all?: boolean }).all) {
                (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
            } else cb(null, pinned.address, pinned.family);
        };
        const out = await this.gate
            .run(
                host,
                async () =>
                    new Promise<{ status: number; body: string; contentType: string | null; location: string | null }>(
                        (resolve, reject) => {
                            const mod = u.protocol === 'https:' ? https : http;
                            const req = mod.request(
                                u,
                                {
                                    method: 'GET',
                                    lookup,
                                    headers: {
                                        'user-agent': USER_AGENT,
                                        accept,
                                        'accept-encoding': 'gzip, deflate, br',
                                        'accept-language': 'en;q=0.9,*;q=0.5',
                                    },
                                    timeout: this.timeoutMs,
                                },
                                (res) => {
                                    const status = res.statusCode ?? 0;
                                    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
                                    let stream: NodeJS.ReadableStream = res;
                                    if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
                                    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                                    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                                    const chunks: Buffer[] = [];
                                    let total = 0;
                                    stream.on('data', (c: Buffer) => {
                                        total += c.length;
                                        if (total > maxBytes) {
                                            req.destroy();
                                            resolve({
                                                status,
                                                body: Buffer.concat(chunks).toString('utf8'),
                                                contentType: String(res.headers['content-type'] ?? '') || null,
                                                location: null,
                                            });
                                            return;
                                        }
                                        chunks.push(c);
                                    });
                                    stream.on('end', () =>
                                        resolve({
                                            status,
                                            body: Buffer.concat(chunks).toString('utf8'),
                                            contentType: String(res.headers['content-type'] ?? '') || null,
                                            location:
                                                typeof res.headers.location === 'string' ? res.headers.location : null,
                                        }),
                                    );
                                    stream.on('error', reject);
                                },
                            );
                            req.on('timeout', () => req.destroy(new Error('timeout')));
                            req.on('error', reject);
                            req.end();
                        },
                    ),
            )
            .catch((e: unknown) => {
                if (e instanceof HttpError) throw e;
                throw new HttpError(
                    `GET ${u.toString()} failed: ${errText(e)}`,
                    'NETWORK_ERROR',
                    true,
                    undefined,
                    host,
                );
            });
        if (out.status === 403 || out.status === 429) {
            this.gate.kill(host, out.status, `HTTP ${out.status}`);
            throw new HttpError(
                `${host} answered HTTP ${out.status}; host stopped for this run.`,
                'HOST_BLOCKED',
                true,
                out.status,
                host,
            );
        }
        return out;
    }
}
