# Japan Public Comment Monitor (e-Gov パブコメ)

Track **Japanese government public comment procedures (パブリック・コメント / 意見公募)** from the official e-Gov portal as structured JSON: new draft regulations open for comment, deadlines, the responsible ministry, legal basis, links to every draft / guideline PDF, and published results with the number of comments received.

Ideal for regulatory and policy monitoring: run it on a schedule with **monitoring mode** and receive only new items, filtered by category, ministry or keyword.

## What you get

| Field | Description |
|---|---|
| `kind` | `open` (call for comments) or `results` (published result) |
| `caseId`, `caseNumber` | e-Gov case number (案件番号) |
| `title` | Title of the procedure |
| `ministry` | Responsible ministry / agency (e.g. 総務省, 金融庁) |
| `category` | e-Gov policy category (e.g. 電気通信, 金融、保険) |
| `proposalDate` | Date the draft was published (案の公示日) |
| `deadline` | Comment deadline (受付締切日時, JST, ISO 8601) |
| `resultDate`, `promulgationDate`, `commentCount` | For results: result date, promulgation date, number of comments submitted |
| `orderTitle`, `legalBasis`, `procedureType` | Title of the order, legal basis (根拠法令条項), whether it is a procedure under the Administrative Procedure Act or a voluntary call |
| `receptionStart`, `revisedAfterComments`, `materialsAvailability` | Further details from the case page |
| `eventId` | Stable ID (`kind:caseId`) for de-duplicating notifications downstream |
| `retrievedAt` | When the item was first fetched from e-Gov (kept for items retried from a later run; use it as the 利用日 in attributions) |
| `attachments` | Every document on the page: `{ section, title, url, fileType }` — drafts, comparison tables, guidelines, results and government responses |
| `url` | Link to the case page on e-Gov |

Detail fields and attachments require `fetchDetails: true` (default).

## Use cases

- **Regulatory affairs / compliance:** get notified when ministries propose rule changes in your sector, with the deadline and draft PDFs
- **Law firms & consultancies:** weekly digests of new drafts and results per client industry
- **Industry associations:** never miss a comment window
- **AI agents & RAG:** feed new Japanese draft regulations (and their PDFs) into analysis pipelines

## Input examples

New calls for comment in telecom and finance, monitoring mode (schedule daily):

```json
{
  "feeds": ["open"],
  "categories": ["電気通信", "金融、保険"],
  "onlyNew": true,
  "stateKey": "telecom-finance"
}
```

Items from the Personal Information Protection Commission whose title mentions AI, open calls and results:

```json
{
  "feeds": ["open", "results"],
  "ministries": ["個人情報保護委員会"],
  "keywords": ["AI", "人工知能"]
}
```

Note: `ministries` and `keywords` are combined with AND (an item must match both lists when both are set); values inside one list are OR.

## Output example

```json
{
  "kind": "open",
  "caseId": "145210800",
  "title": "無線局（基幹放送局を除く。）の開設の根本的基準等の一部を改正する省令案等に係る意見募集 － 自律型海上無線機器（AMRD）の導入等のための制度整備 －",
  "url": "https://public-comment.e-gov.go.jp/servlet/Public?CLASSNAME=PCMMSTDETAIL&id=145210800&Mode=0",
  "category": "電気通信",
  "ministry": "総務省",
  "proposalDate": "2026-11-21",
  "deadline": "2026-12-21T23:59:00+09:00",
  "procedureType": "行政手続法に基づく手続",
  "receptionStart": "2026-11-21T00:00:00+09:00",
  "attachments": [
    { "section": "意見募集要領（提出先を含む）", "title": "意見公募要領", "url": "https://public-comment.e-gov.go.jp/pcm/download?seqNo=0000324434", "fileType": "PDF" },
    { "section": "命令などの案", "title": "命令等の案（新旧対照表）", "url": "https://public-comment.e-gov.go.jp/pcm/download?seqNo=0000324436", "fileType": "PDF" }
  ],
  "source": "e-Gov public comment (e-Govパブリック・コメント), Digital Agency of Japan"
}
```

## How it works & limits

- The Actor reads e-Gov's official RSS feeds (all items, or one feed per selected category) and optionally opens each case page. Requests are sequential with a delay (default 2 s).
- The RSS feeds only contain **recent items** (the all-items feed holds a few dozen). Selecting categories reaches further back for those categories. For complete coverage, run it on a schedule with `onlyNew: true` — items whose detail page could not be loaded are kept as pending and retried on the next run.
- When the pay-per-event spending limit is reached, the run stops with a warning and monitoring keeps unsaved items pending for the next run.
- **Privacy:** contact sections (問合せ先) and the free-form remarks (備考) may include staff names and phone numbers, so they are never output. The ministry is matched against a list of known government organisations (null if none is recognised), phone numbers and e-mail addresses are removed from remaining free text, and only http(s) document links are listed.
- The feeds only reach back a limited time; items that dropped out of the RSS before your first run cannot be fetched. In monitoring mode, do not run two schedules with the same `stateKey` at the same time. `maxDetailRequests` limits detail page downloads per run.
- Without monitoring mode, if every detail page fails the run still outputs the RSS rows (with `detailError`) but ends as failed so you notice the outage.
- PDF documents are linked, not downloaded.

## Data source & terms

Data: e-Gov public comment, operated by the Digital Agency of Japan. Content is available under the Public Data License 1.0 (公共データ利用規約 第1.0版); see the [e-Gov public comment terms](https://public-comment.e-gov.go.jp/contents/terms). When you publish the data, credit the source (e.g. 出典：「○○に関する意見募集について」（e-Govパブリック・コメント）（URL）（2026年11月21日に利用）, using `retrievedAt` as the date), and state that it was processed and by whom. Attached documents may carry their own rights notices; check them before reuse. This Actor is not affiliated with or endorsed by the Digital Agency or e-Gov.

---

## 日本語の概要

e-Govパブリック・コメントの公式 RSS と案件ページから、意見募集中の案件と結果公示案件を構造化 JSON で取得します（案件番号、所管府省、カテゴリー、公示日、締切日時、根拠法令、手続の種類、添付資料 PDF の一覧、提出意見数など）。`onlyNew` を有効にしてスケジュール実行すると新着だけを出力するので、業界ごとの規制動向モニタリングに使えます。問合せ先（担当者名・電話番号を含む場合がある）は出力しません。出典の明記など、公共データ利用規約（第1.0版）に従ってご利用ください。
