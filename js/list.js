// Transaction list: newest first, expandable to show line items + tags,
// edit/delete, reconciliation-mismatch badge.

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';
import { mountTagFilterInput } from './tags.js';

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
  const { notify, navigate, params = {} } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));

  // Arriving via an account/tag link (from this tab or Settings) should show
  // everything tied to it, not just this month — only default to the
  // current-month window on a plain tab click.
  const hasLinkFilter = params.accountId != null || params.tagId != null;
  const fromInput = el('input', { type: 'date', value: params.from || (hasLinkFilter ? '' : startOfMonthISO()) });
  const toInput = el('input', { type: 'date', value: params.to || (hasLinkFilter ? '' : todayISO()) });

  let [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  const accountFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'All accounts'),
    ...accounts.map((a) => el('option', { value: String(a.id) }, a.name)),
  ]);
  if (params.accountId != null) accountFilterSelect.value = String(params.accountId);

  const typeFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'Expense + income'),
    el('option', { value: 'expense' }, 'Expense only'),
    el('option', { value: 'income' }, 'Income only'),
  ]);

  const tagFilterMount = el('div', { class: 'tag-filter-mount' });

  root.appendChild(
    el('div', { class: 'card filter-bar' }, [
      field('From', fromInput),
      field('To', toInput),
      field('Account', accountFilterSelect),
      field('Type', typeFilterSelect),
      field('Tags — must have ALL of', tagFilterMount),
    ])
  );

  const tagWidget = mountTagFilterInput(tagFilterMount, tags, {
    initialIds: params.tagId != null ? [params.tagId] : [],
  });

  const listEl = el('div', { class: 'txn-list' });
  root.appendChild(listEl);
  container.appendChild(root);

  function renderList() {
    listEl.innerHTML = '';
    const from = fromInput.value;
    const to = toInput.value;
    const accountFilter = accountFilterSelect.value ? Number(accountFilterSelect.value) : null;
    const typeFilter = typeFilterSelect.value || null;
    const tagFilterIds = tagWidget.getSelectedIds();
    const filtered = txns.filter((t) => {
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (accountFilter && t.accountId !== accountFilter) return false;
      if (typeFilter && t.type !== typeFilter) return false;
      if (tagFilterIds.length && !tagFilterIds.every((id) => t.lineItems.some((li) => li.tagIds.includes(id)))) return false;
      return true;
    });
    if (filtered.length === 0) {
      const message = txns.length === 0 ? 'No transactions yet. Add one from the Add tab.' : 'No transactions match the current filters.';
      listEl.appendChild(el('p', { class: 'empty-state' }, message));
      return;
    }
    for (const txn of filtered) {
      listEl.appendChild(renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh, addTagFilter: tagWidget.addSelectedId }));
    }
  }

  async function refresh() {
    txns = await listTransactionsWithLineItems();
    renderList();
  }

  fromInput.addEventListener('change', renderList);
  toInput.addEventListener('change', renderList);
  accountFilterSelect.addEventListener('change', renderList);
  typeFilterSelect.addEventListener('change', renderList);
  tagWidget.onChange(renderList);

  renderList();
}

function renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh, addTagFilter }) {
  const sum = txn.lineItems.reduce((s, li) => s + li.amount, 0);
  const mismatch = txn.statedTotal != null && sum !== txn.statedTotal;
  const account = accountsById.get(txn.accountId);

  // Split transactions (more than one line item) are worth seeing at a
  // glance without an extra click; single-item ones stay collapsed since
  // the fallback description already shows what it is.
  const startExpanded = txn.lineItems.length > 1;
  const row = el('div', { class: 'txn-row' + (mismatch ? ' txn-mismatch' : '') + (startExpanded ? ' expanded' : '') });

  // Fall back to the first line item's description when the transaction
  // itself has none — common when a single-item purchase gets its
  // description typed on the item row instead of the transaction row.
  const displayDesc = txn.description || (txn.lineItems[0] && txn.lineItems[0].description) || '—';

  const accountLink = el(
    'button',
    { type: 'button', class: 'txn-account link-chip' },
    account ? account.name : '(deleted account)'
  );
  accountLink.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('list', { accountId: txn.accountId });
  });

  const header = el('div', { class: 'txn-row-header' }, [
    el('span', { class: 'txn-date' }, txn.date),
    accountLink,
    el('span', { class: 'txn-desc' }, displayDesc),
    el('span', { class: `txn-amount ${txn.type === 'income' ? 'amount-income' : 'amount-expense'}` }, formatINR(txn.statedTotal ?? sum)),
  ]);

  if (txn.lineItems.length > 1) {
    header.appendChild(el('span', { class: 'badge badge-split' }, `Split (${txn.lineItems.length})`));
  } else if (txn.lineItems[0]) {
    const li = txn.lineItems[0];
    const tagsContainer = el('span', { class: 'txn-row-tags' });
    const tagChips = li.tagIds
      .filter((id) => tagsById.has(id))
      .map((id) => {
        const chip = el('button', { type: 'button', class: 'tag-chip tag-chip-link' }, tagsById.get(id));
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          addTagFilter(id);
        });
        return chip;
      });
    tagsContainer.appendChild(...tagChips);
    header.appendChild(tagsContainer);
  }

  if (mismatch) {
    header.appendChild(
      el('span', { class: 'badge badge-warning' }, `Needs reconciliation (Δ ${formatINR(Math.abs((txn.statedTotal ?? 0) - sum))})`)
    );
  }
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  row.appendChild(header);

  const itemsList = el('ul', { class: 'txn-line-items' });
  for (const li of txn.lineItems) {
    const tagChips = li.tagIds
      .filter((id) => tagsById.has(id))
      .map((id) => {
        const chip = el('button', { type: 'button', class: 'tag-chip tag-chip-link' }, tagsById.get(id));
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          addTagFilter(id);
        });
        return chip;
      });
    itemsList.appendChild(
      el('li', {}, [
        el('span', { class: 'li-amount' }, formatINR(li.amount)),
        el('span', { class: 'li-desc' }, li.description || '—'),
        el('span', { class: 'li-tags' }, tagChips),
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
