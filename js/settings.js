// Settings tab: account management, tag management, backup export/import.

import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  listTags,
  renameTag,
  deleteTag,
  countLineItemsUsingTag,
} from './db.js';
import { exportToFile, importFromFile } from './backup.js';
import { el } from './dom.js';

export async function render(container, ctx) {
  const { notify } = ctx;
  container.innerHTML = '';
  const root = el('div', { class: 'view settings-view' });
  root.appendChild(el('h2', {}, 'Settings'));
  container.appendChild(root);

  // ---- Backup ----
  const exportBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'Export backup (JSON)');
  exportBtn.addEventListener('click', async () => {
    try {
      await exportToFile();
      notify('Backup downloaded', 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  });
  const importInput = el('input', { type: 'file', accept: 'application/json', class: 'sr-only' });
  const importBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Import backup…');
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    if (!confirm('Importing will REPLACE all current data with the contents of this file. Continue?')) {
      importInput.value = '';
      return;
    }
    try {
      await importFromFile(file);
      notify('Backup imported. Reloading…', 'success');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      importInput.value = '';
    }
  });
  const backupCard = el('div', { class: 'card' }, [
    el('h3', {}, 'Backup'),
    el('p', { class: 'field-hint' }, 'Export downloads a JSON snapshot of everything. Import replaces all current data.'),
    el('div', { class: 'form-actions' }, [exportBtn, importBtn, importInput]),
  ]);
  root.appendChild(backupCard);

  // ---- Accounts ----
  const accountsList = el('div', { class: 'settings-list' });
  const newAccName = el('input', { type: 'text', placeholder: 'New account name' });
  const newAccCycle = el('input', { type: 'number', min: '1', max: '31', placeholder: 'Cycle day (optional)' });
  const addAccBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'Add account');
  const accountsCard = el('div', { class: 'card' }, [
    el('h3', {}, 'Accounts'),
    accountsList,
    el('div', { class: 'settings-row' }, [newAccName, newAccCycle, addAccBtn]),
  ]);
  root.appendChild(accountsCard);

  async function refreshAccounts() {
    accountsList.innerHTML = '';
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      accountsList.appendChild(el('p', { class: 'empty-state' }, 'No accounts yet.'));
      return;
    }
    for (const acc of accounts) {
      const nameInput = el('input', { type: 'text', value: acc.name });
      const cycleInput = el('input', { type: 'number', min: '1', max: '31', value: acc.statementCycleStartDay ?? '', placeholder: 'Cycle day' });
      const saveBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Save');
      saveBtn.addEventListener('click', async () => {
        try {
          await updateAccount(acc.id, { name: nameInput.value, statementCycleStartDay: cycleInput.value || null });
          notify('Account updated', 'success');
          refreshAccounts();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
      const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger' }, 'Delete');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete account "${acc.name}"?`)) return;
        try {
          await deleteAccount(acc.id);
          notify('Account deleted', 'success');
          refreshAccounts();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
      accountsList.appendChild(el('div', { class: 'settings-row' }, [nameInput, cycleInput, saveBtn, deleteBtn]));
    }
  }
  addAccBtn.addEventListener('click', async () => {
    try {
      await createAccount({ name: newAccName.value, statementCycleStartDay: newAccCycle.value || null });
      newAccName.value = '';
      newAccCycle.value = '';
      notify('Account created', 'success');
      refreshAccounts();
    } catch (err) {
      notify(err.message, 'error');
    }
  });
  await refreshAccounts();

  // ---- Tags ----
  const tagsList = el('div', { class: 'settings-list' });
  const tagsCard = el('div', { class: 'card' }, [el('h3', {}, 'Tags'), tagsList]);
  root.appendChild(tagsCard);

  async function refreshTags() {
    tagsList.innerHTML = '';
    const tags = await listTags();
    if (tags.length === 0) {
      tagsList.appendChild(el('p', { class: 'empty-state' }, 'No tags yet — tags are created from the Add form.'));
      return;
    }
    for (const tag of tags) {
      const nameInput = el('input', { type: 'text', value: tag.name });
      const saveBtn = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Rename');
      saveBtn.addEventListener('click', async () => {
        try {
          await renameTag(tag.id, nameInput.value);
          notify('Tag renamed', 'success');
          refreshTags();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
      const deleteBtn = el('button', { type: 'button', class: 'btn btn-danger' }, 'Delete');
      deleteBtn.addEventListener('click', async () => {
        const count = await countLineItemsUsingTag(tag.id);
        const warning = count > 0 ? ` It is used on ${count} line item(s); they will be left with one fewer tag.` : '';
        if (!confirm(`Delete tag "${tag.name}"?${warning}`)) return;
        try {
          await deleteTag(tag.id);
          notify('Tag deleted', 'success');
          refreshTags();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
      tagsList.appendChild(el('div', { class: 'settings-row' }, [nameInput, saveBtn, deleteBtn]));
    }
  }
  await refreshTags();
}
