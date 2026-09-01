// Transaction list: shared period/account/type/tag filters (see filters.js),
// date/amount sorting, a needs-reconciliation list, and the transaction rows
// themselves (expandable, edit/delete, reconciliation-mismatch badge).

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';
import { mountTransactionFilters } from './filters.js';

export async function render(container, ctx) {
  const { notify, navigate, params = {} } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));

  let [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  // A round-trip through the Add/Edit form (see the `filters` param) carries
  // a full filter-state snapshot to restore — see filters.js's getState()
  // for the shape. Absent that, an account/tag link (from this tab or
  // Settings) should show everything tied to it, not just this month — only
  // default to the current-month window on a plain tab click.
  const hasLinkFilter = params.accountId != null || params.tagId != null;
  const initialFilters = params.filters || {
    periodMode: hasLinkFilter ? 'all' : 'month',
    accountId: params.accountId,
    andTagIds: params.tagId != null ? [params.tagId] : [],
  };

  const filterMount = el('div');
  root.appendChild(filterMount);
  const filters = mountTransactionFilters(filterMount, {
    accounts,
    tags,
    lineItems: txns.flatMap((t) => t.lineItems),
    initial: initialFilters,
  });

  const sortFieldSelect = el('select', {}, [
    el('option', { value: 'date' }, 'Date'),
    el('option', { value: 'amount' }, 'Amount'),
  ]);
  const sortDirSelect = el('select', {}, [
    el('option', { value: 'desc' }, 'Descending'),
    el('option', { value: 'asc' }, 'Ascending'),
  ]);
  root.appendChild(
    el('div', { class: 'card filter-bar' }, [
      el('div', { class: 'filter-row filter-row-2' }, [field('Sort by', sortFieldSelect), field('Direction', sortDirSelect)]),
    ])
  );

  const reconSection = el('div', { class: 'card analysis-section' });
  const listEl = el('div', { class: 'txn-list' });
  root.append(reconSection, listEl);
  container.appendChild(root);

  let reconExpanded = false;

  function renderRecon() {
    renderReconciliation(reconSection, txns, accountsById, navigate, {
      expanded: reconExpanded,
      onToggle: () => {
        reconExpanded = !reconExpanded;
        renderRecon();
      },
      getFilters: filters.getState,
    });
  }

  function txnTotal(t) {
    return t.statedTotal ?? t.lineItems.reduce((s, li) => s + li.amount, 0);
  }

  function renderList() {
    const filtered = txns.filter((t) => filters.matchesTransaction(t));

    const sortField = sortFieldSelect.value;
    const dir = sortDirSelect.value === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const av = sortField === 'amount' ? txnTotal(a) : a.date;
      const bv = sortField === 'amount' ? txnTotal(b) : b.date;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    listEl.innerHTML = '';
    if (filtered.length === 0) {
      const message = txns.length === 0 ? 'No transactions yet. Add one from the Add tab.' : 'No transactions match the current filters.';
      listEl.appendChild(el('p', { class: 'empty-state' }, message));
      return;
    }
    for (const txn of filtered) {
      listEl.appendChild(
        renderTxnRow(txn, accountsById, tagsById, {
          notify,
          navigate,
          refresh,
          addTagFilter: filters.addAndTagFilter,
          getFilters: filters.getState,
        })
      );
    }
  }

  async function refresh() {
    txns = await listTransactionsWithLineItems();
    renderRecon();
    renderList();
  }

  filters.onChange(renderList);
  sortFieldSelect.addEventListener('change', renderList);
  sortDirSelect.addEventListener('change', renderList);

  // Reconciliation scans every transaction regardless of the filters above
  // — it's a standing "needs attention" list, not a view of the filtered set.
  renderRecon();
  renderList();
}

function renderReconciliation(section, txns, accountsById, navigate, { expanded, onToggle, getFilters }) {
  section.innerHTML = '';

  const mismatched = txns.filter((t) => {
    const sum = t.lineItems.reduce((s, li) => s + li.amount, 0);
    return t.statedTotal != null && sum !== t.statedTotal;
  });

  // Nothing to reconcile — the section is noise, not a status to report.
  section.hidden = mismatched.length === 0;
  if (mismatched.length === 0) return;

  section.classList.toggle('expanded', expanded);

  const header = el('div', { class: 'collapsible-header' }, [
    el('h3', {}, 'Needs reconciliation'),
    el('span', { class: 'collapsible-toggle' }, expanded ? '▲' : '▼'),
  ]);
  header.addEventListener('click', onToggle);
  section.appendChild(header);

  if (!expanded) return;

  const list = el('div', { class: 'txn-list' });
  for (const t of mismatched) {
    const sum = t.lineItems.reduce((s, li) => s + li.amount, 0);
    const acc = accountsById.get(t.accountId);
    const editBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Edit');
    editBtn.addEventListener('click', () => navigate('entry', { editId: t.id, filters: getFilters() }));
    list.appendChild(
      el('div', { class: 'txn-row txn-mismatch' }, [
        el('div', { class: 'txn-row-header' }, [
          el('span', { class: 'txn-date' }, t.date),
          el('span', { class: 'txn-account' }, acc ? acc.name : '(deleted account)'),
          el('span', { class: 'txn-desc' }, t.description || (t.lineItems[0] && t.lineItems[0].description) || '—'),
          el('span', { class: 'badge badge-warning' }, `Stated ${formatINR(t.statedTotal)} vs items ${formatINR(sum)}`),
          editBtn,
        ]),
      ])
    );
  }
  section.appendChild(list);
}

function renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh, addTagFilter, getFilters }) {
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
  }

  if (mismatch) {
    header.appendChild(
      el('span', { class: 'badge badge-warning' }, `Needs reconciliation (Δ ${formatINR(Math.abs((txn.statedTotal ?? 0) - sum))})`)
    );
  }
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  row.appendChild(header);

  // All tags across every line item (not just the first), deduped and
  // alphabetized — a split transaction's tags are otherwise invisible
  // without expanding it.
  const allTagIds = [...new Set(txn.lineItems.flatMap((li) => li.tagIds))].filter((id) => tagsById.has(id));
  if (allTagIds.length > 0) {
    allTagIds.sort((a, b) => tagsById.get(a).localeCompare(tagsById.get(b)));
    const tagsLine = el('div', { class: 'txn-row-all-tags' });
    for (const id of allTagIds) {
      const chip = el('button', { type: 'button', class: 'tag-chip tag-chip-link' }, tagsById.get(id));
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        addTagFilter(id);
      });
      tagsLine.appendChild(chip);
    }
    row.appendChild(tagsLine);
  }

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
    navigate('entry', { editId: txn.id, filters: getFilters() });
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
