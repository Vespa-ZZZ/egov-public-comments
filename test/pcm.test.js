import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Actor, log } from 'apify';
import {
    feedUrl, parseRss, parseDetail, slashDateToIso, kanjiDateToIso, extractMinistry, itemMatches, CATEGORIES,
} from '../src/pcm.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('a skipped dataset write stays pending and is retried when the RSS items disappear', async (t) => {
    const values = new Map();
    const saved = [];
    let limited = true;
    let attempts = 0;
    const warning = t.mock.method(log, 'warning', () => {});
    t.mock.method(log, 'info', () => {});
    t.mock.method(log, 'error', () => {});
    t.mock.method(Actor, 'init', async () => {});
    t.mock.method(Actor, 'exit', async () => {});
    t.mock.method(Actor, 'fail', async (message) => assert.fail(message));
    t.mock.method(Actor, 'getInput', async () => ({ onlyNew: true, fetchDetails: false }));
    t.mock.method(Actor, 'openKeyValueStore', async () => ({
        getValue: async (key) => structuredClone(values.get(key)),
        setValue: async (key, value) => values.set(key, structuredClone(value)),
    }));
    t.mock.method(Actor, 'setValue', async (key, value) => values.set(key, value));
    t.mock.method(Actor, 'pushData', async (record) => {
        attempts++;
        const skipped = limited && attempts === 2;
        if (!skipped) saved.push(record.eventId);
        return { eventChargeLimitReached: skipped, chargedCount: 0 };
    });
    t.mock.method(globalThis, 'fetch', async () => new Response(limited
        ? fx('pcm_list.xml')
        : '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Empty feed</title></channel></rdf:RDF>'));

    await import('../src/main.js?charge-limit');
    assert.equal(attempts, 2);
    assert.equal(values.get('RUN_SUMMARY').pushed, 1);
    assert.deepEqual(values.get('seen-default'), saved);
    const pending = values.get('pending-default').map((item) => item.key);
    assert.ok(pending.length > 1);
    assert.match(warning.mock.calls[0].arguments[0], /charge limit reached/i);

    limited = false;
    await import('../src/main.js?after-charge-limit');
    assert.equal(values.get('RUN_SUMMARY').pushed, pending.length);
    assert.deepEqual(saved.slice(1), pending);
    assert.deepEqual(values.get('pending-default'), []);
});

test('feedUrl builds all-items and category feed URLs', () => {
    assert.equal(feedUrl('open'), 'https://public-comment.e-gov.go.jp/rss/pcm_list.xml');
    assert.equal(feedUrl('results'), 'https://public-comment.e-gov.go.jp/rss/pcm_result.xml');
    assert.equal(feedUrl('open', 'IT社会化推進'), 'https://public-comment.e-gov.go.jp/rss/pcm_list_0000000001.xml');
    assert.equal(feedUrl('results', '電気通信'), 'https://public-comment.e-gov.go.jp/rss/pcm_result_0000000045.xml');
    assert.equal(CATEGORIES.length, 53);
    assert.throws(() => feedUrl('x'), /Unknown feed kind/);
    assert.throws(() => feedUrl('open', 'nope'), /Unknown category/);
});

test('date helpers convert to ISO (JST)', () => {
    assert.equal(slashDateToIso('2026/11/21'), '2026-11-21');
    assert.equal(slashDateToIso('2026/12/21 23:59'), '2026-12-21T23:59:00+09:00');
    assert.equal(slashDateToIso(''), null);
    assert.equal(kanjiDateToIso('2026年11月21日0時0分'), '2026-11-21T00:00:00+09:00');
    assert.equal(kanjiDateToIso('2026年8月25日'), '2026-08-25');
    assert.equal(kanjiDateToIso(null), null);
});

test('extractMinistry keeps only the organisation name', () => {
    assert.equal(extractMinistry('総務省総合通信基盤局電波部\n(TEL: 03-5253-5901)'), '総務省');
    assert.equal(extractMinistry('【周波数割当計画の変更案以外について】\n総務省総合通信基盤局'), '総務省');
    assert.equal(extractMinistry('経済産業省　資源エネルギー庁　電力・ガス事業部'), '経済産業省');
    assert.equal(extractMinistry('金融庁企画市場局'), '金融庁');
    assert.equal(extractMinistry('内閣府政策統括官'), '内閣府');
    assert.equal(extractMinistry(''), null);
});

test('parseRss reads open calls without contact details', () => {
    const items = parseRss(fx('pcm_list.xml'), 'open');
    assert.ok(items.length > 5);
    const it = items.find((x) => x.caseId === '145210800');
    assert.ok(it);
    assert.equal(it.kind, 'open');
    assert.equal(it.category, '電気通信');
    assert.equal(it.ministry, '総務省');
    assert.equal(it.proposalDate, '2026-11-21');
    assert.equal(it.deadline, '2026-12-21T23:59:00+09:00');
    assert.equal(it.resultDate, null);
    assert.equal(it.commentCount, null);
    for (const x of items) assert.doesNotMatch(JSON.stringify(x), /TEL|電話|03-\d{4}/);
});

test('parseRss reads results with comment counts', () => {
    const items = parseRss(fx('pcm_result.xml'), 'results');
    const it = items.find((x) => x.caseId === '145210763');
    assert.ok(it);
    assert.equal(it.resultDate, '2026-11-20');
    assert.equal(it.commentCount, 22);
    assert.equal(it.promulgationDate, null);
});

test('parseRss rejects malformed XML', () => {
    const xml = fx('pcm_list.xml');
    assert.throws(() => parseRss(xml.slice(0, 2000), 'open'), /Malformed RSS/);
    assert.throws(() => parseRss('<foo/>', 'open'), /Not an RSS/);
});

test('parseDetail extracts fields and attachments from an open call page', () => {
    const d = parseDetail(fx('detail_open.html'));
    assert.equal(d.caseNumber, '145210800');
    assert.equal(d.procedureType, '行政手続法に基づく手続');
    assert.equal(d.receptionStart, '2026-11-21T00:00:00+09:00');
    assert.ok(d.attachments.length >= 4);
    const a = d.attachments.find((x) => x.title === '意見公募要領');
    assert.ok(a);
    assert.match(a.url, /^https:\/\/public-comment\.e-gov\.go\.jp\/pcm\/download\?seqNo=\d+$/);
    assert.equal(a.fileType, 'PDF');
    assert.doesNotMatch(JSON.stringify(d), /TEL|電話/);
});

test('parseDetail extracts result pages', () => {
    const d = parseDetail(fx('detail_result.html'));
    assert.equal(d.caseNumber, '145210763');
    assert.equal(d.procedureType, '任意の意見募集');
    assert.equal(d.revisedAfterComments, null);
    assert.ok(d.attachments.some((x) => x.title?.includes('提出された意見')));
    assert.doesNotMatch(JSON.stringify(d), /電話/);
});

test('parseDetail fails clearly on an unexpected page', () => {
    assert.throws(() => parseDetail('<html><body>maintenance</body></html>'), /Unexpected detail page layout/);
});

test('itemMatches filters by keyword and ministry', () => {
    const it = { title: '個人情報の保護に関する法律施行規則の改正案', ministry: '個人情報保護委員会', category: '行政手続' };
    assert.equal(itemMatches(it, {}), true);
    assert.equal(itemMatches(it, { keywords: ['AI', '個人情報'] }), true);
    assert.equal(itemMatches(it, { keywords: ['AI'] }), false);
    assert.equal(itemMatches(it, { ministries: ['総務省'] }), false);
    assert.equal(itemMatches(it, { ministries: ['個人情報保護委員会'] }), true);
});

test('extractMinistry only returns known organisations, never names or numbers in front', async () => {
    const { extractMinistry: em } = await import('../src/pcm.js');
    assert.equal(em('担当：山田太郎 03-1234-5678 総務省情報流通行政局'), '総務省');
    assert.equal(em('個人情報保護委員会事務局'), '個人情報保護委員会');
    assert.equal(em('資源エネルギー庁 電力・ガス事業部（経済産業省）'), '資源エネルギー庁');
    assert.equal(em('山田商事株式会社 担当 佐藤'), null);
});

test('redactContacts removes phone numbers and e-mail addresses', async () => {
    const { redactContacts } = await import('../src/pcm.js');
    assert.equal(redactContacts('電話：03-5253-5901'), '[redacted]');
    assert.equal(redactContacts('(TEL: 03-5253-5901) 担当課'), '([redacted]) 担当課');
    assert.equal(redactContacts('連絡は pc@example.go.jp まで'), '連絡は [redacted] まで');
    assert.equal(redactContacts('０３－３５０１－１９９２'), '[redacted]');
    assert.equal(redactContacts('2026年12月21日'), '2026年12月21日');
});

test('parseDetail skips contact rows, tel/mailto links and redacts free text', () => {
    const html = `<table class="egovui-normal-horizontal"><tbody>
      <tr><th>案件番号</th><td>060240401</td></tr>
      <tr><th>命令などの案</th><td><a href="/pcm/download?seqNo=1">・案</a><span class="egovui-badge">PDF</span>
        <a href="tel:0312345678">電話</a><a href="mailto:a@example.jp">メール</a></td></tr>
      <tr><th>お問い合わせ先</th><td><a href="https://example.jp/staff">山田</a> 03-1111-2222</td></tr>
      <tr><th>備考</th><td>担当 山田 TEL 03-1111-2222 <a href="https://example.jp/x">x</a></td></tr>
    </tbody></table>`;
    const d = parseDetail(html);
    assert.equal(d.caseNumber, '060240401');
    assert.deepEqual(d.attachments.map((a) => a.url), ['https://public-comment.e-gov.go.jp/pcm/download?seqNo=1']);
    assert.doesNotMatch(JSON.stringify(d), /03-1111-2222|tel:|mailto|staff/);
});

test('round-2 privacy: titles, international numbers and non-document links', async () => {
    const { redactContacts: rc } = await import('../src/pcm.js');
    assert.equal(rc('+81-3-1234-5678'), '[redacted]');
    assert.equal(rc('＋81 3 1234 5678'), '[redacted]');
    assert.equal(rc('＋８１ ３ １２３４ ５６７８'), '[redacted]');
    const rss = `<?xml version="1.0"?><rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="x"><title>t</title></channel>
      <item rdf:about="https://public-comment.e-gov.go.jp/servlet/Public?CLASSNAME=PCMMSTDETAIL&amp;id=1&amp;Mode=0">
        <title>意見募集（問合せ a@example.go.jp）</title><link>https://public-comment.e-gov.go.jp/servlet/Public?CLASSNAME=PCMMSTDETAIL&amp;id=1&amp;Mode=0</link>
        <description>案の公示日：2026/11/21&lt;br/&gt;</description></item></rdf:RDF>`;
    assert.doesNotMatch(parseRss(rss, 'open')[0].title, /@/);
    const html = `<table class="egovui-normal-horizontal"><tbody>
      <tr><th>案件番号</th><td>1</td></tr>
      <tr><th>関連資料、その他</th><td><a href="https://example.jp/staff-page">担当</a><a href="https://example.jp/doc.pdf">資料</a></td></tr>
      <tr><th>資料の入手方法</th><td><a href="https://example.jp/a.pdf">窓口</a></td></tr>
    </tbody></table>`;
    assert.deepEqual(parseDetail(html).attachments.map((a) => a.url), ['https://example.jp/doc.pdf']);
});

test('parseDetail requires a case number', () => {
    assert.throws(() => parseDetail('<table class="egovui-normal-horizontal"><tr><th>カテゴリー</th><td>x</td></tr></table>'), /no case number/);
});
