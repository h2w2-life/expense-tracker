// Analysis tab: income/expense summary, by-account breakdown, tag AND/NOT
// filter, calendar-month or statement-cycle date range, and a standing
// needs-reconciliation list.

import { listTransactionsWithLineItems, listAccounts, listTags } from './db.js';
import { formatINR } from './money.js';
import { el, field } from './dom.js';

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
  const { navigate } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view analysis-view' });
  root.appendChild(el('h2', {}, 'Analysis'));
  container.appendChild(root);

  const [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  const allLineItems = [];
  for (const txn of txns) {
    for (const li of txn.lineItems) {
      allLineItems.push({ ...li, date: txn.date, type: txn.type, accountId: txn.accountId });
    }
  }

  const now = new Date();
  const periodModeSelect = el('select', {}, [
    el('option', { value: 'month' }, 'Calendar month'),
    el('option', { value: 'cycle' }, 'Statement cycle'),
    el('option', { value: 'all' }, 'All time'),
  ]);
  const monthInput = el('input', { type: 'month', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` });
  const cycleAccounts = accounts.filter((a) => a.statementCycleStartDay);
  const cycleAccountSelect = el('select', {}, cycleAccounts.map((a) => el('option', { value: String(a.id) }, a.name)));
  const accountFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'All accounts'),
    ...accounts.map((a) => el('option', { value: String(a.id) }, a.name)),
  ]);
  const andTagsMount = el('div', { class: 'tag-filter-mount' });
  const notTagsMount = el('div', { class: 'tag-filter-mount' });

  const monthField = field('Month', monthInput);
  monthField.classList.add('period-month-field');
  const cycleField = field('Cycle account', cycleAccountSelect);
  cycleField.classList.add('period-cycle-field');

  const filterBar = el('div', { class: 'card filter-bar' }, [
    field('Period', periodModeSelect),
    monthField,
    cycleField,
    field('Account filter', accountFilterSelect),
    field('Tags — must have ALL of', andTagsMount),
    field('Tags — must have NONE of', notTagsMount),
  ]);
  root.appendChild(filterBar);

  if (cycleAccounts.length === 0) {
    cycleField.appendChild(el('p', { class: 'field-hint' }, 'No accounts have a statement cycle day set (see Settings).'));
  }

  const summarySection = el('div', { class: 'analysis-section card' });
  const reconSection = el('div', { class: 'analysis-section card' });
  root.append(summarySection, reconSection);

  const andWidget = mountTagFilterInput(andTagsMount, tags);
  const notWidget = mountTagFilterInput(notTagsMount, tags);

  function updatePeriodFieldVisibility() {
    const mode = periodModeSelect.value;
    monthField.hidden = mode !== 'month';
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

  function recompute() {
    const range = currentPeriodRange();
    const accountFilter = accountFilterSelect.value ? Number(accountFilterSelect.value) : null;
    const andTagIds = andWidget.getSelectedIds();
    const notTagIds = notWidget.getSelectedIds();

    const filtered = allLineItems.filter((li) => {
      if (range && (li.date < range.start || li.date > range.end)) return false;
      if (accountFilter && li.accountId !== accountFilter) return false;
      if (andTagIds.length && !andTagIds.every((id) => li.tagIds.includes(id))) return false;
      if (notTagIds.length && notTagIds.some((id) => li.tagIds.includes(id))) return false;
      return true;
    });
    renderSummary(summarySection, filtered, accountsById);
  }

  periodModeSelect.addEventListener('change', () => {
    updatePeriodFieldVisibility();
    recompute();
  });
  monthInput.addEventListener('change', recompute);
  cycleAccountSelect.addEventListener('change', recompute);
  accountFilterSelect.addEventListener('change', recompute);
  andWidget.onChange(recompute);
  notWidget.onChange(recompute);

  recompute();
  renderReconciliation(reconSection, txns, accountsById, navigate);
}

function renderSummary(section, lineItems, accountsById) {
  section.innerHTML = '';
  section.appendChild(el('h3', {}, 'Summary'));
  const income = lineItems.filter((li) => li.type === 'income').reduce((s, li) => s + li.amount, 0);
  const expense = lineItems.filter((li) => li.type === 'expense').reduce((s, li) => s + li.amount, 0);
  section.appendChild(
    el('div', { class: 'summary-grid' }, [
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Income'), el('div', { class: 'summary-value amount-income' }, formatINR(income))]),
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Expense'), el('div', { class: 'summary-value amount-expense' }, formatINR(expense))]),
      el('div', { class: 'summary-stat' }, [el('div', { class: 'summary-label' }, 'Net'), el('div', { class: 'summary-value' }, formatINR(income - expense))]),
    ])
  );

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
        el('td', {}, acc ? acc.name : '(deleted account)'),
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

function renderReconciliation(section, txns, accountsById, navigate) {
  section.innerHTML = '';
  section.appendChild(el('h3', {}, 'Needs reconciliation'));
  const mismatched = txns.filter((t) => {
    const sum = t.lineItems.reduce((s, li) => s + li.amount, 0);
    return t.statedTotal != null && sum !== t.statedTotal;
  });
  if (mismatched.length === 0) {
    section.appendChild(el('p', { class: 'empty-state' }, 'Everything reconciles. Nothing to review.'));
    return;
  }
  const list = el('div', { class: 'txn-list' });
  for (const t of mismatched) {
    const sum = t.lineItems.reduce((s, li) => s + li.amount, 0);
    const acc = accountsById.get(t.accountId);
    const editBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Edit');
    editBtn.addEventListener('click', () => navigate('entry', { editId: t.id }));
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

// Multi-select tag chip filter — picks from existing tags only, no free
// text creation (unlike the entry-form tag input in tags.js).
function mountTagFilterInput(container, allTags) {
  const selected = new Set();
  let changeHandler = () => {};
  const chipList = el('div', { class: 'tag-chip-list' });
  const select = el('select', {}, [el('option', { value: '' }, 'Add tag…'), ...allTags.map((t) => el('option', { value: String(t.id) }, t.name))]);
  container.appendChild(el('div', { class: 'tag-filter' }, [chipList, select]));

  function renderChips() {
    chipList.innerHTML = '';
    for (const id of selected) {
      const tag = allTags.find((t) => t.id === id);
      if (!tag) continue;
      const removeBtn = el('button', { type: 'button', class: 'tag-chip-remove' }, '✕');
      removeBtn.addEventListener('click', () => {
        selected.delete(id);
        renderChips();
        changeHandler();
      });
      chipList.appendChild(el('span', { class: 'tag-chip' }, [tag.name, removeBtn]));
    }
  }

  select.addEventListener('change', () => {
    const id = Number(select.value);
    if (id) {
      selected.add(id);
      select.value = '';
      renderChips();
      changeHandler();
    }
  });

  return {
    getSelectedIds: () => Array.from(selected),
    onChange: (fn) => {
      changeHandler = fn;
    },
  };
}
