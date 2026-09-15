// Transfer-between-accounts UI: the "Transfer" button + dialog on the
// Transactions tab, plus openTransferEditDialog() for editing an existing
// one. A transfer is just a normal transaction with type: 'transfer' and a
// toAccountId (see db.js's saveTransaction) — always a single line item (no
// splits, same reasoning as recurring transactions), auto-tagged "transfer"
// so it still satisfies the "every line item needs a tag" rule without
// asking the user to pick one for what isn't really a spend category.

import { listAccounts, findOrCreateTag, saveTransaction } from './db.js';
import { rupeesToPaise, paiseToInputValue } from './money.js';
import { tryEvaluate, bindAmountField } from './calc.js';
import { el, field, mountDateInputWithNav } from './dom.js';

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function buildAccountSelect(accounts, selectedId) {
  const select = el('select', { required: true });
  select.appendChild(el('option', { value: '', disabled: true }, 'Select account…'));
  for (const acc of accounts) select.appendChild(el('option', { value: String(acc.id) }, acc.name));
  select.value = selectedId != null ? String(selectedId) : '';
  if (!select.value) select.selectedIndex = 0;
  return select;
}

/**
 * Builds the transfer form into `dialog` (cleared first). Shared by both the
 * "new transfer" and "edit transfer" entry points below.
 * @param {{
 *   accounts: object[], seed?: { date, fromAccountId, toAccountId, amount, description },
 *   submitLabel: string, notify: Function,
 *   onSubmit: (values: { date, fromAccountId, toAccountId, amount, description }) => Promise<void>,
 *   onCancel: () => void,
 * }} opts
 */
function buildTransferForm(dialog, { accounts, seed, submitLabel, notify, onSubmit, onCancel }) {
  dialog.innerHTML = '';

  const { dateInput, row: dateRow } = mountDateInputWithNav(seed ? seed.date : todayISO());
  const fromSelect = buildAccountSelect(accounts, seed && seed.fromAccountId);
  const toSelect = buildAccountSelect(accounts, seed && seed.toAccountId);
  const amountInput = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount' });
  bindAmountField(amountInput);
  if (seed) amountInput.value = paiseToInputValue(seed.amount);
  const descInput = el('input', { type: 'text', placeholder: 'Description (optional)' });
  if (seed && seed.description) descInput.value = seed.description;

  const saveBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-link' }, 'Cancel');
  cancelBtn.addEventListener('click', onCancel);

  const form = el('form', { class: 'entry-form' }, [
    el('h3', {}, 'Transfer between accounts'),
    field('Date', dateRow),
    el('div', { class: 'form-grid' }, [field('From account', fromSelect), field('To account', toSelect)]),
    field('Amount', amountInput),
    field('Description', descInput),
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
    if (!fromSelect.value || !toSelect.value) {
      notify('Please select both accounts', 'error');
      return;
    }
    if (fromSelect.value === toSelect.value) {
      notify('From and To accounts must be different', 'error');
      return;
    }
    try {
      await onSubmit({
        date: dateInput.value,
        fromAccountId: Number(fromSelect.value),
        toAccountId: Number(toSelect.value),
        amount: rupeesToPaise(amount),
        description: descInput.value.trim(),
      });
    } catch (err) {
      notify(err.message, 'error');
    }
  });
}

async function saveTransfer(values, editingId) {
  const transferTag = await findOrCreateTag('transfer');
  return saveTransaction(
    {
      id: editingId || undefined,
      date: values.date,
      type: 'transfer',
      accountId: values.fromAccountId,
      toAccountId: values.toAccountId,
      description: values.description,
      statedTotal: values.amount,
    },
    [{ amount: values.amount, description: values.description, tagIds: [transferTag.id] }]
  );
}

/**
 * Mounts a "Transfer" button (return value — place it wherever the caller
 * wants) that opens a modal for moving money between two accounts.
 * @param {{ notify: Function, onSaved: () => void }} opts
 */
export function mountTransferButton({ notify, onSaved }) {
  const dialog = el('dialog', { class: 'modal-dialog' });
  document.body.appendChild(dialog);

  const openBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'Transfer');
  openBtn.addEventListener('click', async () => {
    const accounts = await listAccounts();
    buildTransferForm(dialog, {
      accounts,
      submitLabel: 'Transfer',
      notify,
      onSubmit: async (values) => {
        await saveTransfer(values);
        notify('Transfer recorded', 'success');
        dialog.close();
        onSaved();
      },
      onCancel: () => dialog.close(),
    });
    dialog.showModal();
  });

  return openBtn;
}

/**
 * Opens a modal pre-filled with an existing transfer transaction for
 * editing.
 * @param {{ notify: Function, txn: object, onSaved: () => void }} opts
 */
export async function openTransferEditDialog({ notify, txn, onSaved }) {
  const accounts = await listAccounts();
  const dialog = el('dialog', { class: 'modal-dialog' });
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());

  buildTransferForm(dialog, {
    accounts,
    seed: {
      date: txn.date,
      fromAccountId: txn.accountId,
      toAccountId: txn.toAccountId,
      amount: txn.statedTotal ?? txn.lineItems.reduce((s, li) => s + li.amount, 0),
      description: txn.description || (txn.lineItems[0] && txn.lineItems[0].description) || '',
    },
    submitLabel: 'Save changes',
    notify,
    onSubmit: async (values) => {
      await saveTransfer(values, txn.id);
      notify('Transfer updated', 'success');
      dialog.close();
      onSaved();
    },
    onCancel: () => dialog.close(),
  });
  dialog.showModal();
}
