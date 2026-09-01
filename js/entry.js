// Add/edit transaction form: splits into 1..N line items, mandatory tags,
// auto-calc-the-one-blank-field (stated total or a line item amount), and
// inline account creation.

import {
  listAccounts,
  createAccount,
  findOrCreateTags,
  saveTransaction,
  getTransaction,
  listLineItemsForTransaction,
  listTags,
} from './db.js';
import { rupeesToPaise, paiseToInputValue } from './money.js';
import { tryEvaluate, bindAmountField } from './calc.js';
import { mountTagInput } from './tags.js';
import { el, field } from './dom.js';
import { mountRecurringButton } from './recurring.js';

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

export async function render(container, ctx) {
  const { notify, navigate, params } = ctx;
  const editingId = params && params.editId;
  // Editing from the Transactions tab carries its filter snapshot along so
  // save/cancel can return to the same filtered view instead of resetting it.
  const returnToList = () => navigate('list', params && params.filters ? { filters: params.filters } : undefined);

  container.innerHTML = '';
  const root = el('div', { class: 'view entry-view' });
  root.appendChild(el('h2', {}, editingId ? 'Edit transaction' : 'Add transaction'));
  const form = el('form', { class: 'card entry-form' });
  root.appendChild(form);
  container.appendChild(root);

  let accounts = await listAccounts();

  const dateInput = el('input', { type: 'date', required: true, value: todayISO() });
  const typeSelect = el('select', {}, [
    el('option', { value: 'expense' }, 'Expense'),
    el('option', { value: 'income' }, 'Income'),
  ]);

  const accountSelect = el('select', { required: true });
  function refreshAccountOptions(selectedId) {
    accountSelect.innerHTML = '';
    accountSelect.appendChild(el('option', { value: '', disabled: true }, 'Select account…'));
    for (const acc of accounts) accountSelect.appendChild(el('option', { value: String(acc.id) }, acc.name));
    accountSelect.value = selectedId ? String(selectedId) : '';
    if (!accountSelect.value) accountSelect.selectedIndex = 0;
  }
  // "HDFC UPI" is the default account for a new transaction when no other
  // selection has been made yet (e.g. by editing an existing one below).
  const defaultAccount = accounts.find((a) => a.name === 'HDFC UPI');
  refreshAccountOptions(defaultAccount && defaultAccount.id);

  const newAccountName = el('input', { type: 'text', placeholder: 'Account name' });
  const newAccountCycle = el('input', { type: 'number', min: '1', max: '31', placeholder: 'Statement cycle start day (optional)' });
  const createAccountBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Create');
  const newAccountPanel = el('div', { class: 'inline-new-account', hidden: true }, [
    field('New account name', newAccountName),
    field('Statement cycle start day (1-31, optional)', newAccountCycle),
    createAccountBtn,
  ]);
  const toggleNewAccountBtn = el('button', { type: 'button', class: 'btn btn-link' }, '+ New account');
  toggleNewAccountBtn.addEventListener('click', () => {
    newAccountPanel.hidden = !newAccountPanel.hidden;
  });
  createAccountBtn.addEventListener('click', async () => {
    try {
      const acc = await createAccount({ name: newAccountName.value, statementCycleStartDay: newAccountCycle.value || null });
      accounts = await listAccounts();
      refreshAccountOptions(acc.id);
      newAccountPanel.hidden = true;
      newAccountName.value = '';
      newAccountCycle.value = '';
      notify(`Account "${acc.name}" created`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  });

  const descInput = el('input', { type: 'text', placeholder: 'Description (optional)' });
  const totalInput = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Stated total (blank = auto)' });
  bindAmountField(totalInput);

  const lineItemsContainer = el('div', { class: 'line-items' });
  const rows = [];

  function addLineItemRow(initial = {}) {
    const amountInput = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount' });
    bindAmountField(amountInput);
    if (initial.amount != null) amountInput.value = paiseToInputValue(initial.amount);
    const itemDescInput = el('input', { type: 'text', placeholder: 'Item description' });
    if (initial.description) itemDescInput.value = initial.description;
    const tagContainer = el('div', { class: 'tag-input-mount' });
    const removeBtn = el('button', { type: 'button', class: 'btn btn-icon line-item-remove', 'aria-label': 'Remove line item' }, '✕');

    const rowEl = el('div', { class: 'line-item' }, [
      field('Amount', amountInput),
      field('Description', itemDescInput),
      el('div', { class: 'field field-tags' }, [el('label', {}, 'Tags'), tagContainer]),
      removeBtn,
    ]);
    lineItemsContainer.appendChild(rowEl);

    const tagWidget = mountTagInput(tagContainer, { initialTagNames: initial.tagNames || [] });
    const row = { amountInput, itemDescInput, tagWidget, rowEl };
    rows.push(row);

    removeBtn.addEventListener('click', () => {
      if (rows.length <= 1) {
        notify('At least one line item is required', 'error');
        return;
      }
      const idx = rows.indexOf(row);
      if (idx >= 0) rows.splice(idx, 1);
      tagWidget.destroy();
      rowEl.remove();
    });

    return row;
  }

  const addLineItemBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, '+ Add line item');
  addLineItemBtn.addEventListener('click', () => addLineItemRow());

  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, editingId ? 'Save changes' : 'Add transaction');
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-link' }, 'Cancel');
  cancelBtn.addEventListener('click', returnToList);

  const formActions = [submitBtn, cancelBtn];
  if (!editingId) {
    // A recurring series is a distinct up-front batch-create action, not
    // something to toggle on mid-edit of a single transaction.
    formActions.push(mountRecurringButton({ notify, onCreated: () => navigate('entry') }));
  }

  form.append(
    el('div', { class: 'form-grid' }, [field('Date', dateInput), field('Type', typeSelect)]),
    el('div', { class: 'form-grid' }, [field('Account', accountSelect, toggleNewAccountBtn), field('Stated total', totalInput)]),
    newAccountPanel,
    field('Description', descInput),
    el('h3', {}, 'Line items'),
    lineItemsContainer,
    addLineItemBtn,
    el('div', { class: 'form-actions' }, formActions)
  );

  // Preserved untouched through save if this transaction is one occurrence
  // of a recurring series (see db.js's saveTransaction) — this form has no
  // way to change series membership, only js/recurring.js's "this and
  // future" bulk-edit does.
  let seriesId;
  let seriesIndex;

  if (editingId) {
    const txn = await getTransaction(editingId);
    if (!txn) {
      notify('Transaction not found', 'error');
      returnToList();
      return;
    }
    seriesId = txn.seriesId;
    seriesIndex = txn.seriesIndex;
    const lineItems = await listLineItemsForTransaction(editingId);
    const allTags = await listTags();
    const tagsById = new Map(allTags.map((t) => [t.id, t.name]));
    dateInput.value = txn.date;
    typeSelect.value = txn.type;
    refreshAccountOptions(txn.accountId);
    descInput.value = txn.description || '';
    if (txn.statedTotal != null) totalInput.value = paiseToInputValue(txn.statedTotal);
    for (const li of lineItems) {
      addLineItemRow({ amount: li.amount, description: li.description, tagNames: li.tagIds.map((id) => tagsById.get(id)).filter(Boolean) });
    }
  }
  if (rows.length === 0) addLineItemRow();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSubmit();
  });

  async function handleSubmit() {
    const totalRaw = totalInput.value.trim();
    const totalBlank = totalRaw === '';
    let total = null;
    if (!totalBlank) {
      total = tryEvaluate(totalRaw);
      if (total === null) {
        notify('Stated total is not a valid amount or expression', 'error');
        totalInput.focus();
        return;
      }
    }

    const itemValues = [];
    for (const row of rows) {
      const raw = row.amountInput.value.trim();
      if (raw === '') {
        itemValues.push(null);
        continue;
      }
      const v = tryEvaluate(raw);
      if (v === null) {
        notify('One of the line item amounts is not a valid amount or expression', 'error');
        row.amountInput.focus();
        return;
      }
      itemValues.push(v);
    }

    const blankCount = (totalBlank ? 1 : 0) + itemValues.filter((v) => v === null).length;
    if (blankCount > 1) {
      notify('At most one amount field (stated total or a line item) may be left blank — it gets auto-calculated', 'error');
      return;
    }
    if (blankCount === 1) {
      const sumFilledItems = itemValues.reduce((s, v) => s + (v ?? 0), 0);
      if (totalBlank) {
        total = sumFilledItems;
      } else {
        itemValues[itemValues.indexOf(null)] = total - sumFilledItems;
      }
    }

    if (!accountSelect.value) {
      notify('Please select an account', 'error');
      return;
    }
    if (!dateInput.value) {
      notify('Please select a date', 'error');
      return;
    }

    const lineItemsPayload = [];
    for (let i = 0; i < rows.length; i++) {
      const tagNames = rows[i].tagWidget.getTagNames();
      if (tagNames.length === 0) {
        notify('Every line item needs at least one tag', 'error');
        return;
      }
      const tags = await findOrCreateTags(tagNames);
      lineItemsPayload.push({
        amount: rupeesToPaise(itemValues[i]),
        description: rows[i].itemDescInput.value.trim(),
        tagIds: tags.map((t) => t.id),
      });
    }

    try {
      await saveTransaction(
        {
          id: editingId || undefined,
          date: dateInput.value,
          type: typeSelect.value,
          accountId: Number(accountSelect.value),
          description: descInput.value.trim(),
          statedTotal: rupeesToPaise(total),
          seriesId,
          seriesIndex,
        },
        lineItemsPayload
      );
      notify(editingId ? 'Transaction updated' : 'Transaction added', 'success');
      // Editing returns to wherever the user came from; adding stays on this
      // tab so entering several transactions in a row doesn't require
      // re-navigating back to Add each time — re-render gives a fresh form.
      if (editingId) returnToList();
      else navigate('entry');
    } catch (err) {
      notify(err.message, 'error');
    }
  }
}
