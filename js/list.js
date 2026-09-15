// Transaction list: shared period/account/type/tag filters (see filters.js),
// date/amount sorting, a needs-reconciliation list, and the transaction rows
// themselves (expandable, edit/delete, reconciliation-mismatch badge).

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';
import { mountTransactionFilters } from './filters.js';
import { askSeriesScope, openSeriesFutureEditDialog, applySeriesFuturePatch, mountRecurringButton } from './recurring.js';
import { mountAddButton } from './entry.js';
import { mountTransferButton, openTransferEditDialog } from './transfer.js';

export async function render(container, ctx) {
  const { notify, navigate, params = {} } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));

  let [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  root.appendChild(
    el('div', { class: 'tab-actions' }, [
      mountAddButton({ notify, onSaved: () => refresh() }),
      mountRecurringButton({ notify, onCreated: () => refresh() }),
      mountTransferButton({ notify, onSaved: () => refresh() }),
    ])
  );

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
  if (params.filters && params.filters.sortField) sortFieldSelect.value = params.filters.sortField;
  const sortDirSelect = el('select', {}, [
    el('option', { value: 'desc' }, 'Descending'),
    el('option', { value: 'asc' }, 'Ascending'),
  ]);
  if (params.filters && params.filters.sortDir) sortDirSelect.value = params.filters.sortDir;
  root.appendChild(
    el('div', { class: 'card filter-bar' }, [
      el('div', { class: 'filter-row filter-row-2' }, [field('Sort by', sortFieldSelect), field('Direction', sortDirSelect)]),
    ])
  );

  const reconSection = el('div', { class: 'card analysis-section' });
  const listEl = el('div', { class: 'txn-list' });
  const listSection = el('div', { class: 'card' }, [listEl]);
  root.append(reconSection, listSection);
  container.appendChild(root);

  let reconExpanded = false;

  // filters.getState() alone doesn't cover sort — that's a Transactions-only
  // concept, not part of the shared filters.js module — so round-tripping a
  // transaction through the edit form (see js/entry.js's `filters` param)
  // would otherwise silently reset Sort by/Direction back to their defaults.
  function currentFiltersSnapshot() {
    return { ...filters.getState(), sortField: sortFieldSelect.value, sortDir: sortDirSelect.value };
  }

  function renderRecon() {
    renderReconciliation(reconSection, txns, accountsById, navigate, {
      expanded: reconExpanded,
      onToggle: () => {
        reconExpanded = !reconExpanded;
        renderRecon();
      },
      getFilters: currentFiltersSnapshot,
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
      const message = txns.length === 0 ? 'No transactions yet. Use the Add button above to create one.' : 'No transactions match the current filters.';
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
          getFilters: currentFiltersSnapshot,
          getAllTxns: () => txns,
          matchesLineItem: filters.matchesLineItem,
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

function renderTxnRow(txn, accountsById, tagsById, { notify, navigate, refresh, addTagFilter, getFilters, getAllTxns, matchesLineItem }) {
  const sum = txn.lineItems.reduce((s, li) => s + li.amount, 0);
  const mismatch = txn.statedTotal != null && sum !== txn.statedTotal;
  const account = accountsById.get(txn.accountId);

  // A split transaction can appear in the list because just one of its
  // items matches the active tag filters — the breakdown below should only
  // show that matching item, not every sibling under the same parent.
  // Header-level facts (total, split badge, reconciliation) still describe
  // the whole transaction regardless.
  const displayLineItems = txn.lineItems.filter((li) => matchesLineItem(li, txn));

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

  const headerParts = [el('span', { class: 'txn-date' }, txn.date), accountLink];

  if (txn.type === 'transfer') {
    const toAccount = accountsById.get(txn.toAccountId);
    const toLink = el(
      'button',
      { type: 'button', class: 'txn-account link-chip' },
      toAccount ? toAccount.name : '(deleted account)'
    );
    toLink.addEventListener('click', (e) => {
      e.stopPropagation();
      navigate('list', { accountId: txn.toAccountId });
    });
    headerParts.push(el('span', { class: 'txn-transfer-arrow' }, '→'), toLink);
  }

  headerParts.push(
    el('span', { class: 'txn-desc' }, displayDesc),
    el(
      'span',
      { class: `txn-amount ${txn.type === 'income' ? 'amount-income' : txn.type === 'transfer' ? 'amount-transfer' : 'amount-expense'}` },
      formatINR(txn.statedTotal ?? sum)
    )
  );

  const header = el('div', { class: 'txn-row-header' }, headerParts);

  if (txn.type === 'transfer') {
    header.appendChild(el('span', { class: 'badge badge-transfer' }, 'Transfer'));
  }
  if (txn.lineItems.length > 1) {
    header.appendChild(el('span', { class: 'badge badge-split' }, `Split (${txn.lineItems.length})`));
  }
  if (txn.seriesId != null) {
    header.appendChild(el('span', { class: 'badge badge-recurring' }, 'Recurring'));
  }

  if (mismatch) {
    header.appendChild(
      el('span', { class: 'badge badge-warning' }, `Needs reconciliation (Δ ${formatINR(Math.abs((txn.statedTotal ?? 0) - sum))})`)
    );
  }
  header.addEventListener('click', () => row.classList.toggle('expanded'));
  row.appendChild(header);

  // All tags across every matching line item (not just the first), deduped
  // and alphabetized — a split transaction's tags are otherwise invisible
  // without expanding it.
  const allTagIds = [...new Set(displayLineItems.flatMap((li) => li.tagIds))].filter((id) => tagsById.has(id));
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
  for (const li of displayLineItems) {
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

  // Every occurrence of a series shares seriesId; seriesIndex orders them —
  // "this and future" means this one plus every later index in the series.
  function futureSeriesTxns() {
    return getAllTxns()
      .filter((t) => t.seriesId === txn.seriesId && t.seriesIndex >= txn.seriesIndex)
      .sort((a, b) => a.seriesIndex - b.seriesIndex);
  }

  const editBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Edit');
  editBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (txn.type === 'transfer') {
      openTransferEditDialog({ notify, txn, onSaved: refresh });
      return;
    }
    if (txn.seriesId == null) {
      navigate('entry', { editId: txn.id, filters: getFilters() });
      return;
    }
    const scope = await askSeriesScope('This is part of a recurring series. Edit just this occurrence, or this and all future occurrences?', {
      thisLabel: 'This occurrence only',
      futureLabel: 'This and all future',
    });
    if (scope === 'this') {
      navigate('entry', { editId: txn.id, filters: getFilters() });
    } else if (scope === 'future') {
      const li = txn.lineItems[0];
      openSeriesFutureEditDialog({
        seed: {
          type: txn.type,
          accountId: txn.accountId,
          description: txn.description || (li && li.description) || '',
          amount: li ? li.amount : 0,
          tagNames: li ? li.tagIds.map((id) => tagsById.get(id)).filter(Boolean) : [],
        },
        notify,
        onSave: async (patch) => {
          const future = futureSeriesTxns();
          try {
            await applySeriesFuturePatch(future, patch);
            notify(`Updated ${future.length} transaction${future.length === 1 ? '' : 's'}`, 'success');
            refresh();
          } catch (err) {
            notify(err.message, 'error');
          }
        },
      });
    }
  });

  const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger' }, 'Delete');
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (txn.seriesId == null) {
      if (!confirm(`Delete transaction on ${txn.date}${account ? ` (${account.name})` : ''}? This cannot be undone.`)) return;
      try {
        await deleteTransaction(txn.id);
        notify('Transaction deleted', 'success');
        refresh();
      } catch (err) {
        notify(err.message, 'error');
      }
      return;
    }
    const scope = await askSeriesScope('This is part of a recurring series. Delete just this occurrence, or this and all future occurrences?', {
      thisLabel: 'This occurrence only',
      futureLabel: 'This and all future',
    });
    if (!scope) return;
    const toDelete = scope === 'this' ? [txn] : futureSeriesTxns();
    const label =
      scope === 'this' ? `the transaction on ${txn.date}` : `${toDelete.length} transaction${toDelete.length === 1 ? '' : 's'} (this and all future occurrences)`;
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      for (const t of toDelete) await deleteTransaction(t.id);
      notify(toDelete.length === 1 ? 'Transaction deleted' : `${toDelete.length} transactions deleted`, 'success');
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  const details = el('div', { class: 'txn-details' }, [itemsList, el('div', { class: 'txn-actions' }, [editBtn, deleteBtn])]);
  row.appendChild(details);

  return row;
}
