// Transaction list: newest first, expandable to show line items + tags,
// edit/delete, reconciliation-mismatch badge.

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function startOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export async function render(container, ctx) {
  const { notify, navigate } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));

  const fromInput = el('input', { type: 'date', value: startOfMonthISO() });
  const toInput = el('input', { type: 'date', value: todayISO() });
  root.appendChild(el('div', { class: 'card filter-bar' }, [field('From', fromInput), field('To', toInput)]));

  const listEl = el('div', { class: 'txn-list' });
  root.appendChild(listEl);
  container.appendChild(root);

  let [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  function renderList() {
    listEl.innerHTML = '';
    const from = fromInput.value;
    const to = toInput.value;
    const filtered = txns.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
    if (filtered.length === 0) {
      const message = txns.length === 0 ? 'No transactions yet. Add one from the Add tab.' : 'No transactions in this date range.';
      listEl.appendChild(el('p', { class: 'empty-state' }, message));
      return;
    }
    for (const txn of filtered) {
      listEl.appendChild(renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh }));
    }
  }

  async function refresh() {
    txns = await listTransactionsWithLineItems();
    renderList();
  }

  fromInput.addEventListener('change', renderList);
  toInput.addEventListener('change', renderList);

  renderList();
}

function renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh }) {
  const sum = txn.lineItems.reduce((s, li) => s + li.amount, 0);
  const mismatch = txn.statedTotal != null && sum !== txn.statedTotal;
  const account = accountsById.get(txn.accountId);

  const row = el('div', { class: 'txn-row' + (mismatch ? ' txn-mismatch' : '') });

  // Fall back to the first line item's description when the transaction
  // itself has none — common when a single-item purchase gets its
  // description typed on the item row instead of the transaction row.
  const displayDesc = txn.description || (txn.lineItems[0] && txn.lineItems[0].description) || '—';
  const header = el('div', { class: 'txn-row-header' }, [
    el('span', { class: 'txn-date' }, txn.date),
    el('span', { class: 'txn-account' }, account ? account.name : '(deleted account)'),
    el('span', { class: 'txn-desc' }, displayDesc),
    el('span', { class: `txn-amount ${txn.type === 'income' ? 'amount-income' : 'amount-expense'}` }, formatINR(txn.statedTotal ?? sum)),
  ]);
  if (mismatch) {
    header.appendChild(
      el('span', { class: 'badge badge-warning' }, `Needs reconciliation (Δ ${formatINR(Math.abs((txn.statedTotal ?? 0) - sum))})`)
    );
  }
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  row.appendChild(header);

  const itemsList = el('ul', { class: 'txn-line-items' });
  for (const li of txn.lineItems) {
    const tagNames = li.tagIds.map((id) => tagsById.get(id)).filter(Boolean);
    itemsList.appendChild(
      el('li', {}, [
        el('span', { class: 'li-amount' }, formatINR(li.amount)),
        el('span', { class: 'li-desc' }, li.description || '—'),
        el(
          'span',
          { class: 'li-tags' },
          tagNames.map((t) => el('span', { class: 'tag-chip tag-chip-readonly' }, t))
        ),
      ])
    );
  }

  const editBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Edit');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('entry', { editId: txn.id });
  });
  const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger' }, 'Delete');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete transaction on ${txn.date}${account ? ` (${account.name})` : ''}? This cannot be undone.`)) return;
    try {
      await deleteTransaction(txn.id);
      notify('Transaction deleted', 'success');
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  const details = el('div', { class: 'txn-details' }, [itemsList, el('div', { class: 'txn-actions' }, [editBtn, deleteBtn])]);
  row.appendChild(details);

  return row;
}
