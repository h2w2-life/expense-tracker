# CLAUDE.md — Expense Tracker

Read this in full at the start of every session in this repo. It captures a design discussion that was already had at length with the user — treat every decision in §1–4 as settled; don't re-litigate unless the user raises something new or a decision turns out to be wrong once built.

This file doubles as the ongoing feature/status tracker: §6 is a living checklist, keep it updated as work progresses (check items off, add new ones as they surface, note anything that changed from the original plan and why).

## 1. Vision

A tagging-based personal expense tracker, replacing a monthly Excel sheet (date / income-or-expense / amount / description / N tag columns). The Excel approach broke down because "which rows are tagged Amazon" required scanning every tag column since Amazon might land in column 5 one day and column 7 another. The fix is structural: tags live in a proper many-to-many relationship, not spreadsheet columns, so "find everything tagged Amazon" is a lookup regardless of how many other tags a row has.

Primary use case: reconcile personal spending against credit card statements, analyze spend by account and by tag (including combinations like "Amazon AND card-XYZ, but NOT card-PQR").

## 2. Core design decisions (settled)

1. **Tags only, no categories.** A category system is tags with an artificial "pick one" rule — exactly the rule that caused the Amazon-in-groceries-or-gifts-or-clothes problem. One flat, unordered tag set per line item. Hierarchy can be faked later via naming convention (`food/groceries`) if ever wanted — not needed for v1.
2. **Account is a first-class field, not a tag.** It's mutually exclusive per transaction (one card swipe = one account) and is the primary reconciliation axis against card statements — opposite semantics from tags.
3. **Splits are core, not bolted on.** A transaction (date, type, account, description, stated total) contains 1..N **line items** (amount, description, tags). A normal single-item purchase is just a transaction with one line item — no special-casing between "split" and "not split." Tags live on the line item, never on the transaction itself. Real motivating example: one Amazon card charge split into groceries / books / gift, each independently tagged.
4. **Tags are mandatory on every line item** (≥1 required) — user's explicit call, overriding the initially-recommended "optional."
5. **Stated total is stored explicitly** on the transaction, separate from `sum(line item amounts)`. A "needs reconciliation" view flags transactions where they don't match — lets you enter a card total now, some line items now, and finish tagging later without losing the target. Mismatches are flagged, not blocked at save time.
6. **Auto-calculate the one missing value.** On the entry form, among `[stated total, item₁, item₂, …, itemN]`, at most one field may be left blank; whichever is blank gets computed from the rest. If none are blank, validate and flag rather than silently trust.
7. **Every amount field accepts inline arithmetic** (`120+340+75` evaluates on blur/Enter) instead of a separate calculator widget. This is also how the "give total + solve for last item" workflow gets used in practice — user can just type sums directly.
8. **Tag filtering v1: AND + NOT** across arbitrary tag sets (e.g., "Amazon AND card-XYZ, NOT card-PQR"). Pure OR / arbitrary boolean expressions deferred to v2 (cheap enough later once AND/NOT groundwork exists).
9. **Statement-cycle filtering pulled into v1** (not deferred) — each account has an optional `statementCycleStartDay` (e.g. 16, for a 16th-to-15th billing cycle); analysis can filter by cycle period instead of calendar month. Cheap: one field + a date-range query.
10. **Single currency (INR), manual entry only** — no multi-currency, no CSV/statement import in v1.
11. **Transactions and line items are editable and deletable.**
12. **Amounts are stored as integer paise internally** (not float rupees) to avoid floating-point drift when summing many line items for reconciliation checks. Convert to/from rupees only at the UI boundary.
13. **Tag names are normalized on save**: trimmed, lowercased, internal whitespace collapsed — prevents `Amazon` / `amazon` / `amazon ` drift. Autocomplete surfaces existing tags before allowing a new one.
14. **No categories/tags second classification system** — reconfirmed, see #1. Don't add one later without a very concrete reason.

## 3. Architecture decisions (settled)

15. **No backend.** Static HTML/CSS/JS only, ES modules, no build step, no bundler, no framework.
16. **No SQLite/WASM.** Originally planned (sql.js), then deliberately dropped: at "hundreds of transactions/month" scale, a query engine is overkill — plain JS objects in IndexedDB with `.filter()`/`.reduce()` over an in-memory fetch-all is simpler, has zero vendored dependencies, and avoids the "browsers block `fetch()` of a WASM binary from `file://`" problem entirely. Tradeoff accepted knowingly: no ad-hoc SQL querying of a `.sqlite` file — analysis needs are instead served by purpose-built dashboards in §6, not a generic SQL escape hatch.
17. **Storage: IndexedDB**, not the File System Access API. File System Access (`showOpenFilePicker`/`showSaveFilePicker`) was considered and rejected because it's desktop-Chromium-only and doesn't exist on mobile browsers at all — would have needed a swappable storage adapter for the future mobile build. IndexedDB works identically everywhere (desktop and mobile PWA/Cordova), so the same storage code ports with no adapter seam needed.
18. **Backup/restore is manual, file-based**: an Export button serializes all IndexedDB stores to a downloadable JSON file; an Import button (`<input type="file">`) reads one back in and restores. Deliberately plain browser APIs (download/upload), not File System Access — works uniformly on desktop and mobile. This is also the "manual cloud backup" mechanism for now: user drops the exported JSON into Drive/Dropbox/etc. by hand.
19. **PWA**: `manifest.json` + a cache-first service worker for the static app shell, so once installed it works fully offline. Important caveat learned during design: **you cannot install a PWA from a double-clicked `file://` page** — browsers require `http(s)` (or `localhost`) as a secure context for the manifest/service-worker to register. Fix: run a trivial local static file server (e.g. `python3 -m http.server`) and open `http://localhost:PORT` — that's enough for Chrome/Edge to offer "Install." Not a real backend — no routes, no application logic server-side, purely serving static files.
20. **No live CDN dependencies.** Everything the app needs ships in the repo. (This constraint is largely moot now that WASM/sql.js was dropped — there's currently nothing to vendor.)

## 4. Future-facing constraints (not building now — do not design against them)

21. User intends to eventually wrap this same HTML/JS/CSS as a mobile app via Cordova (possibly Play Store, "very very unlikely" per user). **Build responsive/mobile-first CSS from day one** — relative units, flexbox/grid, ≥44px touch targets, no hover-dependent interactions — cheap to do correctly now, expensive to retrofit from a desktop-fixed layout later.
22. Cloud backup on mobile (manual share-sheet upload now, automatic API sync possibly later) requires no design change today — already covered by the plain-file export/import in #18. Nothing to build differently in anticipation of this.
23. IndexedDB + plain-file export/import were specifically chosen (over sql.js/WASM and File System Access API) because they already work identically on both desktop and future mobile packaging — this was a deliberate simplification that also happens to future-proof storage with zero extra work.

## 5. Data model (IndexedDB — `expenseTrackerDB`, version 1)

Object stores (all `keyPath: 'id', autoIncrement: true` unless noted):

- **`accounts`**: `{ id, name, statementCycleStartDay }` — `statementCycleStartDay` is `null` or 1–31. Unique index on `name`.
- **`tags`**: `{ id, name }` — `name` normalized (trim/lowercase/collapsed whitespace). Unique index on `name`.
- **`transactions`**: `{ id, date, type, accountId, description, statedTotal }` — `type` is `'expense' | 'income'`, `statedTotal` in paise. Indexes on `date`, `accountId`, `type`.
- **`lineItems`**: `{ id, transactionId, amount, description, tagIds }` — `amount` in paise, `tagIds` is an array of tag ids. Index on `transactionId`; **multiEntry** index on `tagIds` for tag-based queries.

No separate join table needed — `tagIds` as an array field with a multiEntry index does the many-to-many job natively in IndexedDB.

Given expected volume (hundreds/month → low thousands of rows even after a few years), analysis views fetch all transactions + line items once and filter/group in plain JS rather than building complex cursor/index-intersection queries.

## 6. Feature / status tracker

File layout (vanilla JS, ES modules, one module per concern):
`js/dom.js` (DOM-builder helper + `field()` label-association helper, shared by every view) · `js/money.js` (paise↔rupee helpers, INR formatting) · `js/calc.js` (safe arithmetic expression evaluator, no `eval()`) · `js/db.js` (IndexedDB layer per §5) · `js/tags.js` (tag-chip autocomplete input for the entry form, plus the shared multi-select AND tag-filter widget used by both Analysis and Transactions) · `js/entry.js` (add/edit transaction form + inline account creation) · `js/list.js` (transaction list/filters, edit/delete, reconciliation-mismatch indicator) · `js/analysis.js` (monthly summary, by-account, tag AND/NOT filter, statement-cycle filter, needs-reconciliation list) · `js/backup.js` (JSON export/import) · `js/settings.js` (account + tag management UI, wires up `backup.js`'s export/import buttons — added during the build; the original plan didn't list it separately, but `index.html`'s Settings tab needed a home for it) · `js/app.js` (hash-based tab routing, toast notifications, wires everything together — each view re-fetches fresh from IndexedDB on render, no separate app-level state store).

Status: **v1 feature-complete, browser-verified, and in active real-world use** (the user has imported their full personal ledger history — see "Real data" below).

- [x] Repo created at `~/code/expense-tracker`, git initialized, branch `main`
- [x] `index.html` — tab nav (Add / Transactions / Analysis / Settings)
- [x] `manifest.json`, `sw.js`, `css/style.css`, `icons/icon.svg` — PWA shell, installable from `http://localhost`
- [x] `js/money.js` + `js/calc.js`
- [x] `js/db.js` — full CRUD per §5, plus `exportAll()`/`importAll()` for backup
- [x] `js/tags.js` — tag-chip autocomplete input (entry form) + shared multi-select AND tag-filter widget (Analysis, Transactions)
- [x] `js/entry.js` — entry form with splits, mandatory-tag validation, auto-calc-the-blank-value logic (§2.6), inline account creation
- [x] `js/list.js` — transaction list: date range, account, type (expense/income), and multi-tag-AND filters; account names and tag chips on every row are clickable links that apply/extend the filters in place; split transactions (>1 line item) auto-expand; edit/delete; reconciliation-mismatch badge
- [x] `js/analysis.js` — income/expense summary, by-account breakdown, tag AND/NOT filter, calendar-month or statement-cycle date-range filter, needs-reconciliation list
- [x] `js/backup.js` + `js/settings.js` — export/import JSON, account management, tag management (rename/delete, tag names are links into a filtered Transactions view)
- [x] End-to-end browser verification (headless, against `python3 -m http.server`) after every change in this log, including a full pass against the real imported dataset below (filters, links, edit/delete, reconciliation, backup round-trip, PWA installability).

**Real data**: the user's full personal ledger (Nov 2025 – Aug 2026, from an hledger-style double-entry file plus a simpler flat-format continuation) has been converted and imported: 482 transactions, 687 line items, 95 tags, 6 accounts (Yes Bank, HDFC Bank, HDFC Card, SBI Card, Cash, Amazon Pay). Conversion logic lives in `tools/ledger_import.py` (committed — no financial data in it, just parsing/mapping code; run `python3 tools/ledger_import.py --help` for usage) — it auto-continues id sequences across multiple runs by reading back whatever `ledger-import.json` already exists, so pasting more ledger history later is a matter of running it again against the new file, not re-deriving the logic from scratch. The generated `ledger-import.json` and `ledger-import-skipped.md` (68 hledger + 2 flat-format entries flagged for manual review — mixed refund/purchase entries, compound multi-account entries, out-of-scope accounts like zerodha/loans, and untaggable "???" lines) are gitignored (real financial data, never committed) but remain on disk.

**Bug fixes since initial build** (all found and verified via headless-browser testing against the live app, not just code review):
- Edit button from the Transactions list opened a blank Add form — `app.js`'s hash-routing wrote `location.hash` on every `navigate()` call, and the resulting async `hashchange` re-ran the view with no params, clobbering `editId`. Fixed by guarding self-initiated hash changes.
- Transaction rows showed a blank description when only a line item (not the transaction) had one — now falls back to the first line item's description, in both the Transactions list and Analysis's reconciliation list.
- Every `.field` label was visually correct but not programmatically associated with its input (`for`/`id` never linked) — fixed via a `field()` helper in `dom.js` used everywhere a label+input pair is built.
- The service worker's "network-first" strategy could still serve stale files from the browser's own HTTP cache (a layer separate from the SW's Cache Storage) because the dev server sends no `Cache-Control` header — fixed by forcing `cache: 'no-store'`/`'reload'` on the SW's own fetch calls.

**Features added beyond the original v1 scope** (all user-requested, all shipped):
- Date range filter (From/To) on Transactions, defaulting to start-of-current-month → today.
- Account and Type (expense/income) filters, and a multi-select AND tag filter, on Transactions.
- Account names and tags are clickable throughout (Transactions rows, Settings tag list) — clicking applies/extends the relevant filter instead of requiring manual dropdown use.
- Split transactions auto-expand in the Transactions list so the line-item breakdown is visible without a click.

- Transaction list header now shows tags directly for single-item purchases (clickable to filter); split transactions show a `Split (N)` badge instead, emphasizing the need to expand for details.
Known rough edges / deferred polish (not blocking v1, noted for later):
- Dedicated PNG icon sizes for iOS/Android home-screen polish are still deferred per §4 (the single SVG `"sizes": "any"` is enough for Chrome desktop install).
- No automated test suite yet (browser-verified manually per above) — add one if a regression surfaces or before the Cordova wrap in §4.

## 7. Collaboration notes

- This project's design phase was thorough and explicit — the user asked to discuss before any code, went through several rounds of proposal → question → correction. Don't skip that pattern for future *design* decisions (as opposed to routine implementation details, which don't need sign-off).
- Explicit steer: **keep it as simple as possible.** This is why SQLite/WASM and the File System Access API were both proposed and then deliberately dropped in favor of plain IndexedDB + vanilla JS — simpler won over "more capable" repeatedly in this project's decisions. Default to that bias here.
- This repo is intentionally separate from `~/code/clojure/stox-v2` (an unrelated Clojure trading-system project) — don't read or reference that repo's code or its `resources/CLAUDE.md` for this project; they share nothing.
