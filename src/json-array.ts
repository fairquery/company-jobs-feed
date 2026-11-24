/**
 * Walk a JSON array without retaining the response body.
 * Greenhouse and Ashby boards are `{"jobs":[...]}`. Lever is a root array.
 * Long string values (job descriptions) are cut so one posting cannot hold the isolate.
 * The scan is synchronous over each buffered slice. Deployed Workers do not advance
 * `performance.now()` during that stretch, so CPU is charged from characters consumed.
 */
import { wordMatch } from './normalize.js';
import { LOCATION_SCAN_CPU_BYTES_PER_MS } from './types.js';

export interface IterateJsonArrayOptions {
    /** Object key whose array value to walk. Omit to walk a root array. */
    arrayKey?: string;
    maxStringChars: number;
    maxElementChars: number;
    shouldStop?: () => boolean;
    /** Top-level keys left out of the element JSON. The value is skipped, not copied. */
    omitKeys?: ReadonlySet<string>;
    /** Top-level keys copied into `stash` (decoded, capped) instead of the element JSON. */
    keepKeys?: ReadonlySet<string>;
    /**
     * Case-insensitive terms. When `excerptKeys` is set, those values are skipped and a short
     * real excerpt is stored at stash key `excerpt` only if a term appears.
     */
    excerptTerms?: readonly string[];
    excerptKeys?: ReadonlySet<string>;
    stash?: Map<string, string>;
    /** Decode at most this many bytes between budget checks. */
    sliceBytes?: number;
    /**
     * Estimated synchronous work, in milliseconds. Charged from characters consumed
     * ({@link LOCATION_SCAN_CPU_BYTES_PER_MS}), not from `performance.now()`, which does not
     * advance during this walk on a deployed Worker. Network reads are not included.
     */
    cpu?: { ms: number };
    /** Decoded characters consumed. The caller resets this per board. */
    scanned?: { bytes: number };
}

export interface IterateJsonArrayResult {
    bytes: number;
    items: number;
    skipped: number;
    truncatedStrings: number;
    /** Largest unread input chunk or captured element. Stays far below the body size when the caller streams. */
    maxBufferChars: number;
    foundArray: boolean;
    complete: boolean;
    stopped: boolean;
    html: boolean;
}

const DEFAULT_SLICE = 8_192;

/** Decode one JSON string slice. A backslash that was itself escaped stays a backslash. */
function unescapeJsonSlice(chunk: string): string {
    return chunk
        .replace(/\\\\/g, '\u0000')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\//g, '/')
        .split('\u0000')
        .join('\\');
}

export async function iterateJsonArray(
    stream: ReadableStream<Uint8Array> | null,
    opts: IterateJsonArrayOptions,
    onItem: (json: string) => void | Promise<void>,
): Promise<IterateJsonArrayResult> {
    const result: IterateJsonArrayResult = {
        bytes: 0,
        items: 0,
        skipped: 0,
        truncatedStrings: 0,
        maxBufferChars: 0,
        foundArray: false,
        complete: true,
        stopped: false,
        html: false,
    };
    if (!stream) return result;
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const sliceBytes = opts.sliceBytes && opts.sliceBytes > 0 ? opts.sliceBytes : DEFAULT_SLICE;
    let buf = '';
    let pos = 0;
    let base = 0;
    let unread: string | null = null;
    let pending: Uint8Array | null = null;
    let pendingOff = 0;
    let charged = 0;
    const { cpu, scanned } = opts;
    const terms = (opts.excerptTerms ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 0);
    const overlap = Math.min(200, Math.max(64, ...terms.map((t) => t.length + 8), 64));

    const chargeWork = (): void => {
        if (!cpu) return;
        const at = base + pos;
        const delta = at - charged;
        if (delta <= 0) return;
        cpu.ms += delta / LOCATION_SCAN_CPU_BYTES_PER_MS;
        charged = at;
    };
    const note = (extra = 0): void => {
        const pendingChars = buf.length - pos + extra;
        if (pendingChars > result.maxBufferChars) result.maxBufferChars = pendingChars;
    };
    const syncScanned = (): void => {
        if (scanned) scanned.bytes = base + pos;
    };
    const halt = (): boolean => {
        syncScanned();
        chargeWork();
        if (opts.shouldStop?.()) {
            result.stopped = true;
            result.complete = false;
            return true;
        }
        return false;
    };

    const fill = async (): Promise<boolean> => {
        if (result.stopped) return false;
        if (pos > 0) {
            base += pos;
            buf = buf.slice(pos);
            pos = 0;
        }
        if (pending && pendingOff < pending.byteLength) {
            const end = Math.min(pending.byteLength, pendingOff + sliceBytes);
            buf += decoder.decode(pending.subarray(pendingOff, end), { stream: true });
            pendingOff = end;
            if (pendingOff >= pending.byteLength) pending = null;
            note();
            return true;
        }
        const { done, value } = await reader.read();
        if (done) {
            buf += decoder.decode();
            note();
            return false;
        }
        result.bytes += value.byteLength;
        pending = value;
        pendingOff = 0;
        const end = Math.min(value.byteLength, sliceBytes);
        buf += decoder.decode(value.subarray(0, end), { stream: true });
        pendingOff = end;
        if (pendingOff >= value.byteLength) pending = null;
        note();
        return true;
    };

    const hasChar = (): boolean => unread !== null || pos < buf.length;
    const takeSync = (): string => {
        if (unread !== null) {
            const c = unread;
            unread = null;
            return c;
        }
        return buf[pos++] ?? '';
    };
    const pushBack = (c: string): void => {
        unread = c;
    };

    const refill = async (): Promise<boolean> => {
        if (hasChar()) return true;
        // Every slice boundary, including a synchronous slice of an already-buffered read.
        // This is what trips the work budget while the Workers clock is frozen.
        if (halt()) return false;
        const more = await fill();
        return more || hasChar();
    };

    try {
        const found = await seekArray();
        if (result.html || !found) return result;
        result.foundArray = true;
        for (;;) {
            if (halt()) break;
            const c = await skipWs();
            if (c === null) {
                result.complete = false;
                break;
            }
            if (c === ']') break;
            if (c === ',') continue;
            if (halt()) break;
            if (c !== '{') {
                pushBack(c);
                const ok = await skipValue(false);
                if (!ok) break;
                result.skipped++;
                continue;
            }
            opts.stash?.clear();
            const item = await captureObject();
            if (item === null) {
                if (!result.complete || result.stopped) break;
                result.skipped++;
                continue;
            }
            if (item.length > result.maxBufferChars) result.maxBufferChars = item.length;
            await onItem(item);
            result.items++;
            if (halt()) break;
        }
        return result;
    } finally {
        await reader.cancel().catch(() => undefined);
    }

    async function seekArray(): Promise<boolean> {
        if (!opts.arrayKey) {
            const c = await skipWs();
            if (c === '<') {
                result.html = true;
                return false;
            }
            if (c === '[') return true;
            result.complete = false;
            return false;
        }
        const stack: ('{' | '[')[] = [];
        let inStr = false;
        let esc = false;
        let expect: 'key' | 'value' = 'value';
        let key = '';
        let capturingKey = false;
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (inStr) {
                    if (esc) {
                        esc = false;
                        if (capturingKey) key += c;
                        continue;
                    }
                    if (c === '\\') {
                        esc = true;
                        if (capturingKey) key += c;
                        continue;
                    }
                    if (c === '"') {
                        inStr = false;
                        capturingKey = false;
                        continue;
                    }
                    if (capturingKey) key += c;
                    continue;
                }
                if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\uFEFF') continue;
                if (c === '"') {
                    inStr = true;
                    if (expect === 'key') {
                        capturingKey = true;
                        key = '';
                    } else capturingKey = false;
                    continue;
                }
                if (c === '{') {
                    stack.push('{');
                    expect = 'key';
                    continue;
                }
                if (c === '[') {
                    if (expect === 'value' && key === opts.arrayKey && stack.length === 1 && stack[0] === '{')
                        return true;
                    stack.push('[');
                    expect = 'value';
                    continue;
                }
                if (c === '}' || c === ']') {
                    stack.pop();
                    expect = 'value';
                    continue;
                }
                if (c === ':') {
                    expect = 'value';
                    continue;
                }
                if (c === ',') {
                    expect = stack[stack.length - 1] === '{' ? 'key' : 'value';
                    continue;
                }
                if (c === '<') {
                    result.html = true;
                    return false;
                }
                pushBack(c);
                const ok = await skipPrimitiveRest();
                if (!ok && !result.complete) return false;
            }
            if (!(await refill())) {
                result.complete = false;
                return false;
            }
        }
    }

    async function skipWs(): Promise<string | null> {
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t' && c !== '\uFEFF') return c;
            }
            if (!(await refill())) return null;
        }
    }

    async function skipPrimitiveRest(): Promise<boolean> {
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\n' || c === '\r' || c === '\t') {
                    pushBack(c);
                    return true;
                }
            }
            if (!(await refill())) {
                result.complete = false;
                return false;
            }
        }
    }

    function watchRaw(chunk: string): void {
        if (!terms.length || !opts.stash) return;
        const prev = opts.stash.get('excerpt') ?? '';
        if (prev.length >= 2_000) return;
        // Search the decoded text. A raw `\u0026` would hide the words on either side of `&`.
        const decoded = unescapeJsonSlice(chunk);
        const hay = decoded.toLowerCase();
        let at = -1;
        for (const term of terms) {
            const found = hay.indexOf(term);
            if (found !== -1 && (at === -1 || found < at)) at = found;
        }
        // `avionics \u0026 propulsion` does not contain the substring "avionics propulsion", but
        // the decoded ampersand is the same word break keyword matching uses.
        if (at === -1 && terms.some((term) => wordMatch(decoded, term))) {
            const anchor = (terms.find((term) => wordMatch(decoded, term)) ?? '').split(/[^a-z0-9+#]+/i).find(Boolean) ?? '';
            const found = anchor ? hay.indexOf(anchor.toLowerCase()) : 0;
            at = found === -1 ? 0 : found;
        }
        if (at === -1) return;
        if (at < 0) at = 0;
        // `at` is an index into the decoded text. `\u0026` is six raw characters and one decoded.
        const loose = decoded.slice(Math.max(0, at - 180), Math.min(decoded.length, at + 220));
        const next = prev ? `${prev}\n${loose}` : loose;
        opts.stash.set('excerpt', next.slice(0, 2_000));
    }

    /** Opening quote is already consumed. Copies at most `maxStringChars` decoded characters. */
    async function readString(countTrunc: boolean): Promise<string | null> {
        let out = '';
        let dropping = false;
        let esc = false;
        // null means this is not a `\uXXXX` escape. After `\u` the buffer is "" until the
        // first hex digit arrives. "" is falsy, so a truthy check would copy `0026` into the title.
        let uni: string | null = null;
        let carry = '';
        for (;;) {
            const start = pos;
            while (hasChar()) {
                const c = takeSync();
                if (uni !== null) {
                    uni += c;
                    if (uni.length === 4) {
                        if (!dropping && /^[0-9a-fA-F]{4}$/.test(uni)) {
                            const code = Number.parseInt(uni, 16);
                            if (Number.isFinite(code)) out += String.fromCharCode(code);
                            if (out.length > opts.maxStringChars) {
                                dropping = true;
                                if (countTrunc) result.truncatedStrings++;
                                out = out.slice(0, opts.maxStringChars);
                            }
                        }
                        uni = null;
                    }
                    continue;
                }
                if (esc) {
                    esc = false;
                    if (c === 'u') {
                        uni = '';
                        continue;
                    }
                    if (!dropping) {
                        if (c === 'n') out += '\n';
                        else if (c === 't') out += '\t';
                        else if (c === 'r') out += '\r';
                        else if (c === 'b') out += '\b';
                        else if (c === 'f') out += '\f';
                        else out += c;
                        if (out.length > opts.maxStringChars) {
                            dropping = true;
                            if (countTrunc) result.truncatedStrings++;
                            out = out.slice(0, opts.maxStringChars);
                        }
                    }
                    continue;
                }
                if (c === '\\') {
                    esc = true;
                    continue;
                }
                if (c === '"') {
                    if (terms.length && pos > start) watchRaw(carry + buf.slice(start, pos - 1));
                    return out;
                }
                if (!dropping) {
                    out += c;
                    if (out.length > opts.maxStringChars) {
                        dropping = true;
                        if (countTrunc) result.truncatedStrings++;
                        out = out.slice(0, opts.maxStringChars);
                    }
                }
                if (dropping && pos % 8_192 === 0 && halt()) return null;
            }
            if (terms.length && pos > start) {
                const chunk = carry + buf.slice(start, pos);
                watchRaw(chunk);
                carry = chunk.slice(-overlap);
            }
            if (dropping && !esc && uni === null) {
                const end = buf.indexOf('"', pos);
                const bs = buf.indexOf('\\', pos);
                if (end !== -1 && (bs === -1 || end < bs)) {
                    if (terms.length) watchRaw(carry + buf.slice(pos, end));
                    pos = end + 1;
                    return out;
                }
                if (bs !== -1 && (end === -1 || bs < end)) {
                    if (terms.length) watchRaw(carry + buf.slice(pos, bs));
                    pos = bs + 1;
                    esc = true;
                    carry = '';
                    continue;
                }
                if (terms.length && pos < buf.length) watchRaw(carry + buf.slice(pos));
                carry = (carry + buf.slice(pos)).slice(-overlap);
                pos = buf.length;
            }
            if (!(await refill())) {
                result.complete = false;
                result.stopped = opts.shouldStop?.() === true;
                return null;
            }
        }
    }

    async function skipString(watch: boolean): Promise<boolean> {
        let esc = false;
        let uni = 0;
        let carry = '';
        for (;;) {
            const start = pos;
            while (hasChar()) {
                const c = takeSync();
                if (uni > 0) {
                    uni--;
                    continue;
                }
                if (esc) {
                    esc = false;
                    if (c === 'u') uni = 4;
                    continue;
                }
                if (c === '\\') {
                    esc = true;
                    continue;
                }
                if (c === '"') {
                    if (watch && pos > start) watchRaw(carry + buf.slice(start, pos - 1));
                    return true;
                }
                if (pos % 8_192 === 0 && halt()) return false;
            }
            if (watch && pos > start) {
                const chunk = carry + buf.slice(start, pos);
                watchRaw(chunk);
                carry = chunk.slice(-overlap);
            } else if (watch) {
                carry = carry.slice(-overlap);
            }
            if (!esc && uni === 0) {
                const end = buf.indexOf('"', pos);
                const bs = buf.indexOf('\\', pos);
                if (end !== -1 && (bs === -1 || end < bs)) {
                    if (watch) watchRaw(carry + buf.slice(pos, end));
                    pos = end + 1;
                    return true;
                }
                if (bs !== -1 && (end === -1 || bs < end)) {
                    if (watch) watchRaw(carry + buf.slice(pos, bs));
                    pos = bs + 1;
                    esc = true;
                    carry = '';
                    continue;
                }
                if (watch && buf.length > pos) {
                    const chunk = carry + buf.slice(pos);
                    watchRaw(chunk);
                    carry = chunk.slice(-overlap);
                }
                pos = buf.length;
            }
            if (!(await refill())) {
                result.complete = false;
                result.stopped = opts.shouldStop?.() === true;
                return false;
            }
        }
    }

    async function skipContainer(_open: '{' | '[', watch: boolean): Promise<boolean> {
        let depth = 1;
        let inStr = false;
        let esc = false;
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') {
                    inStr = true;
                    continue;
                }
                if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') {
                    depth--;
                    if (depth === 0) return true;
                }
                if (pos % 8_192 === 0 && halt()) return false;
            }
            if (watch && buf.length > 0) watchRaw(buf.slice(Math.max(0, pos - overlap), pos));
            if (!(await refill())) {
                result.complete = false;
                return false;
            }
        }
    }

    async function skipValue(watch: boolean): Promise<boolean> {
        const c = await skipWs();
        if (c === null) {
            result.complete = false;
            return false;
        }
        if (c === '"') return skipString(watch);
        if (c === '{' || c === '[') return skipContainer(c, watch);
        pushBack(c);
        return skipPrimitiveRest();
    }

    async function readRawValue(): Promise<string | null> {
        const c = await skipWs();
        if (c === null) {
            result.complete = false;
            return null;
        }
        if (c === '"') {
            const s = await readString(true);
            if (s === null) return null;
            return JSON.stringify(s);
        }
        if (c === '{' || c === '[') {
            const raw = await readContainer(c);
            return raw;
        }
        let raw = c;
        for (;;) {
            if (!hasChar()) {
                if (!(await refill())) return raw;
            }
            const n = unread ?? (pos < buf.length ? buf[pos] : null);
            if (n === null) return raw;
            if (n === ',' || n === '}' || n === ']' || n === ' ' || n === '\n' || n === '\r' || n === '\t') return raw;
            raw += takeSync();
            if (raw.length > opts.maxElementChars) {
                const ok = await skipPrimitiveRest();
                if (!ok) return null;
                result.truncatedStrings++;
                return 'null';
            }
        }
    }

    async function readContainer(open: '{' | '['): Promise<string | null> {
        let out = open;
        let depth = 1;
        let inStr = false;
        let esc = false;
        let strLen = 0;
        let dropping = false;
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (inStr) {
                    if (esc) {
                        esc = false;
                        if (!dropping) out += c;
                        continue;
                    }
                    if (c === '\\') {
                        esc = true;
                        if (!dropping) out += c;
                        continue;
                    }
                    if (c === '"') {
                        inStr = false;
                        dropping = false;
                        out += '"';
                        continue;
                    }
                    strLen++;
                    if (dropping) continue;
                    if (strLen > opts.maxStringChars) {
                        dropping = true;
                        result.truncatedStrings++;
                        continue;
                    }
                    out += c;
                    if (out.length > opts.maxElementChars) return null;
                    continue;
                }
                if (c === '"') {
                    inStr = true;
                    strLen = 0;
                    dropping = false;
                    out += '"';
                    continue;
                }
                if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') depth--;
                out += c;
                if (depth === 0) return out;
                if (out.length > opts.maxElementChars) return null;
                if (pos % 8_192 === 0 && halt()) return null;
            }
            if (!(await refill())) {
                result.complete = false;
                return null;
            }
        }
    }

    function special(k: string): 'omit' | 'keep' | 'excerpt' | null {
        if (opts.omitKeys?.has(k)) return 'omit';
        if (opts.keepKeys?.has(k)) return 'keep';
        if (opts.excerptKeys?.has(k) && terms.length) return 'excerpt';
        return null;
    }

    async function readKept(): Promise<string | null> {
        const c = await skipWs();
        if (c === null) {
            result.complete = false;
            return null;
        }
        if (c === '"') return readString(true);
        pushBack(c);
        return readRawValue();
    }

    /** `{` is already consumed. Returns element JSON, or null when the object is dropped or the stream ends. */
    async function captureObject(): Promise<string | null> {
        let out = '{';
        let first = true;
        for (;;) {
            const c = await skipWs();
            if (c === null) {
                result.complete = false;
                result.stopped = opts.shouldStop?.() === true || result.stopped;
                return null;
            }
            if (c === '}') {
                out += '}';
                if (out.length > opts.maxElementChars) return null;
                if (out.length > result.maxBufferChars) result.maxBufferChars = out.length;
                return out;
            }
            if (c === ',') continue;
            if (c !== '"') {
                result.complete = false;
                return null;
            }
            const key = await readString(false);
            if (key === null) return null;
            const colon = await skipWs();
            if (colon !== ':') {
                result.complete = false;
                return null;
            }
            const kind = special(key);
            if (kind === 'omit' || kind === 'excerpt') {
                const ok = await skipValue(kind === 'excerpt');
                if (!ok) return null;
                continue;
            }
            if (kind === 'keep') {
                const value = await readKept();
                if (value === null) return null;
                opts.stash?.set(key, value);
                continue;
            }
            const raw = await readRawValue();
            if (raw === null) return null;
            const piece = `${JSON.stringify(key)}:${raw}`;
            if (out.length + piece.length + 1 > opts.maxElementChars) {
                await skipRestOfObject();
                return null;
            }
            if (!first) out += ',';
            first = false;
            out += piece;
        }
    }

    /** The current value is finished and depth is back at the job object. Skip through its closing brace. */
    async function skipRestOfObject(): Promise<boolean> {
        let depth = 1;
        let inStr = false;
        let esc = false;
        for (;;) {
            while (hasChar()) {
                const c = takeSync();
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === '\\') esc = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') {
                    inStr = true;
                    continue;
                }
                if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') {
                    depth--;
                    if (depth === 0) return true;
                }
            }
            if (!(await refill())) {
                result.complete = false;
                return false;
            }
        }
    }
}
