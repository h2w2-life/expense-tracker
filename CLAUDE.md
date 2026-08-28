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

Planned file layout (vanilla JS, ES modules, one module per concern):
`js/dom.js` (tiny DOM-builder helper + `field()` label-association helper, shared by every view) · `js/money.js` (paise↔rupee helpers, INR formatting) · `js/calc.js` (safe arithmetic expression evaluator, no `eval()`) · `js/db.js` (IndexedDB layer per §5) · `js/tags.js` (reusable tag-chip autocomplete input widget) · `js/entry.js` (add/edit transaction form + inline account creation) · `js/list.js` (transaction list, edit/delete, reconciliation-mismatch indicator) · `js/analysis.js` (monthly summary, by-account, tag AND/NOT filter, statement-cycle filter, needs-reconciliation list) · `js/backup.js` (JSON export/import) · `js/settings.js` (account + tag management UI, wires up backup.js's export/import buttons — added during the build; the original plan didn't list it separately, but `index.html`'s Settings tab needed a home for account CRUD and the backup buttons) · `js/app.js` (tab nav via `#hash` routing, toast notifications, wires everything together — each view re-fetches fresh from IndexedDB on render, no separate app-level state store needed)

Status: **v1 feature-complete and browser-verified.**

- [x] Repo created at `~/code/expense-tracker`, git initialized, branch renamed `main`
- [x] `index.html` — tab nav (Add / Transactions / Analysis / Settings), links `manifest.json`, `css/style.css`, `js/app.js`
- [x] `manifest.json`, `sw.js`, `css/style.css`, `icons/icon.svg` — PWA shell. Verified: manifest fetches OK, service worker registers/activates and its `expense-tracker-v1` cache holds the full app shell (confirmed via headless browser against `http://localhost`)
- [x] `js/money.js` + `js/calc.js`
- [x] `js/db.js` — full CRUD per §5 schema, plus `exportAll()`/`importAll()` for backup. Import/export round-trip verified (wipe all stores, re-import, data restored intact including line item tag associations)
- [x] `js/tags.js` — tag-chip input with autocomplete against existing tag names
- [x] `js/entry.js` — entry form with splits, mandatory-tag validation, auto-calc-the-blank-value logic (§2.6), inline account creation (name + optional statement cycle day)
- [x] `js/list.js` — transaction list, edit, delete, reconciliation-mismatch indicator
- [x] `js/analysis.js` — income/expense summary, by-account breakdown, tag AND/NOT filter, calendar-month or statement-cycle date-range filter, needs-reconciliation list
- [x] `js/backup.js` + `js/settings.js` — export button (download JSON), import button (file input, restore), account management (add/edit/delete, statement cycle day), tag management (rename/delete)
- [x] End-to-end browser test (headless, against `python3 -m http.server` on `http://localhost`): created an account with a statement cycle day, added a split transaction (two line items, two tags, auto-reconciling stated total), verified the transaction list row and its per-item tags, verified the Analysis summary and by-account totals, verified the tag AND filter narrows results correctly, verified Settings renders account/tag rows, verified backup export/import round-trips through `db.js` directly, verified the manifest + service worker (app-shell cache) are both in place for PWA install from `http://localhost`

Known rough edges / deferred polish (not blocking v1, noted for later):
- Dedicated PNG icon sizes for iOS/Android home-screen polish are still deferred per §4 (the single SVG `"sizes": "any"` is enough for Chrome desktop install).
- No automated test suite yet (browser-verified manually per above) — add one if a regression surfaces or before the Cordova wrap in §4.

## 7. Collaboration notes

- This project's design phase was thorough and explicit — the user asked to discuss before any code, went through several rounds of proposal → question → correction. Don't skip that pattern for future *design* decisions (as opposed to routine implementation details, which don't need sign-off).
- Explicit steer: **keep it as simple as possible.** This is why SQLite/WASM and the File System Access API were both proposed and then deliberately dropped in favor of plain IndexedDB + vanilla JS — simpler won over "more capable" repeatedly in this project's decisions. Default to that bias here.
- This repo is intentionally separate from `~/code/clojure/stox-v2` (an unrelated Clojure trading-system project) — don't read or reference that repo's code or its `resources/CLAUDE.md` for this project; they share nothing.
