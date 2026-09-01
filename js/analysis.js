// Dashboard tab: shared filters (see filters.js — identical behavior to
// Transactions), the income/expense/net summary + by-account breakdown
// (moved here from Transactions), and a spend-by-tag bar chart.

import { listTransactionsWithLineItems, listAccounts, listTags } from './db.js';
import { formatINR } from './money.js';
import { el } from './dom.js';
import { mountTransactionFilters, currentMonthValue } from './filters.js';

export async function render(container, ctx) {
  const { navigate } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view analysis-view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  container.appendChild(root);

  const [txns, accounts, tags] = await Promise.all([listTransactionsWithLineItems(), listAccounts(), listTags()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const tagsById = new Map(tags.map((t) => [t.id, t.name]));

  const filterMount = el('div');
  root.appendChild(filterMount);
  const filters = mountTransactionFilters(filterMount, {
    accounts,
    tags,
    lineItems: txns.flatMap((t) => t.lineItems),
    initial: { periodMode: 'month', month: currentMonthValue(), type: 'expense' },
  });

  const summarySection = el('div', { class: 'card analysis-section collapsible' });
  const chartSection = el('div', { class: 'card analysis-section collapsible' });
  root.append(summarySection, chartSection);

  let summaryExpanded = false;
  let chartExpanded = false;
  const hiddenTagIds = new Set();

  function matchingLineItems() {
    const items = [];
    for (const t of txns) {
      for (const li of t.lineItems) {
        if (filters.matchesLineItem(li, t)) items.push({ ...li, type: t.type, accountId: t.accountId });
      }
    }
    return items;
  }

  function renderAll() {
    const lineItems = matchingLineItems();

    renderSummary(summarySection, lineItems, accountsById, {
      expanded: summaryExpanded,
      onToggle: () => {
        summaryExpanded = !summaryExpanded;
        renderAll();
      },
      onTypeClick: (type) => filters.setTypeFilter(type),
      onAccountClick: (accId) => filters.setAccountFilter(accId),
    });

    renderTagChart(chartSection, lineItems, tagsById, hiddenTagIds, {
      expanded: chartExpanded,
      onToggle: () => {
        chartExpanded = !chartExpanded;
        renderAll();
      },
      onHide: (tagId) => {
        hiddenTagIds.add(tagId);
        renderAll();
      },
      onReset: () => {
        hiddenTagIds.clear();
        renderAll();
      },
      onTagClick: (tagId) => {
        // Carry the Dashboard's current filters over to Transactions,
        // adding this tag to the ALL set (unless it's already there).
        const state = filters.getState();
        const andTagIds = state.andTagIds.includes(tagId) ? state.andTagIds : [...state.andTagIds, tagId];
        navigate('list', { filters: { ...state, andTagIds } });
      },
    });
  }

  filters.onChange(renderAll);
  renderAll();
}

function renderSummary(section, lineItems, accountsById, { expanded, onToggle, onTypeClick, onAccountClick }) {
  section.innerHTML = '';
  section.classList.toggle('expanded', expanded);

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

// Collapsed view shows only the "big" tags (> ₹5,000) so the chart is a
// quick glance rather than a long scroll — expanding shows everything.
const TAG_CHART_COLLAPSED_THRESHOLD_PAISE = 500000;

function renderTagChart(section, lineItems, tagsById, hiddenTagIds, { expanded, onToggle, onHide, onReset, onTagClick }) {
  section.innerHTML = '';
  section.classList.toggle('expanded', expanded);

  const header = el('div', { class: 'collapsible-header' }, [
    el('h3', {}, 'Spend by tag'),
    el('span', { class: 'collapsible-toggle' }, expanded ? '▲' : '▼'),
  ]);
  header.addEventListener('click', onToggle);
  section.appendChild(header);

  if (hiddenTagIds.size > 0) {
    const resetBtn = el('button', { type: 'button', class: 'btn btn-link' }, `Reset (${hiddenTagIds.size} hidden)`);
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onReset();
    });
    section.appendChild(resetBtn);
  }

  const totals = new Map();
  for (const li of lineItems) {
    for (const tagId of li.tagIds) {
      totals.set(tagId, (totals.get(tagId) || 0) + li.amount);
    }
  }

  const allEntries = [...totals.entries()]
    .filter(([tagId]) => tagsById.has(tagId) && !hiddenTagIds.has(tagId))
    .map(([tagId, amount]) => ({ tagId, name: tagsById.get(tagId), amount }))
    .sort((a, b) => b.amount - a.amount);

  if (allEntries.length === 0) {
    section.appendChild(el('p', { class: 'empty-state' }, 'No matching line items.'));
    return;
  }

  const entries = expanded ? allEntries : allEntries.filter((e) => e.amount > TAG_CHART_COLLAPSED_THRESHOLD_PAISE);

  if (entries.length === 0) {
    section.appendChild(el('p', { class: 'empty-state' }, 'No tags over ₹5,000 — expand to see everything.'));
    return;
  }

  // A real table, not flex/grid rows — each row's bar-track column would
  // otherwise size itself independently based on that row's own amount
  // text width, so bars drifted and weren't the same length. Table columns
  // are sized consistently across every row.
  const max = entries[0].amount;
  const tbody = el('tbody');
  for (const entry of entries) {
    const pct = max ? Math.round((entry.amount / max) * 100) : 0;

    const removeBtn = el(
      'button',
      { type: 'button', class: 'tag-chart-remove', 'aria-label': `Remove "${entry.name}" from the chart` },
      '−'
    );
    removeBtn.addEventListener('click', () => onHide(entry.tagId));

    const labelBtn = el(
      'button',
      { type: 'button', class: 'tag-chart-label link-chip', title: `View transactions tagged "${entry.name}"` },
      entry.name
    );
    labelBtn.addEventListener('click', () => onTagClick(entry.tagId));

    tbody.appendChild(
      el('tr', {}, [
        el('td', { class: 'tag-chart-cell-remove' }, removeBtn),
        el('td', { class: 'tag-chart-cell-label' }, labelBtn),
        el('td', { class: 'tag-chart-cell-bar' }, el('span', { class: 'tag-chart-bar-track' }, [el('span', { class: 'tag-chart-bar-fill', style: `width:${pct}%` })])),
        el('td', { class: 'tag-chart-cell-amount' }, formatINR(entry.amount)),
      ])
    );
  }
  section.appendChild(el('table', { class: 'tag-chart' }, [tbody]));
}
