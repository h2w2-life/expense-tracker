// Shared transaction-filter bar (period / account / type / tag AND+NONE)
// mounted by both the Transactions and Dashboard tabs, so filtering
// behavior and UI stay identical between them — a fix or tweak here applies
// to both.
//
// Tag semantics: ALL is AND (every selected tag must be present on the same
// line item); NONE is OR-exclusion (the item is dropped if it carries ANY
// of the selected NONE tags) — "004 and not (teju or bebu)", never
// "004 and not (teju and bebu)". The NONE dropdown only offers tags that
// could actually matter given the current ALL selection: a tag only shows
// up there if some line item in the whole dataset carries it alongside
// every currently-required ALL tag — otherwise excluding it would be a
// no-op and just adds noise to the list.

import { el, field } from './dom.js';
import { mountTagFilterInput } from './tags.js';

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isoDate(year, month, day) {
  const d = Math.min(day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addMonths(year, month, delta) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

// A statement cycle labeled by month M runs from `cycleStartDay` of the
// previous month through the day before `cycleStartDay` of month M.
export function statementCyclePeriod(year, month, cycleStartDay) {
  const prev = addMonths(year, month, -1);
  const start = isoDate(prev.year, prev.month, cycleStartDay);
  const endDay = cycleStartDay === 1 ? daysInMonth(year, month) : cycleStartDay - 1;
  const end = isoDate(year, month, endDay);
  return { start, end };
}

export function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   accounts: {id:number,name:string,statementCycleStartDay:?number}[],
 *   tags: {id:number,name:string}[],
 *   lineItems: {tagIds:number[]}[] - every line item in the DB (unfiltered),
 *     used only to work out which tags are worth offering in the NONE list.
 *   initial?: {periodMode?, month?, cycleAccountId?, accountId?, type?, andTagIds?, notTagIds?},
 * }} opts
 * @returns {{
 *   getState(): object,
 *   getPeriodRange(): {start:string,end:string}|null,
 *   matchesTransaction(txn): boolean,
 *   matchesLineItem(li, txn): boolean,
 *   onChange(fn: () => void): void,
 *   addAndTagFilter(id: number): void,
 *   setAccountFilter(id: number): void,
 *   setTypeFilter(type: string): void,
 * }}
 */
export function mountTransactionFilters(container, { accounts, tags, lineItems, initial = {} }) {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  let changeHandler = () => {};

  // Needed before periodModeSelect so the "Statement cycle" option can be
  // disabled up front when it wouldn't do anything — no account has a
  // statementCycleStartDay set, so that period mode would silently return
  // the whole-history range regardless of which month is picked.
  const cycleAccounts = accounts.filter((a) => a.statementCycleStartDay);

  const periodModeSelect = el('select', {}, [
    el('option', { value: 'month' }, 'Calendar month'),
    el('option', { value: 'cycle', disabled: cycleAccounts.length === 0 }, 'Statement cycle'),
    el('option', { value: 'all' }, 'All time'),
  ]);
  periodModeSelect.value = initial.periodMode === 'cycle' && cycleAccounts.length === 0 ? 'month' : initial.periodMode || 'month';

  const monthInput = el('input', { type: 'month', value: initial.month || currentMonthValue() });
  const prevMonthBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon month-nav-btn' }, '◀');
  const nextMonthBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon month-nav-btn' }, '▶');
  function shiftMonth(delta) {
    const [y, m] = monthInput.value.split('-').map(Number);
    if (!y || !m) return;
    const next = addMonths(y, m, delta);
    monthInput.value = `${next.year}-${String(next.month).padStart(2, '0')}`;
    changeHandler();
  }
  prevMonthBtn.addEventListener('click', () => shiftMonth(-1));
  nextMonthBtn.addEventListener('click', () => shiftMonth(1));

  const cycleAccountSelect = el('select', {}, cycleAccounts.map((a) => el('option', { value: String(a.id) }, a.name)));
  if (initial.cycleAccountId) cycleAccountSelect.value = initial.cycleAccountId;

  const accountFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'All accounts'),
    ...accounts.map((a) => el('option', { value: String(a.id) }, a.name)),
  ]);
  accountFilterSelect.value = initial.accountId != null ? String(initial.accountId) : '';

  const typeFilterSelect = el('select', {}, [
    el('option', { value: '' }, 'Expense + income'),
    el('option', { value: 'expense' }, 'Expense only'),
    el('option', { value: 'income' }, 'Income only'),
  ]);
  typeFilterSelect.value = initial.type || '';

  const andTagsMount = el('div', { class: 'tag-filter-mount' });
  const notTagsMount = el('div', { class: 'tag-filter-mount' });

  const monthField = field('Month', el('div', { class: 'month-field-row' }, [prevMonthBtn, monthInput, nextMonthBtn]));
  monthField.classList.add('period-month-field');
  const cycleField = field('Cycle account', cycleAccountSelect);
  cycleField.classList.add('period-cycle-field');

  const row1 = el('div', { class: 'filter-row filter-row-3' }, [field('Period', periodModeSelect), monthField, cycleField]);
  const row2 = el('div', { class: 'filter-row filter-row-2', hidden: true }, [field('Account', accountFilterSelect), field('Type', typeFilterSelect)]);
  const row3 = el(
    'div',
    { class: 'filter-row filter-row-2', hidden: true },
    [field('Tags — must have ALL of', andTagsMount), field('Tags — must have NONE of', notTagsMount)]
  );
  const toggleBtn = el('button', { type: 'button', class: 'btn btn-link filter-bar-toggle' }, 'More filters ▼');
  let filtersExpanded = false;
  toggleBtn.addEventListener('click', () => {
    filtersExpanded = !filtersExpanded;
    row2.hidden = !filtersExpanded;
    row3.hidden = !filtersExpanded;
    toggleBtn.textContent = filtersExpanded ? 'Fewer filters ▲' : 'More filters ▼';
  });

  container.appendChild(el('div', { class: 'card filter-bar' }, [row1, toggleBtn, row2, row3]));

  if (cycleAccounts.length === 0) {
    cycleField.appendChild(el('p', { class: 'field-hint' }, 'No accounts have a statement cycle day set (see Settings).'));
  }

  function updatePeriodFieldVisibility() {
    const mode = periodModeSelect.value;
    monthField.hidden = mode === 'all';
    cycleField.hidden = mode !== 'cycle';
  }
  updatePeriodFieldVisibility();

  function relevantNoneTags(andIds) {
    if (andIds.length === 0) return tags;
    return tags.filter((t) => lineItems.some((li) => li.tagIds.includes(t.id) && andIds.every((id) => li.tagIds.includes(id))));
  }

  const andWidget = mountTagFilterInput(andTagsMount, tags, { initialIds: initial.andTagIds || [] });

  let notWidget;
  function mountNoneWidget(preserveIds) {
    notTagsMount.innerHTML = '';
    const available = relevantNoneTags(andWidget.getSelectedIds());
    const availableIds = new Set(available.map((t) => t.id));
    notWidget = mountTagFilterInput(notTagsMount, available, { initialIds: preserveIds.filter((id) => availableIds.has(id)) });
    notWidget.onChange(() => changeHandler());
  }
  mountNoneWidget(initial.notTagIds || []);

  andWidget.onChange(() => {
    mountNoneWidget(notWidget.getSelectedIds());
    changeHandler();
  });

  function getPeriodRange() {
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

  function baseMatches(txn) {
    const range = getPeriodRange();
    const accountFilter = accountFilterSelect.value ? Number(accountFilterSelect.value) : null;
    const typeFilter = typeFilterSelect.value || null;
    if (range && (txn.date < range.start || txn.date > range.end)) return false;
    if (accountFilter && txn.accountId !== accountFilter) return false;
    if (typeFilter && txn.type !== typeFilter) return false;
    return true;
  }

  function matchesTransaction(txn) {
    if (!baseMatches(txn)) return false;
    const andTagIds = andWidget.getSelectedIds();
    const notTagIds = notWidget.getSelectedIds();
    if (andTagIds.length && !andTagIds.every((id) => txn.lineItems.some((li) => li.tagIds.includes(id)))) return false;
    if (notTagIds.length && notTagIds.some((id) => txn.lineItems.some((li) => li.tagIds.includes(id)))) return false;
    return true;
  }

  // Line-item-granular match — a split transaction can pass
  // matchesTransaction() via just one of its items, but totals (summary,
  // dashboard) should only count items that themselves carry the filtered
  // tags.
  function matchesLineItem(li, txn) {
    if (!baseMatches(txn)) return false;
    const andTagIds = andWidget.getSelectedIds();
    const notTagIds = notWidget.getSelectedIds();
    if (andTagIds.length && !andTagIds.every((id) => li.tagIds.includes(id))) return false;
    if (notTagIds.length && notTagIds.some((id) => li.tagIds.includes(id))) return false;
    return true;
  }

  function getState() {
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

  periodModeSelect.addEventListener('change', () => {
    updatePeriodFieldVisibility();
    changeHandler();
  });
  monthInput.addEventListener('change', () => changeHandler());
  cycleAccountSelect.addEventListener('change', () => changeHandler());
  accountFilterSelect.addEventListener('change', () => changeHandler());
  typeFilterSelect.addEventListener('change', () => changeHandler());

  return {
    getState,
    getPeriodRange,
    matchesTransaction,
    matchesLineItem,
    onChange: (fn) => {
      changeHandler = fn;
    },
    addAndTagFilter: (id) => andWidget.addSelectedId(id),
    setAccountFilter: (id) => {
      accountFilterSelect.value = String(id);
      changeHandler();
    },
    setTypeFilter: (type) => {
      typeFilterSelect.value = type;
      changeHandler();
    },
  };
}
