import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Actor, log } from 'apify';
import {
    feedUrl, parseRss, parseDetail, slashDateToIso, kanjiDateToIso, extractMinistry, itemMatches, CATEGORIES,
} from '../src/pcm.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const pdfAttachment = (section, title, seqNo) => ({
    section,
    title,
    url: `https://public-comment.e-gov.go.jp/pcm/download?seqNo=${seqNo}`,
    fileType: 'PDF',
});

test('a skipped dataset write stays pending and is retried when the RSS items disappear', async (t) => {
    const values = new Map();
    const saved = [];
    let limited = true;
    let attempts = 0;
    t.mock.method(Actor, 'getChargingManager', () => undefined);
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

const retryCases = [
    { name: 'seconds', header: '15', wait: 15000 },
    { name: 'exactly 120 seconds', header: '120', wait: 120000 },
    { name: 'HTTP-date', header: 'Sat, 28 Nov 2026 00:00:20 GMT', wait: 20000 },
    { name: 'RFC 850 date', header: 'Saturday, 28-Nov-26 00:00:20 GMT', wait: 20000 },
    { name: 'asctime date', header: 'Sat Nov 28 00:00:20 2026', wait: 20000 },
    { name: 'past HTTP-date', header: 'Fri, 27 Nov 2026 23:59:00 GMT', wait: 3000 },
    { name: 'invalid date', header: '2026-11-29', wait: 3000 },
    { name: 'invalid seconds', header: '-1', wait: 3000 },
    { name: 'seconds over the limit', header: '121' },
    { name: 'HTTP-date over the limit', header: 'Sat, 28 Nov 2026 00:02:01 GMT' },
];

for (const { name, header, wait } of retryCases) {
    test(`fetch retry handles Retry-After with ${name}`, async (t) => {
        t.mock.method(Date, 'now', () => Date.parse('2026-11-28T00:00:00Z'));
        const timer = t.mock.method(globalThis, 'setTimeout', (resolve) => resolve());
        const warning = t.mock.method(log, 'warning', () => {});
        const error = t.mock.method(log, 'error', () => {});
        t.mock.method(log, 'info', () => {});
        t.mock.method(Actor, 'init', async () => {});
        t.mock.method(Actor, 'getInput', async () => ({ fetchDetails: false }));
        t.mock.method(Actor, 'getChargingManager', () => undefined);
        t.mock.method(Actor, 'pushData', async () => {});
        t.mock.method(Actor, 'setValue', async () => {});
        const exit = t.mock.method(Actor, 'exit', async () => {});
        const fail = t.mock.method(Actor, 'fail', async () => {});
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            attempts++;
            if (attempts === 1) return new Response(null, { status: 429, headers: { 'Retry-After': header } });
            return new Response(fx('pcm_list.xml'));
        });

        await import(`../src/main.js?retry-after=${encodeURIComponent(name)}`);
        if (wait === undefined) {
            assert.equal(attempts, 1);
            assert.equal(timer.mock.callCount(), 0);
            assert.equal(warning.mock.callCount(), 0);
            assert.equal(exit.mock.callCount(), 0);
            assert.equal(fail.mock.callCount(), 1);
            assert.match(fail.mock.calls[0].arguments[0], /HTTP 429.*Retry-After exceeds 120 seconds/);
            assert.equal(error.mock.calls[0].arguments[0], fail.mock.calls[0].arguments[0]);
        } else {
            assert.equal(attempts, 2);
            assert.deepEqual(timer.mock.calls.map(({ arguments: [, delay] }) => delay), [wait]);
            assert.equal(warning.mock.callCount(), 1);
            assert.ok(warning.mock.calls[0].arguments[0].endsWith(`retrying in ${wait / 1000}s`));
            assert.equal(exit.mock.callCount(), 1);
            assert.equal(fail.mock.callCount(), 0);
        }
    });
}

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
    assert.deepEqual(d.attachments, [
        pdfAttachment('意見募集要領（提出先を含む）', '意見公募要領', '0000324434'),
        pdfAttachment('命令などの案', '定めようとする命令等及び根拠法令条項の一覧表', '0000324435'),
        pdfAttachment('命令などの案', '命令等の案（新旧対照表）', '0000324436'),
        pdfAttachment('関連資料、 その他', '報道資料', '0000324437'),
    ]);
    assert.doesNotMatch(JSON.stringify(d), /TEL|電話/);
});

test('parseDetail extracts result pages', () => {
    const d = parseDetail(fx('detail_result.html'));
    assert.equal(d.caseNumber, '145210763');
    assert.equal(d.procedureType, '任意の意見募集');
    assert.equal(d.revisedAfterComments, null);
    const section = '結果概要 提出意見 意見の考慮 結果・理由等';
    assert.deepEqual(d.attachments, [
        pdfAttachment(section, '提出された意見及び総務省の考え方', '0000324405'),
        pdfAttachment(section, '「消費者保護ルール実施状況のモニタリング2026年度調査計画」', '0000324406'),
        pdfAttachment('その他', '報道発表資料', '0000324407'),
    ]);
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

test('parseDetail keeps unique attachment links from document rows', () => {
    const html = `<table class="egovui-normal-horizontal"><tbody>
      <tr><th>案件番号</th><td>1</td></tr>
      <tr><th>関連資料、その他</th><td>
        <a href="/files/report.PDF?version=2#page=3">報告書</a>
        <a href="https://www.e-gov.go.jp/files/draft.docx">案</a>
        <a href="/files/data.xlsx">データ</a>
        <a href="/pcm/download?seqNo=1234">添付</a>
        <a href="https://public-comment.e-gov.go.jp/pcm/download?seqNo=1234">添付の再掲</a>
        <a href="/pcm/detail?id=2">関連案件</a>
        <a href="/pcm/download">資料番号なし</a>
        <a href="/pcm/download?seqNo=invalid">無効な資料番号</a>
        <a href="/contents/help/?file=report.pdf">ヘルプ</a>
        <a href="https://e-gov.go.jp.example.org/file.pdf">外部ファイル</a>
        <a href="https://www.mhlw.go.jp/a/b.pdf">省庁資料</a>
        <a href="https://www.mhlw.go.jp/a/b">省庁の関連ページ</a>
        <a href="https://example.org/pcm/download?seqNo=1234">外部のダウンロード</a>
        <a href="javascript:void(0)">操作</a>
        <a href="mailto:test@example.org">メール</a>
        <a href=" #notes">ページ内リンク</a>
      </td></tr>
      <tr><th>命令などの案</th><td><a href="/files/report.PDF?version=2">報告書の再掲</a></td></tr>
      <tr><th>資料の入手方法</th><td><a href="/files/location.pdf">窓口</a></td></tr>
      <tr><th>カテゴリー</th><td><a href="/files/category.pdf">分類</a></td></tr>
    </tbody></table>`;
    assert.deepEqual(parseDetail(html).attachments.map(({ title, url }) => [title, url]), [
        ['報告書', 'https://public-comment.e-gov.go.jp/files/report.PDF?version=2#page=3'],
        ['案', 'https://www.e-gov.go.jp/files/draft.docx'],
        ['データ', 'https://public-comment.e-gov.go.jp/files/data.xlsx'],
        ['添付', 'https://public-comment.e-gov.go.jp/pcm/download?seqNo=1234'],
        ['外部ファイル', 'https://e-gov.go.jp.example.org/file.pdf'],
        ['省庁資料', 'https://www.mhlw.go.jp/a/b.pdf'],
    ]);
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
      <tr><th>関連資料、その他</th><td><a href="/contents/contact">担当</a><a href="/doc.pdf">資料</a></td></tr>
      <tr><th>資料の入手方法</th><td><a href="/a.pdf">窓口</a></td></tr>
    </tbody></table>`;
    assert.deepEqual(parseDetail(html).attachments.map((a) => a.url), ['https://public-comment.e-gov.go.jp/doc.pdf']);
});

test('parseDetail requires a case number', () => {
    assert.throws(() => parseDetail('<table class="egovui-normal-horizontal"><tr><th>カテゴリー</th><td>x</td></tr></table>'), /no case number/);
});

test('prechecks the dataset item budget and allows non-PPE output', async (t) => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const values = new Map();
        const rows = [];
        const actor = {};
        configureActor(actor, rows);
        t.mock.method(Actor, 'getChargingManager', actor.getChargingManager);
        t.mock.method(Actor, 'init', async () => {});
        t.mock.method(Actor, 'exit', async () => {});
        t.mock.method(Actor, 'fail', async (message) => assert.fail(message));
        t.mock.method(Actor, 'getInput', async () => ({ onlyNew: true, fetchDetails: false, maxItems: 3 }));
        t.mock.method(Actor, 'openKeyValueStore', async () => ({
            getValue: async (key) => structuredClone(values.get(key)),
            setValue: async (key, value) => values.set(key, structuredClone(value)),
        }));
        t.mock.method(Actor, 'setValue', async (key, value) => values.set(key, value));
        t.mock.method(Actor, 'pushData', async (row) => rows.push(row.eventId));
        t.mock.method(log, 'info', () => {});
        t.mock.method(log, 'warning', () => {});
        t.mock.method(globalThis, 'fetch', async () => new Response(fx('pcm_list.xml')));
        await import(`../src/main.js?budget=${isPayPerEvent}-${budget}`);
        const summary = values.get('RUN_SUMMARY');
        assert.equal(rows.length, isPayPerEvent ? budget : 3);
        assert.equal(summary.pushed, rows.length);
        assert.equal(summary.stopReason, isPayPerEvent ? 'spendingLimit' : undefined);
        assert.deepEqual(values.get('seen-default'), rows);
    }
});
