// Pure helpers for e-Gov public comment (パブリック・コメント) RSS feeds and detail pages.
// RSS list: https://public-comment.e-gov.go.jp/contents/help/guide/rss.html
// Terms: https://public-comment.e-gov.go.jp/contents/terms (Public Data License 1.0)
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

export const BASE = 'https://public-comment.e-gov.go.jp';
export const SOURCE = 'e-Gov public comment (e-Govパブリック・コメント), Digital Agency of Japan';

export const CATEGORIES = [
    'IT社会化推進', '経済財政政策', '共生社会政策', '国民生活の安全・安心の確保', '地方分権改革等', '選挙、政党',
    '独立行政法人等', '国家公務員', '行政手続', '統計', '地方自治', '地方財政、地方税', '司法', '民事', '刑事', '警察',
    '消防', '国土開発', '土地', '都市計画', '道路', '河川', '建築、住宅', '財務', '国有財産', '国税', '国債', '教育',
    '文化', '産業一般', '農業', '林業', '水産業', '鉱業', '工業', '商業', '金融、保険', '外国為替、貿易', '陸運', '海運',
    '航空', '貨物運送', '観光', '郵務', '電気通信', '労働', '環境保全', '厚生', '社会福祉', '社会保険', '防衛', '外事',
    'その他',
];

const KINDS = { open: 'pcm_list', results: 'pcm_result' };

/** RSS URL for open calls ("open") or published results ("results"), optionally for one category. */
export function feedUrl(kind, category = null) {
    const base = KINDS[kind];
    if (!base) throw new Error(`Unknown feed kind "${kind}". Allowed: ${Object.keys(KINDS).join(', ')}`);
    if (!category) return `${BASE}/rss/${base}.xml`;
    const idx = CATEGORIES.indexOf(category);
    if (idx < 0) throw new Error(`Unknown category "${category}".`);
    return `${BASE}/rss/${base}_${String(idx + 1).padStart(10, '0')}.xml`;
}

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === 'item',
});

const clean = (s) => {
    if (s === undefined || s === null) return null;
    const t = String(s).replace(/[\s　]+/g, ' ').trim();
    return t === '' || t === '－' ? null : t;
};

/** "2026/11/21" -> "2026-11-21"; "2026/12/21 23:59" -> "2026-12-21T23:59:00+09:00" (JST). */
export function slashDateToIso(s) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(clean(s) ?? '');
    if (!m) return null;
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return m[4] ? `${d}T${m[4].padStart(2, '0')}:${m[5]}:00+09:00` : d;
}

/** "2026年11月21日" -> "2026-11-21"; "2026年12月21日23時59分" -> ISO datetime (JST). */
export function kanjiDateToIso(s) {
    const m = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})時(\d{1,2})分)?/.exec(clean(s) ?? '');
    if (!m) return null;
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return m[4] ? `${d}T${m[4].padStart(2, '0')}:${m[5].padStart(2, '0')}:00+09:00` : d;
}

// Organisations that run public comment procedures. Longest names first so that e.g.
// 個人情報保護委員会 wins over a shorter overlapping name.
export const ORGANIZATIONS = [
    '内閣官房', '内閣法制局', '人事院', '内閣府', '宮内庁', '公正取引委員会', '国家公安委員会', '警察庁',
    '個人情報保護委員会', 'カジノ管理委員会', '金融庁', '消費者庁', 'こども家庭庁', 'デジタル庁', '復興庁',
    '総務省', '消防庁', '公害等調整委員会', '法務省', '出入国在留管理庁', '公安審査委員会', '公安調査庁',
    '外務省', '財務省', '国税庁', '文部科学省', 'スポーツ庁', '文化庁', '厚生労働省', '中央労働委員会',
    '農林水産省', '林野庁', '水産庁', '経済産業省', '資源エネルギー庁', '特許庁', '中小企業庁',
    '国土交通省', '観光庁', '気象庁', '運輸安全委員会', '海上保安庁', '環境省', '原子力規制委員会',
    '原子力規制庁', '防衛省', '防衛装備庁', '会計検査院', '日本銀行',
].sort((x, y) => y.length - x.length);

/**
 * Responsible ministry/agency: the known organisation name that appears first in the contact text.
 * Returns null when no known organisation is found. Contact details (staff names, phone numbers)
 * are never output.
 */
export function extractMinistry(contact) {
    const t = String(contact ?? '');
    let best = null;
    for (const org of ORGANIZATIONS) {
        const i = t.indexOf(org);
        if (i >= 0 && (best === null || i < best.i)) best = { org, i };
    }
    return best ? best.org : null;
}

/** Remove phone numbers and e-mail addresses from free text. */
export function redactContacts(text) {
    if (text == null) return text;
    return String(text)
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted]')
        .replace(/[+＋]\s?[8８]\s?[1１][-－‐ー\s()（）]*[0-9０-９]{1,4}[-－‐ー\s()（）]*[0-9０-９]{1,4}[-－‐ー\s()（）]*[0-9０-９]{3,4}/g, '[redacted]')
        .replace(/(?:\+?81[-\s]?)?[0０][0-9０-９]{1,4}[-－‐ー\s()（）]*[0-9０-９]{1,4}[-－‐ー\s()（）]*[0-9０-９]{3,4}/g, '[redacted]')
        .replace(/(?:TEL|Tel|tel|電話|内線|FAX|Fax|ＴＥＬ)\s*[:：]?\s*\[redacted\]/g, '[redacted]');
}

function caseIdFromUrl(url) {
    try {
        return new URL(url).searchParams.get('id');
    } catch {
        return null;
    }
}

function parseDescription(desc) {
    const fields = {};
    for (const part of String(desc ?? '').split(/<br\s*\/?>/i)) {
        const i = part.indexOf('：');
        if (i < 0) continue;
        fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return fields;
}

/** Parse an e-Gov public comment RSS 1.0 feed. */
export function parseRss(xml, kind) {
    const valid = XMLValidator.validate(String(xml ?? ''));
    if (valid !== true) throw new Error(`Malformed RSS XML: ${valid.err?.msg ?? 'invalid'}`);
    const doc = parser.parse(xml);
    const rdf = doc.RDF;
    if (!rdf?.channel) throw new Error('Not an RSS 1.0 feed (missing rdf:RDF/channel)');
    return (rdf.item ?? []).map((it) => {
        const url = clean(it.link) ?? it['@_about'];
        const f = parseDescription(it.description);
        const commentCount = Number(f['提出意見数']);
        return {
            kind,
            caseId: caseIdFromUrl(url),
            title: redactContacts(clean(it.title)),
            url,
            category: clean(f['カテゴリー']),
            ministry: extractMinistry(f['問合せ先（所管省庁・部局名等）']),
            proposalDate: slashDateToIso(f['案の公示日']),
            deadline: slashDateToIso(f['受付締切日時']),
            resultDate: slashDateToIso(f['結果の公示日']),
            promulgationDate: slashDateToIso(f['命令等の公布日']),
            commentCount: f['提出意見数'] !== undefined && f['提出意見数'] !== '' && Number.isFinite(commentCount)
                ? commentCount : null,
            feedDate: clean(it.date)?.replace(/T(\d{2}):(\d{2}):Z$/, 'T$1:$2:00Z') ?? null,
        };
    });
}

const DETAIL_FIELDS = {
    案件番号: 'caseNumber',
    定めようとする命令などの題名: 'orderTitle',
    根拠法令条項: 'legalBasis',
    行政手続法に基づく手続か: 'procedureType',
    受付開始日時: 'receptionStart',
    対象が定められた日: 'decidedDate',
    提出意見を踏まえた案の修正の有無: 'revisedAfterComments',
    意見提出が30日未満の場合その理由: 'shortPeriodReason',
    資料の入手方法: 'materialsAvailability',
};
const DATE_FIELDS = new Set(['receptionStart', 'decidedDate']);
// Contact rows are deliberately skipped (may contain staff names and phone numbers).
const SKIP_ROWS = /問合せ|問い合わせ|連絡先|担当/;
// Rows whose links are documents. Links elsewhere (e.g. remarks) are not output.
const DOC_ROWS = /要領|案|資料|結果|意見|考え方|その他|概要|公募時/;
// Rows that are free text even though their label matches DOC_ROWS.
const NON_DOC_ROWS = /入手方法|備考|問合せ|問い合わせ|連絡/;
// A link counts as a document when it is an e-Gov download/page link or points to a document file.
const DOC_EXT = /\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|txt|rtf|odt|ods)$/i;
function isDocumentLink(u) {
    if (u.hostname === 'public-comment.e-gov.go.jp') return true;
    return DOC_EXT.test(u.pathname);
}

/** Parse a detail page (open call or result). Returns extra fields + attachment list. */
export function parseDetail(html) {
    const $ = cheerio.load(html);
    const rows = $('table.egovui-normal-horizontal tr');
    if (!rows.length) throw new Error('Unexpected detail page layout (no detail table found)');
    const out = { attachments: [] };
    rows.each((_, tr) => {
        const label = clean($(tr).find('th').first().text());
        if (!label || SKIP_ROWS.test(label)) return;
        const td = $(tr).find('td').first();
        td.find('a[href]').each((__, a) => {
            if (!DOC_ROWS.test(label) || NON_DOC_ROWS.test(label)) return;
            const href = $(a).attr('href');
            if (!href) return;
            let abs;
            try { abs = new URL(href, BASE); } catch { return; }
            if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return;
            if (!isDocumentLink(abs)) return;
            const badge = clean($(a).nextAll('.egovui-badge').first().text());
            out.attachments.push({
                section: label,
                title: redactContacts(clean($(a).text())?.replace(/^・/, '') ?? null),
                url: abs.href,
                fileType: badge,
            });
        });
        const key = DETAIL_FIELDS[label];
        if (key) {
            const raw = clean(td.text());
            const value = key === 'caseNumber' ? raw : redactContacts(raw);
            out[key] = DATE_FIELDS.has(key) ? (kanjiDateToIso(value) ?? value) : value;
        }
    });
    if (!out.caseNumber || !/^\d+$/.test(out.caseNumber)) {
        throw new Error('Unexpected detail page layout (no case number found)');
    }
    return out;
}

export function itemMatches(item, { keywords = [], ministries = [], categories = [] } = {}) {
    if (keywords.length && !keywords.some((k) => item.title?.includes(k))) return false;
    if (ministries.length && !ministries.some((m) => item.ministry?.includes(m))) return false;
    if (categories.length && !categories.includes(item.category)) return false;
    return true;
}
export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
