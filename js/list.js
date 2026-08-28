// Transaction list: newest first, expandable to show line items + tags,
// edit/delete, reconciliation-mismatch badge.

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el } from './dom.js';

export async function render(container, ctx) {
  const { notify, navigate } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));
  const listEl = el('div', { class: 'txn-list' });
  root.appendChild(listEl);
  container.appendChild(root);

  const [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  if (txns.length === 0) {
    listEl.appendChild(el('p', { class: 'empty-state' }, 'No transactions yet. Add one from the Add tab.'));
    return;
  }

  const refresh = () => render(container, ctx);
  for (const txn of txns) {
    listEl.appendChild(renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh }));
  }
}

function renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh }) {
  const sum = txn.lineItems.reduce((s, li) => s + li.amount, 0);
  const mismatch = txn.statedTotal != null && sum !== txn.statedTotal;
  const account = accountsById.get(txn.accountId);

  const row = el('div', { class: 'txn-row' + (mismatch ? ' txn-mismatch' : '') });

  const header = el('div', { class: 'txn-row-header' }, [
    el('span', { class: 'txn-date' }, txn.date),
    el('span', { class: 'txn-account' }, account ? account.name : '(deleted account)'),
    el('span', { class: 'txn-desc' }, txn.description || '—'),
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
