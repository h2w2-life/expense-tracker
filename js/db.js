// IndexedDB data layer. Schema per CLAUDE.md §5 — plain objects, no ORM,
// fetch-all-then-filter-in-JS since volume is low (hundreds/month).

const DB_NAME = 'expenseTrackerDB';
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('accounts')) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
        accounts.createIndex('name', 'name', { unique: true });
      }
      if (!db.objectStoreNames.contains('tags')) {
        const tags = db.createObjectStore('tags', { keyPath: 'id', autoIncrement: true });
        tags.createIndex('name', 'name', { unique: true });
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const transactions = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        transactions.createIndex('date', 'date');
        transactions.createIndex('accountId', 'accountId');
        transactions.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('lineItems')) {
        const lineItems = db.createObjectStore('lineItems', { keyPath: 'id', autoIncrement: true });
        lineItems.createIndex('transactionId', 'transactionId');
        lineItems.createIndex('tagIds', 'tagIds', { multiEntry: true });
      }
      // v2 added a 'meta' store for a linked auto-backup file handle (File
      // System Access API) — reverted (2026-09-06): doesn't work at all in
      // an installed PWA/mobile context, which is the actual primary use
      // case. Left at v2/the empty store rather than migrating existing
      // installs down, since deleting it buys nothing.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function getAll(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).getAll());
}

async function getOne(storeName, id) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).get(id));
}

async function add(storeName, obj) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const idPromise = promisifyRequest(tx.objectStore(storeName).add(obj));
  const id = await idPromise;
  await promisifyTransaction(tx);
  return id;
}

async function put(storeName, obj) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const idPromise = promisifyRequest(tx.objectStore(storeName).put(obj));
  const id = await idPromise;
  await promisifyTransaction(tx);
  return id;
}

async function remove(storeName, id) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(id);
  await promisifyTransaction(tx);
}

function normalizeCycleDay(day) {
  if (day === null || day === undefined || day === '') return null;
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('Statement cycle start day must be an integer 1-31');
  return n;
}

// ---------- Accounts ----------

export async function listAccounts() {
  const accounts = await getAll('accounts');
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAccount(id) {
  return getOne('accounts', id);
}

export async function createAccount({ name, statementCycleStartDay = null }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('Account name is required');
  const cycleDay = normalizeCycleDay(statementCycleStartDay);
  try {
    const id = await add('accounts', { name: cleanName, statementCycleStartDay: cycleDay });
    return { id, name: cleanName, statementCycleStartDay: cycleDay };
  } catch (err) {
    if (err && err.name === 'ConstraintError') throw new Error(`Account "${cleanName}" already exists`);
    throw err;
  }
}

export async function updateAccount(id, patch) {
  const existing = await getOne('accounts', id);
  if (!existing) throw new Error(`Account ${id} not found`);
  const updated = { ...existing };
  if (patch.name !== undefined) updated.name = patch.name.trim();
  if (patch.statementCycleStartDay !== undefined) updated.statementCycleStartDay = normalizeCycleDay(patch.statementCycleStartDay);
  if (!updated.name) throw new Error('Account name is required');
  try {
    await put('accounts', updated);
  } catch (err) {
    if (err && err.name === 'ConstraintError') throw new Error(`Account "${updated.name}" already exists`);
    throw err;
  }
  return updated;
}

export async function deleteAccount(id) {
  const transactions = await getAll('transactions');
  if (transactions.some((t) => t.accountId === id || t.toAccountId === id)) {
    throw new Error('Cannot delete an account that has transactions. Reassign or delete those first.');
  }
  await remove('accounts', id);
}

// ---------- Tags ----------

export function normalizeTagName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function listTags() {
  const tags = await getAll('tags');
  return tags.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findOrCreateTag(rawName) {
  const name = normalizeTagName(rawName);
  if (!name) throw new Error('Tag name is required');
  const db = await openDB();
  const tx = db.transaction('tags', 'readwrite');
  const store = tx.objectStore('tags');
  const existing = await promisifyRequest(store.index('name').get(name));
  if (existing) {
    await promisifyTransaction(tx);
    return existing;
  }
  const id = await promisifyRequest(store.add({ name }));
  await promisifyTransaction(tx);
  return { id, name };
}

export async function findOrCreateTags(rawNames) {
  const seen = new Set();
  const results = [];
  for (const raw of rawNames) {
    const tag = await findOrCreateTag(raw);
    if (!seen.has(tag.id)) {
      seen.add(tag.id);
      results.push(tag);
    }
  }
  return results;
}

export async function renameTag(id, rawName) {
  const name = normalizeTagName(rawName);
  if (!name) throw new Error('Tag name is required');
  const existing = await getOne('tags', id);
  if (!existing) throw new Error('Tag not found');
  try {
    await put('tags', { id, name });
  } catch (err) {
    if (err && err.name === 'ConstraintError') throw new Error(`Tag "${name}" already exists`);
    throw err;
  }
  return { id, name };
}

// Deletes a tag and detaches it from any line items that reference it.
// Does not enforce the "at least one tag per line item" rule retroactively —
// callers should warn the user if the tag is in use.
export async function deleteTag(id) {
  const db = await openDB();
  const tx = db.transaction(['lineItems', 'tags'], 'readwrite');
  const liStore = tx.objectStore('lineItems');
  const all = await promisifyRequest(liStore.getAll());
  for (const li of all) {
    if (li.tagIds.includes(id)) {
      li.tagIds = li.tagIds.filter((t) => t !== id);
      liStore.put(li);
    }
  }
  tx.objectStore('tags').delete(id);
  await promisifyTransaction(tx);
}

export async function countLineItemsUsingTag(id) {
  const all = await getAll('lineItems');
  return all.filter((li) => li.tagIds.includes(id)).length;
}

// ---------- Transactions + line items ----------

export async function listTransactions() {
  const txns = await getAll('transactions');
  return txns.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

export function getTransaction(id) {
  return getOne('transactions', id);
}

export async function listLineItemsForTransaction(transactionId) {
  const db = await openDB();
  const tx = db.transaction('lineItems', 'readonly');
  return promisifyRequest(tx.objectStore('lineItems').index('transactionId').getAll(transactionId));
}

export function listAllLineItems() {
  return getAll('lineItems');
}

// Transactions joined with their line items, newest first. The one-shot
// fetch-everything view used by list.js and analysis.js.
export async function listTransactionsWithLineItems() {
  const [transactions, lineItems] = await Promise.all([getAll('transactions'), getAll('lineItems')]);
  const byTxn = new Map();
  for (const li of lineItems) {
    if (!byTxn.has(li.transactionId)) byTxn.set(li.transactionId, []);
    byTxn.get(li.transactionId).push(li);
  }
  return transactions
    .map((t) => ({ ...t, lineItems: byTxn.get(t.id) || [] }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

/**
 * Create or fully replace a transaction and its line items in one atomic
 * IndexedDB transaction. Pass `id` to edit an existing transaction (its
 * previous line items are deleted and replaced wholesale); omit it to create.
 *
 * `seriesId`/`seriesIndex` mark a transaction as one occurrence of a
 * recurring series (see createRecurringTransactions below) — omit both for a
 * normal one-off transaction. Editing a series transaction must pass through
 * whatever seriesId/seriesIndex it already had (see entry.js) or the edit
 * will silently detach it from its series, since this always fully replaces
 * the stored record rather than merging into it.
 *
 * `type: 'transfer'` moves money between two of the user's own accounts —
 * `accountId` is the source, `toAccountId` (required, must differ from
 * accountId) is the destination. Transfers are excluded from income/expense
 * totals everywhere (Summary, Dashboard) simply by not being 'income' or
 * 'expense' — no extra filtering needed for that.
 */
export async function saveTransaction({ id, date, type, accountId, toAccountId, description, statedTotal, seriesId, seriesIndex }, lineItems) {
  if (!date) throw new Error('Date is required');
  if (type !== 'expense' && type !== 'income' && type !== 'transfer') throw new Error('Type must be "expense", "income", or "transfer"');
  if (!accountId) throw new Error('Account is required');
  if (type === 'transfer') {
    if (!toAccountId) throw new Error('A destination account is required for a transfer');
    if (toAccountId === accountId) throw new Error('Transfer source and destination accounts must be different');
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw new Error('At least one line item is required');
  for (const li of lineItems) {
    if (!Number.isInteger(li.amount)) throw new Error('Every line item needs an amount');
    if (!Array.isArray(li.tagIds) || li.tagIds.length === 0) throw new Error('Every line item needs at least one tag');
  }
  if (statedTotal !== null && !Number.isInteger(statedTotal)) throw new Error('Stated total must be an integer paise amount or null');

  const db = await openDB();
  const tx = db.transaction(['transactions', 'lineItems'], 'readwrite');
  const txnStore = tx.objectStore('transactions');
  const liStore = tx.objectStore('lineItems');

  const txnRecord = { date, type, accountId, description: description || '', statedTotal };
  if (type === 'transfer') {
    txnRecord.toAccountId = toAccountId;
  }
  if (seriesId != null) {
    txnRecord.seriesId = seriesId;
    txnRecord.seriesIndex = seriesIndex;
  }
  let transactionId = id;
  if (id) {
    txnRecord.id = id;
    txnStore.put(txnRecord);
    const existing = await promisifyRequest(liStore.index('transactionId').getAll(id));
    for (const li of existing) liStore.delete(li.id);
  } else {
    transactionId = await promisifyRequest(txnStore.add(txnRecord));
  }
  for (const li of lineItems) {
    liStore.add({ transactionId, amount: li.amount, description: li.description || '', tagIds: li.tagIds });
  }
  await promisifyTransaction(tx);
  return transactionId;
}

export async function deleteTransaction(id) {
  const db = await openDB();
  const tx = db.transaction(['transactions', 'lineItems'], 'readwrite');
  tx.objectStore('transactions').delete(id);
  const liStore = tx.objectStore('lineItems');
  const existing = await promisifyRequest(liStore.index('transactionId').getAll(id));
  for (const li of existing) liStore.delete(li.id);
  await promisifyTransaction(tx);
}

// ---------- Recurring transactions ----------
//
// A "recurring transaction" is not its own concept in storage — it's just
// `count` normal single-line-item transactions, materialized up front and
// linked by a shared `seriesId` (with each one's position recorded in
// `seriesIndex`). That's what makes them exportable/importable and
// editable/deletable exactly like any other transaction (see saveTransaction
// above and js/list.js's per-row Edit/Delete, which offer a "this only" vs
// "this and future" choice whenever seriesId is present).

function addInterval(dateStr, unit, x) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (unit === 'weeks') {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 7 * x);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  // months -- clamp the day to the target month's length, e.g. Jan 31 + 1 month -> Feb 28.
  const totalMonths = m - 1 + x;
  const targetYear = y + Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(d, daysInTargetMonth);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

/**
 * Materializes a recurring series: `count` transactions (1-12), each with
 * exactly one line item (no splits), spaced `intervalX` (1-12)
 * `intervalUnit` ("weeks"|"months") apart, starting at `date`.
 * @returns {Promise<number[]>} the created transaction ids, in order
 */
export async function createRecurringTransactions({ date, type, accountId, description, amount, tagIds, intervalUnit, intervalX, count }) {
  if (intervalUnit !== 'weeks' && intervalUnit !== 'months') throw new Error('Interval unit must be "weeks" or "months"');
  if (!Number.isInteger(intervalX) || intervalX < 1 || intervalX > 12) throw new Error('Interval must be between 1 and 12');
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Number of occurrences must be between 1 and 12');

  const seriesId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids = [];
  let occurrenceDate = date;
  for (let i = 0; i < count; i++) {
    if (i > 0) occurrenceDate = addInterval(occurrenceDate, intervalUnit, intervalX);
    const id = await saveTransaction(
      { date: occurrenceDate, type, accountId, description, statedTotal: amount, seriesId, seriesIndex: i },
      [{ amount, description, tagIds }]
    );
    ids.push(id);
  }
  return ids;
}

// ---------- Backup / restore ----------

export async function exportAll() {
  const [accounts, tags, transactions, lineItems] = await Promise.all([
    getAll('accounts'),
    getAll('tags'),
    getAll('transactions'),
    getAll('lineItems'),
  ]);
  return {
    schema: 'expense-tracker',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    accounts,
    tags,
    transactions,
    lineItems,
  };
}

export async function importAll(data) {
  if (
    !data ||
    !Array.isArray(data.accounts) ||
    !Array.isArray(data.tags) ||
    !Array.isArray(data.transactions) ||
    !Array.isArray(data.lineItems)
  ) {
    throw new Error('Invalid backup file: expected accounts, tags, transactions, lineItems arrays');
  }
  const db = await openDB();
  const storeNames = ['accounts', 'tags', 'transactions', 'lineItems'];
  const tx = db.transaction(storeNames, 'readwrite');
  for (const name of storeNames) tx.objectStore(name).clear();
  for (const row of data.accounts) tx.objectStore('accounts').put(row);
  for (const row of data.tags) tx.objectStore('tags').put(row);
  for (const row of data.transactions) tx.objectStore('transactions').put(row);
  for (const row of data.lineItems) tx.objectStore('lineItems').put(row);
  await promisifyTransaction(tx);
}
