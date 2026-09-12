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
  let hiddenTagIds = new Set();
  // Tags drilled into, in order (most recent last) — clicking a tag in the
  // chart doesn't navigate away anymore, it narrows the chart to line items
  // that also carry this tag and lists the *other* tags still present on
  // them. Independent of the filter bar's own AND/NOT tags above; the two
  // only get combined when "See transactions" hands off to Transactions.
  let drillTagIds = [];

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
    const lineItems = matchingLineItems().filter((li) => drillTagIds.every((id) => li.tagIds.includes(id)));

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
      excludeTagIds: drillTagIds,
      breadcrumbNames: drillTagIds.map((id) => tagsById.get(id)).filter(Boolean),
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
        drillTagIds = [...drillTagIds, tagId];
        hiddenTagIds = new Set();
        renderAll();
      },
      onBreadcrumbClick: (index) => {
        // index -1 is "All" (the root — clear the drill entirely);
        // otherwise keep everything up to and including that crumb.
        drillTagIds = index < 0 ? [] : drillTagIds.slice(0, index + 1);
        hiddenTagIds = new Set();
        renderAll();
      },
      onSeeTransactions: () => {
        // Carries the filter bar's own state over to Transactions, plus
        // whatever's been drilled into here, merged into the ALL set.
        const state = filters.getState();
        const andTagIds = [...new Set([...state.andTagIds, ...drillTagIds])];
        navigate('list', { filters: { ...state, andTagIds } });
      },
    });
  }

  filters.onChange(() => {
    drillTagIds = [];
    hiddenTagIds = new Set();
    renderAll();
  });
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

function renderTagChart(
  section,
  lineItems,
  tagsById,
  hiddenTagIds,
  { expanded, onToggle, onHide, onReset, onTagClick, excludeTagIds, breadcrumbNames, onBreadcrumbClick, onSeeTransactions }
) {
  section.innerHTML = '';
  section.classList.toggle('expanded', expanded);

  const header = el('div', { class: 'collapsible-header' }, [
    el('h3', {}, 'Spend by tag'),
    el('span', { class: 'collapsible-toggle' }, expanded ? '▲' : '▼'),
  ]);
  header.addEventListener('click', onToggle);
  section.appendChild(header);

  if (breadcrumbNames.length > 0) {
    const crumbs = el('div', { class: 'tag-breadcrumb' });
    const allCrumb = el('button', { type: 'button', class: 'link-chip' }, 'All');
    allCrumb.addEventListener('click', (e) => {
      e.stopPropagation();
      onBreadcrumbClick(-1);
    });
    crumbs.appendChild(allCrumb);
    breadcrumbNames.forEach((name, i) => {
      crumbs.appendChild(el('span', { class: 'tag-breadcrumb-sep' }, '›'));
      const crumbBtn = el('button', { type: 'button', class: 'link-chip' }, name);
      crumbBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onBreadcrumbClick(i);
      });
      crumbs.appendChild(crumbBtn);
    });
    section.appendChild(crumbs);

    const seeTxnsBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'See transactions');
    seeTxnsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSeeTransactions();
    });
    section.appendChild(seeTxnsBtn);
  }

  if (hiddenTagIds.size > 0) {
    const resetBtn = el('button', { type: 'button', class: 'btn btn-link' }, `Reset (${hiddenTagIds.size} hidden)`);
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onReset();
    });
    section.appendChild(resetBtn);
  }

  const excludeSet = new Set(excludeTagIds);
  const totals = new Map();
  for (const li of lineItems) {
    for (const tagId of li.tagIds) {
      if (excludeSet.has(tagId)) continue;
      totals.set(tagId, (totals.get(tagId) || 0) + li.amount);
    }
  }

  const allEntries = [...totals.entries()]
    .filter(([tagId]) => tagsById.has(tagId) && !hiddenTagIds.has(tagId))
    .map(([tagId, amount]) => ({ tagId, name: tagsById.get(tagId), amount }))
    .sort((a, b) => b.amount - a.amount);

  if (allEntries.length === 0) {
    // Two different empty states look identical otherwise: genuinely no
    // matching line items, vs. matching items that exist but carry no tags
    // beyond what's already been drilled into/excluded (a leaf — nothing
    // left to break down by tag). The breadcrumb's own "See transactions"
    // button above (shown at every drill depth) is the way to look at them.
    const message = lineItems.length === 0 ? 'No matching line items.' : 'No further tags to break this down by.';
    section.appendChild(el('p', { class: 'empty-state' }, message));
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
