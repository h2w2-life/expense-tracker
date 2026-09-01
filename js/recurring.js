// Recurring-transaction UI: the "+ Recurring transaction" button + dialog on
// the Add tab (creates a whole series up front — no splits, per the series
// constraint), plus the "this only" vs "this and all future" scope prompt
// and bulk-edit dialog used by js/list.js for editing/deleting an existing
// series occurrence. A recurring transaction has no special representation
// in storage — see db.js's createRecurringTransactions/saveTransaction —
// these are just dialogs that call the same functions the Add form does.

import { listAccounts, findOrCreateTags, createRecurringTransactions, saveTransaction } from './db.js';
import { rupeesToPaise, paiseToInputValue } from './money.js';
import { tryEvaluate, bindAmountField } from './calc.js';
import { mountTagInput } from './tags.js';
import { el, field } from './dom.js';

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

const ONE_TO_TWELVE = Array.from({ length: 12 }, (_, i) => i + 1);

function buildAccountSelect(accounts, selectedId) {
  const select = el('select', { required: true });
  select.appendChild(el('option', { value: '', disabled: true }, 'Select account…'));
  for (const acc of accounts) select.appendChild(el('option', { value: String(acc.id) }, acc.name));
  select.value = selectedId != null ? String(selectedId) : '';
  if (!select.value) select.selectedIndex = 0;
  return select;
}

/**
 * Mounts a "+ Recurring transaction" button (return value — place it
 * wherever the caller wants) that opens a modal for materializing a whole
 * series up front.
 * @param {{ notify: Function, onCreated: () => void }} opts
 */
export function mountRecurringButton({ notify, onCreated }) {
  const dialog = el('dialog', { class: 'modal-dialog' });
  document.body.appendChild(dialog);

  const openBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, '+ Recurring transaction');
  openBtn.addEventListener('click', async () => {
    const accounts = await listAccounts();
    buildForm(accounts);
    dialog.showModal();
  });

  function buildForm(accounts) {
    dialog.innerHTML = '';

    const dateInput = el('input', { type: 'date', required: true, value: todayISO() });
    const typeSelect = el('select', {}, [
      el('option', { value: 'expense' }, 'Expense'),
      el('option', { value: 'income' }, 'Income'),
    ]);
    const defaultAccount = accounts.find((a) => a.name === 'HDFC UPI');
    const accountSelect = buildAccountSelect(accounts, defaultAccount && defaultAccount.id);

    const descInput = el('input', { type: 'text', placeholder: 'Description' });
    const amountInput = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount' });
    bindAmountField(amountInput);

    const tagContainer = el('div', { class: 'tag-input-mount' });
    const tagWidget = mountTagInput(tagContainer);

    const intervalSelect = el('select', {}, ONE_TO_TWELVE.map((n) => el('option', { value: String(n) }, String(n))));
    const unitSelect = el('select', {}, [
      el('option', { value: 'weeks' }, 'Week(s)'),
      el('option', { value: 'months' }, 'Month(s)'),
    ]);
    unitSelect.value = 'months';
    const countInput = el('input', { type: 'number', min: '1', max: '12', required: true, value: '1' });

    const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Create series');
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-link' }, 'Cancel');
    cancelBtn.addEventListener('click', () => dialog.close());

    const form = el('form', { class: 'entry-form' }, [
      el('h3', {}, 'Recurring transaction'),
      el('p', { class: 'field-hint' }, 'Creates every occurrence up front as its own transaction. No splits.'),
      el('div', { class: 'form-grid' }, [field('Date (first occurrence)', dateInput), field('Type', typeSelect)]),
      el('div', { class: 'form-grid' }, [field('Account', accountSelect), field('Amount', amountInput)]),
      field('Description', descInput),
      el('div', { class: 'field field-tags' }, [el('label', {}, 'Tags'), tagContainer]),
      el('div', { class: 'form-grid' }, [field('Repeat every', intervalSelect), field('Unit', unitSelect)]),
      field('Number of occurrences (1-12)', countInput),
      el('div', { class: 'form-actions' }, [saveBtn, cancelBtn]),
    ]);
    dialog.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = tryEvaluate(amountInput.value.trim());
      if (amount === null) {
        notify('Amount is not a valid amount or expression', 'error');
        return;
      }
      const count = Number(countInput.value);
      if (!Number.isInteger(count) || count < 1 || count > 12) {
        notify('Number of occurrences must be between 1 and 12', 'error');
        return;
      }
      if (!accountSelect.value) {
        notify('Please select an account', 'error');
        return;
      }
      const tagNames = tagWidget.getTagNames();
      if (tagNames.length === 0) {
        notify('At least one tag is required', 'error');
        return;
      }
      try {
        const tags = await findOrCreateTags(tagNames);
        await createRecurringTransactions({
          date: dateInput.value,
          type: typeSelect.value,
          accountId: Number(accountSelect.value),
          description: descInput.value.trim(),
          amount: rupeesToPaise(amount),
          tagIds: tags.map((t) => t.id),
          intervalUnit: unitSelect.value,
          intervalX: Number(intervalSelect.value),
          count,
        });
        notify(`Created ${count} recurring transactions`, 'success');
        dialog.close();
        onCreated();
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  return openBtn;
}

/**
 * Asks which occurrences an edit/delete action should apply to. Resolves
 * 'this' | 'future' | null (cancelled).
 * @param {string} message
 * @param {{ thisLabel: string, futureLabel: string }} labels
 */
export function askSeriesScope(message, labels) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'modal-dialog modal-dialog-small' });
    let result = null;

    const thisBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, labels.thisLabel);
    const futureBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, labels.futureLabel);
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-link' }, 'Cancel');
    thisBtn.addEventListener('click', () => {
      result = 'this';
      dialog.close();
    });
    futureBtn.addEventListener('click', () => {
      result = 'future';
      dialog.close();
    });
    cancelBtn.addEventListener('click', () => dialog.close());

    dialog.append(
      el('div', { class: 'entry-form' }, [
        el('p', {}, message),
        el('div', { class: 'form-actions modal-scope-actions' }, [thisBtn, futureBtn, cancelBtn]),
      ])
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * Bulk-edit dialog for "this and all future" occurrences of a series. Every
 * matching transaction keeps its own original date — only account, type,
 * description, amount, and tags change.
 * @param {{
 *   seed: { type, accountId, description, amount, tagNames },
 *   notify: Function,
 *   onSave: (patch: { accountId, type, description, amount, tagNames }) => Promise<void>,
 * }} opts
 */
export async function openSeriesFutureEditDialog({ seed, notify, onSave }) {
  const accounts = await listAccounts();
  const dialog = el('dialog', { class: 'modal-dialog' });
  document.body.appendChild(dialog);

  const typeSelect = el('select', {}, [
    el('option', { value: 'expense' }, 'Expense'),
    el('option', { value: 'income' }, 'Income'),
  ]);
  typeSelect.value = seed.type;
  const accountSelect = buildAccountSelect(accounts, seed.accountId);
  const descInput = el('input', { type: 'text', placeholder: 'Description' });
  descInput.value = seed.description || '';
  const amountInput = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount' });
  bindAmountField(amountInput);
  amountInput.value = paiseToInputValue(seed.amount);
  const tagContainer = el('div', { class: 'tag-input-mount' });
  const tagWidget = mountTagInput(tagContainer, { initialTagNames: seed.tagNames });

  const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save to this and future');
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-link' }, 'Cancel');
  cancelBtn.addEventListener('click', () => dialog.close());

  const form = el('form', { class: 'entry-form' }, [
    el('h3', {}, 'Edit this and all future occurrences'),
    el('p', { class: 'field-hint' }, "Each occurrence keeps its own date — only these fields change."),
    el('div', { class: 'form-grid' }, [field('Account', accountSelect), field('Type', typeSelect)]),
    field('Description', descInput),
    field('Amount', amountInput),
    el('div', { class: 'field field-tags' }, [el('label', {}, 'Tags'), tagContainer]),
    el('div', { class: 'form-actions' }, [saveBtn, cancelBtn]),
  ]);
  dialog.appendChild(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = tryEvaluate(amountInput.value.trim());
    if (amount === null) {
      notify('Amount is not a valid amount or expression', 'error');
      return;
    }
    if (!accountSelect.value) {
      notify('Please select an account', 'error');
      return;
    }
    const tagNames = tagWidget.getTagNames();
    if (tagNames.length === 0) {
      notify('At least one tag is required', 'error');
      return;
    }
    await onSave({
      accountId: Number(accountSelect.value),
      type: typeSelect.value,
      description: descInput.value.trim(),
      amount: rupeesToPaise(amount),
      tagNames,
    });
    dialog.close();
  });

  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

/** Applies a bulk "this and future" patch to a set of series transactions
 * (each keeping its own date), used by list.js after openSeriesFutureEditDialog. */
export async function applySeriesFuturePatch(futureTxns, patch) {
  const tags = await findOrCreateTags(patch.tagNames);
  const tagIds = tags.map((t) => t.id);
  for (const t of futureTxns) {
    await saveTransaction(
      {
        id: t.id,
        date: t.date,
        type: patch.type,
        accountId: patch.accountId,
        description: patch.description,
        statedTotal: patch.amount,
        seriesId: t.seriesId,
        seriesIndex: t.seriesIndex,
      },
      [{ amount: patch.amount, description: patch.description, tagIds }]
    );
  }
}
