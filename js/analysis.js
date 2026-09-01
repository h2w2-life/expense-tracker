// Dashboard tab: shared filters (see filters.js — identical behavior to
// Transactions), the income/expense/net summary + by-account breakdown
// (moved here from Transactions), and a spend-by-tag bar chart.

import { listTransactionsWithLineItems, listAccounts, listTags } from './db.js';
import { formatINR } from './money.js';
import { el } from './dom.js';
import { mountTransactionFilters, currentMonthValue } from './filters.js';

export async function render(container) {
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
  const chartSection = el('div', { class: 'card analysis-section' });
  root.append(summarySection, chartSection);

  let summaryExpanded = false;
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
      onHide: (tagId) => {
        hiddenTagIds.add(tagId);
        renderAll();
      },
      onReset: () => {
        hiddenTagIds.clear();
        renderAll();
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

function renderTagChart(section, lineItems, tagsById, hiddenTagIds, { onHide, onReset }) {
  section.innerHTML = '';

  const headerRow = el('div', { class: 'collapsible-header' }, [el('h3', {}, 'Spend by tag')]);
  if (hiddenTagIds.size > 0) {
    const resetBtn = el('button', { type: 'button', class: 'btn btn-link' }, `Reset (${hiddenTagIds.size} hidden)`);
    resetBtn.addEventListener('click', onReset);
    headerRow.appendChild(resetBtn);
  }
  section.appendChild(headerRow);

  const totals = new Map();
  for (const li of lineItems) {
    for (const tagId of li.tagIds) {
      totals.set(tagId, (totals.get(tagId) || 0) + li.amount);
    }
  }

  const entries = [...totals.entries()]
    .filter(([tagId]) => tagsById.has(tagId) && !hiddenTagIds.has(tagId))
    .map(([tagId, amount]) => ({ tagId, name: tagsById.get(tagId), amount }))
    .sort((a, b) => b.amount - a.amount);

  if (entries.length === 0) {
    section.appendChild(el('p', { class: 'empty-state' }, 'No matching line items.'));
    return;
  }

  const max = entries[0].amount;
  const chart = el('div', { class: 'tag-chart' });
  for (const entry of entries) {
    const pct = max ? Math.round((entry.amount / max) * 100) : 0;
    const row = el(
      'button',
      { type: 'button', class: 'tag-chart-row', title: `Click to remove "${entry.name}" from the chart` },
      [
        el('span', { class: 'tag-chart-label' }, entry.name),
        el('span', { class: 'tag-chart-bar-track' }, [el('span', { class: 'tag-chart-bar-fill', style: `width:${pct}%` })]),
        el('span', { class: 'tag-chart-amount' }, formatINR(entry.amount)),
      ]
    );
    row.addEventListener('click', () => onHide(entry.tagId));
    chart.appendChild(row);
  }
  section.appendChild(chart);
}
