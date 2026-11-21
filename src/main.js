import { Actor, log } from 'apify';
import {
    CATEGORIES, SOURCE, feedUrl, parseRss, parseDetail, itemMatches, sanitize, redactContacts,
} from './pcm.js';

const USER_AGENT = 'egov-public-comments-actor/1.0';
const MAX_SEEN_IDS = 20000;
const MAX_PENDING = 10000;
const MAX_FAILURES = 5;

class InputError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean);

async function fetchText(url, { retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
            if (res.ok) return await res.text();
            lastErr = new Error(`HTTP ${res.status} for ${url}`);
            if (res.status === 429) {
                const ra = Number(res.headers.get('retry-after'));
                if (Number.isFinite(ra) && ra > 0 && attempt < retries) await sleep(Math.min(ra, 120) * 1000);
            }
            if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        } catch (err) {
            lastErr = err;
        }
        if (attempt < retries) {
            const wait = 3000 * 2 ** attempt;
            log.warning(`Request failed (${lastErr.message}), retrying in ${wait / 1000}s`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const kinds = [...new Set(list(input.feeds))];
    if (!kinds.length) kinds.push('open');
    const categories = [...new Set(list(input.categories))];
    const keywords = list(input.keywords);
    const ministries = list(input.ministries);
    const fetchDetails = input.fetchDetails ?? true;
    const onlyNew = input.onlyNew ?? false;
    const stateKey = input.stateKey || 'default';
    const maxItems = Math.max(1, Math.min(Number(input.maxItems ?? 200), 5000));
    const intervalMs = Math.max(1000, Number(input.requestIntervalMs ?? 2000));
    const maxDetailRequests = Math.max(1, Math.min(Number(input.maxDetailRequests ?? 300), 5000));

    const badKinds = kinds.filter((k) => !['open', 'results'].includes(k));
    if (badKinds.length) throw new InputError(`Unknown feed(s): ${badKinds.join(', ')}. Allowed: open, results`);
    const badCats = categories.filter((c) => !CATEGORIES.includes(c));
    if (badCats.length) throw new InputError(`Unknown categor(ies): ${badCats.join(', ')}`);
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
        throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50 characters).');
    }
    const runStartedAt = new Date().toISOString();

    // Monitoring state (do not run two schedules with the same stateKey at the same time):
    //   seen    - keys already output
    //   pending - matched items not yet output, with failCount and the time they were first fetched
    //   dropped - keys given up after MAX_FAILURES failed runs (not re-added from the RSS)
    const store = onlyNew ? await Actor.openKeyValueStore('egov-public-comments-state') : null;
    const seen = new Set(onlyNew ? ((await store.getValue(`seen-${stateKey}`)) ?? []) : []);
    const dropped = new Set(onlyNew ? ((await store.getValue(`dropped-${stateKey}`)) ?? []) : []);
    const pendingIn = onlyNew ? ((await store.getValue(`pending-${stateKey}`)) ?? []) : [];
    if (onlyNew) log.info(`Monitoring mode: ${seen.size} seen, ${pendingIn.length} pending items (state key "${stateKey}").`);

    // 1) Read feeds. Category feeds are used when categories are given (they hold more items per category).
    const urls = [];
    for (const kind of kinds) {
        if (categories.length) for (const c of categories) urls.push({ kind, url: feedUrl(kind, c) });
        else urls.push({ kind, url: feedUrl(kind) });
    }
    const byKey = new Map();
    // Pending items first (keeps failCount / retrievedAt). Saved rows are re-validated and re-redacted,
    // so rows written by an older version cannot bypass the current checks.
    for (const it of pendingIn) {
        if (!it?.key || !it.caseId || !/^\d+$/.test(String(it.caseId))) continue;
        byKey.set(it.key, { ...it, title: redactContacts(it.title) });
    }
    for (const [i, { kind, url }] of urls.entries()) {
        if (i > 0) await sleep(intervalMs);
        const items = parseRss(await fetchText(url), kind);
        log.info(`${url}: ${items.length} items`);
        for (const it of items) {
            if (!it.caseId) {
                log.warning(`Skipping RSS item without a case id: ${it.url}`);
                continue;
            }
            const key = `${it.kind}:${it.caseId}`;
            const prev = byKey.get(key);
            byKey.set(key, { key, ...it, failCount: prev?.failCount ?? 0, retrievedAt: prev?.retrievedAt ?? runStartedAt });
        }
    }

    // Filters are applied after merging pending items, so pending items from an older configuration
    // of the same stateKey cannot slip through.
    const matches = (it) => kinds.includes(it.kind)
        && (!categories.length || categories.includes(it.category))
        && itemMatches(it, { keywords, ministries });
    const byDate = (a, b) => String(b.resultDate ?? b.proposalDate).localeCompare(String(a.resultDate ?? a.proposalDate));
    const eligible = [...byKey.values()].filter((it) => !seen.has(it.key) && !dropped.has(it.key) && matches(it));
    // Fresh items and previously failed items take turns, so neither group can starve the other.
    const fresh = eligible.filter((it) => !(it.failCount > 0)).sort(byDate);
    const retry = eligible.filter((it) => it.failCount > 0).sort((a, b) => a.failCount - b.failCount || byDate(a, b));
    const candidates = [];
    while (fresh.length || retry.length) {
        if (retry.length && (candidates.length % 2 === 1 || !fresh.length)) candidates.push(retry.shift());
        else candidates.push(fresh.shift());
    }
    log.info(`${candidates.length} items match the filters${onlyNew ? ' (new or pending)' : ''}.`);

    // All candidates are persisted as pending before any output, then removed one by one after output,
    // so an interrupted run never loses items.
    const pending = new Map(candidates.map((it) => [it.key, it]));
    const saveState = async () => {
        // dropped is written first, so an interruption cannot re-register a dropped item.
        await store.setValue(`dropped-${stateKey}`, [...dropped].slice(-MAX_SEEN_IDS));
        await store.setValue(`seen-${stateKey}`, [...seen].slice(-MAX_SEEN_IDS));
        const list = [...pending.values()];
        if (list.length > MAX_PENDING) log.warning(`${list.length - MAX_PENDING} pending items over the limit (${MAX_PENDING}) were not saved.`);
        await store.setValue(`pending-${stateKey}`, list.slice(0, MAX_PENDING));
    };
    if (onlyNew) await saveState();

    // 2) Optional detail pages.
    let pushed = 0;
    let failed = 0;
    let detailRequests = 0;
    for (const item of candidates) {
        if (pushed >= maxItems) break;
        const { key, failCount, retrievedAt, ...record } = item;
        if (fetchDetails) {
            if (detailRequests >= maxDetailRequests) {
                log.warning(`Reached maxDetailRequests (${maxDetailRequests} pages); remaining items are left for a later run.`);
                break;
            }
            await sleep(intervalMs);
            detailRequests++;
            try {
                const detail = parseDetail(await fetchText(item.url));
                if (detail.caseNumber !== item.caseId) {
                    throw new Error(`detail page case number ${detail.caseNumber ?? '(none)'} does not match ${item.caseId}`);
                }
                Object.assign(record, detail);
            } catch (err) {
                failed++;
                log.warning(`Could not read detail page ${item.url}: ${sanitize(err.message)}`);
                if (onlyNew) {
                    item.failCount = (failCount ?? 0) + 1;
                    if (item.failCount >= MAX_FAILURES) {
                        log.warning(`Giving up on ${item.url} after ${MAX_FAILURES} failed runs.`);
                        pending.delete(key);
                        dropped.add(key);
                    }
                    await saveState();
                    continue; // retried by a later run instead of output without details
                }
                record.detailError = sanitize(err.message);
            }
        }
        // eventId is stable, so downstream consumers can de-duplicate if a run stops between output and state save.
        await Actor.pushData({ eventId: key, ...record, retrievedAt: retrievedAt ?? runStartedAt, source: SOURCE });
        pushed++;
        pending.delete(key);
        if (onlyNew) {
            seen.add(key);
            await saveState();
        }
    }
    const unhandled = [...pending.values()].filter((it) => !seen.has(it.key));

    if (pushed === 0 && onlyNew) log.info(`No new items output (${unhandled.length} pending for the next run).`);
    else if (pushed === 0) log.warning('No items matched. Try other feeds, categories or wider filters.');
    log.info(`Done. Pushed ${pushed} items${failed ? `, ${failed} detail page(s) failed` : ''}.`);
    await Actor.setValue('RUN_SUMMARY', { processed: candidates.length, pushed, failedDetails: failed, detailRequests, unhandled: unhandled.length });
    if (failed > 0 && failed === detailRequests) {
        throw new Error(`All ${failed} detail page request(s) failed; e-Gov may be temporarily unavailable.`);
    }
    await Actor.exit();
} catch (err) {
    // Log only a sanitized message: stack traces and some messages contain local file paths.
    const msg = sanitize(err.message);
    log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
    await Actor.fail(msg);
}
