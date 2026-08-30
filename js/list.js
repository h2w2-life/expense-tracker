// Transaction list: period/account/type/tag filters (shared shape with the
// old Analysis tab), a collapsible income/expense/net summary + by-account
// breakdown, a needs-reconciliation list, and the transaction rows
// themselves (expandable, edit/delete, reconciliation-mismatch badge).

import { listTransactionsWithLineItems, listAccounts, listTags, deleteTransaction } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';
import { mountTagFilterInput } from './tags.js';

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year, month, day) {
  const d = Math.min(day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addMonths(year, month, delta) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

// A statement cycle labeled by month M runs from `cycleStartDay` of the
// previous month through the day before `cycleStartDay` of month M.
function statementCyclePeriod(year, month, cycleStartDay) {
  const prev = addMonths(year, month, -1);
  const start = isoDate(prev.year, prev.month, cycleStartDay);
  const endDay = cycleStartDay === 1 ? daysInMonth(year, month) : cycleStartDay - 1;
  const end = isoDate(year, month, endDay);
  return { start, end };
}

export async function render(container, ctx) {
  const { notify, navigate, params = {} } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view list-view' });
  root.appendChild(el('h2', {}, 'Transactions'));

  // A round-trip through the Add/Edit form (see the `filters` param below)
  // carries a full snapshot of the filter state to restore. Absent that, an
  // account/tag link (from this tab or Settings) should show everything tied
  // to it, not just this month — only default to the current-month window on
  // a plain tab click.
  const savedFilters = params.filters || null;
  const hasLinkFilter = !savedFilters && (params.accountId != null || params.tagId != null);

  let [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  const now = new Date();
  const periodModeSelect = el('select', {}, [
    el('option', { value: 'month' }, 'Calendar month'),
    el('option', { value: 'cycle' }, 'Statement cycle'),
    el('option', { value: 'all' }, 'All time'),
  ]);
  periodModeSelect.value = savedFilters ? savedFilters.periodMode : hasLinkFilter ? 'all' : 'month';

  const monthInput = el('input', {
    type: 'month',
    value: (savedFilters && savedFilters.month) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  });
  const prevMonthBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon month-nav-btn' }, '◀');
  const nextMonthBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon month-nav-btn' }, '▶');
  function shiftMonth(delta) {
    const [y, m] = monthInput.value.split('-').map(Number);
    if (!y || !m) return;
    const next = addMonths(y, m, delta);
    monthInput.value = `${next.year}-${String(next.month).padStart(2, '0')}`;
    renderList();
  }
  prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
  nextMonthBtn.addEventListener('click', () => shiftMonth(1));

  const cycleAccounts = accounts.filter((a) => a.statementCycleStartDay);
  const cycleAccountSelect = el('select', {}, cycleAccounts.map((a) => el('option', { value: String(a.id) }, a.name)));
  if (savedFilters && savedFilters.cycleAccountId) cycleAccountSelect.value = savedFilters.cycleAccountId;

  const accountFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'All accounts'),
    ...accounts.map((a) => el('option', { value: String(a.id) }, a.name)),
  ]);
  if (savedFilters) accountFilterSelect.value = savedFilters.accountId || '';
  else if (params.accountId != null) accountFilterSelect.value = String(params.accountId);

  const typeFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'Expense + income'),
    el('option', { value: 'expense' }, 'Expense only'),
    el('option', { value: 'income' }, 'Income only'),
  ]);
  if (savedFilters) typeFilterSelect.value = savedFilters.type || '';

  const andTagsMount = el('div', { class: 'tag-filter-mount' });
  const notTagsMount = el('div', { class: 'tag-filter-mount' });

  const monthField = field('Month', el('div', { class: 'month-field-row' }, [prevMonthBtn, monthInput, nextMonthBtn]));
  monthField.classList.add('period-month-field');
  const cycleField = field('Cycle account', cycleAccountSelect);
  cycleField.classList.add('period-cycle-field');

  root.appendChild(
    el('div', { class: 'card filter-bar' }, [
      el('div', { class: 'filter-row filter-row-3' }, [field('Period', periodModeSelect), monthField, cycleField]),
      el('div', { class: 'filter-row filter-row-2' }, [field('Account', accountFilterSelect), field('Type', typeFilterSelect)]),
      el('div', { class: 'filter-row filter-row-2' }, [
        field('Tags — must have ALL of', andTagsMount),
        field('Tags — must have NONE of', notTagsMount),
      ]),
    ])
  );

  if (cycleAccounts.length === 0) {
    cycleField.appendChild(el('p', { class: 'field-hint' }, 'No accounts have a statement cycle day set (see Settings).'));
  }

  const andWidget = mountTagFilterInput(andTagsMount, tags, {
    initialIds: savedFilters ? savedFilters.andTagIds : params.tagId != null ? [params.tagId] : [],
  });
  const notWidget = mountTagFilterInput(notTagsMount, tags, {
    initialIds: savedFilters ? savedFilters.notTagIds : [],
  });

  function updatePeriodFieldVisibility() {
    const mode = periodModeSelect.value;
    monthField.hidden = mode === 'all';
    cycleField.hidden = mode !== 'cycle';
  }
  updatePeriodFieldVisibility();

  function currentPeriodRange() {
    const mode = periodModeSelect.value;
    if (mode === 'all') return null;
    if (mode === 'month') {
      const [y, m] = monthInput.value.split('-').map(Number);
      if (!y || !m) return null;
      return { start: isoDate(y, m, 1), end: isoDate(y, m, daysInMonth(y, m)) };
    }
    const account = accountsById.get(Number(cycleAccountSelect.value));
    if (!account || !account.statementCycleStartDay) return null;
    const [y, m] = monthInput.value.split('-').map(Number);
    if (!y || !m) return null;
    return statementCyclePeriod(y, m, account.statementCycleStartDay);
  }

  const summarySection = el('div', { class: 'card analysis-section collapsible' });
  const reconSection = el('div', { class: 'card analysis-section' });
  const listEl = el('div', { class: 'txn-list' });
  root.append(summarySection, reconSection, listEl);
  container.appendChild(root);

  let summaryExpanded = false;
  let reconExpanded = false;

  // Snapshot of every filter control, threaded through the Add/Edit form via
  // navigate('entry', { editId, filters }) and back via navigate('list',
  // { filters }) on save/cancel — otherwise editing a transaction drops the
  // filters back to the tab's plain defaults.
  function currentFiltersSnapshot() {
    return {
      periodMode: periodModeSelect.value,
      month: monthInput.value,
      cycleAccountId: cycleAccountSelect.value,
      accountId: accountFilterSelect.value,
      type: typeFilterSelect.value,
      andTagIds: andWidget.getSelectedIds(),
      notTagIds: notWidget.getSelectedIds(),
    };
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

  function renderList() {
    const range = currentPeriodRange();
    const accountFilter = accountFilterSelect.value ? Number(accountFilterSelect.value) : null;
    const typeFilter = typeFilterSelect.value || null;
    const andTagIds = andWidget.getSelectedIds();
    const notTagIds = notWidget.getSelectedIds();

    const filtered = txns.filter((t) => {
      if (range && (t.date < range.start || t.date > range.end)) return false;
      if (accountFilter && t.accountId !== accountFilter) return false;
      if (typeFilter && t.type !== typeFilter) return false;
      if (andTagIds.length && !andTagIds.every((id) => t.lineItems.some((li) => li.tagIds.includes(id)))) return false;
      if (notTagIds.length && notTagIds.some((id) => t.lineItems.some((li) => li.tagIds.includes(id)))) return false;
      return true;
    });

    renderSummary(summarySection, filtered, accountsById, {
      expanded: summaryExpanded,
      onToggle: () => {
        summaryExpanded = !summaryExpanded;
        renderList();
      },
      onTypeClick: (type) => {
        typeFilterSelect.value = type;
        renderList();
      },
      onAccountClick: (accId) => {
        accountFilterSelect.value = String(accId);
        renderList();
      },
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
          addTagFilter: andWidget.addSelectedId,
          getFilters: currentFiltersSnapshot,
        })
      );
    }
  }

  async function refresh() {
    txns = await listTransactionsWithLineItems();
    renderRecon();
    renderList();
  }

  periodModeSelect.addEventListener('change', () => {
    updatePeriodFieldVisibility();
    renderList();
  });
  monthInput.addEventListener('change', renderList);
  cycleAccountSelect.addEventListener('change', renderList);
  accountFilterSelect.addEventListener('change', renderList);
  typeFilterSelect.addEventListener('change', renderList);
  andWidget.onChange(renderList);
  notWidget.onChange(renderList);

  // Reconciliation scans every transaction regardless of the period/account/
  // tag filters above — it's a standing "needs attention" list, not a view
  // of the currently filtered set.
  renderRecon();
  renderList();
}

function renderSummary(section, filteredTxns, accountsById, { expanded, onToggle, onTypeClick, onAccountClick }) {
  section.innerHTML = '';
  section.classList.toggle('expanded', expanded);

  const lineItems = [];
  for (const t of filteredTxns) {
    for (const li of t.lineItems) lineItems.push({ ...li, type: t.type, accountId: t.accountId });
  }
  const income = lineItems.filter((li) => li.type === 'income').reduce((s, li) => s + li.amount, 0);
  const expense = lineItems.filter((li) => li.type === 'expense').reduce((s, li) => s + li.amount, 0);

  const incomeLink = el('button', { type: 'button', class: 'link-chip amount-income' }, formatINR(income));
  incomeLink.addEventListener('click', (e) => {
    e.stopPropagation();
    onTypeClick('income');
  });
  const expenseLink = el('button', { type: 'button', class: 'link-chip amount-expense' }, formatINR(expense));
  expenseLink.addEventListener('click', (e) => {
    e.stopPropagation();
    onTypeClick('expense');
  });
  const netLink = el('button', { type: 'button', class: 'link-chip' }, formatINR(income - expense));
  netLink.addEventListener('click', (e) => {
    e.stopPropagation();
    onTypeClick('');
  });

  const header = el('div', { class: 'collapsible-header' }, [
    el('h3', {}, 'Summary'),
    el('span', { class: 'collapsible-toggle' }, expanded ? '▲' : '▼'),
  ]);
  header.addEventListener('click', onToggle);
  section.appendChild(header);

  section.appendChild(
    el('div', { class: 'summary-grid' }, [
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Income'), el('div', { class: 'summary-value' }, incomeLink)]),
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Expense'), el('div', { class: 'summary-value' }, expenseLink)]),
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Net'), el('div', { class: 'summary-value' }, netLink)]),
    ])
  );

  if (!expanded) return;

  if (lineItems.length === 0) {
    section.appendChild(el('p', { class: 'empty-state' }, 'No line items match the current filters.'));
    return;
  }

  const byAccount = new Map();
  for (const li of lineItems) {
    if (!byAccount.has(li.accountId)) byAccount.set(li.accountId, { income: 0, expense: 0 });
    const bucket = byAccount.get(li.accountId);
    if (li.type === 'income') bucket.income += li.amount;
    else bucket.expense += li.amount;
  }
  section.appendChild(el('h4', {}, 'By account'));
  const tbody = el('tbody');
  for (const [accId, bucket] of byAccount) {
    const acc = accountsById.get(accId);
    tbody.appendChild(
      el('tr', {}, [
        el(
          'td',
          {},
          acc
            ? el('button', { type: 'button', class: 'txn-account link-chip', onclick: () => onAccountClick(accId) }, acc.name)
            : '(deleted account)'
        ),
        el('td', { class: 'amount-income' }, formatINR(bucket.income)),
        el('td', { class: 'amount-expense' }, formatINR(bucket.expense)),
      ])
    );
  }
  section.appendChild(
    el('table', { class: 'analysis-table' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Account'), el('th', {}, 'Income'), el('th', {}, 'Expense')])),
      tbody,
    ])
  );
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
