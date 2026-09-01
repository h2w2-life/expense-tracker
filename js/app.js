// Tab navigation and wiring. Each view is re-fetched fresh from IndexedDB
// on every render — no separate app-level state store needed.

import * as entryView from './entry.js';
import * as listView from './list.js';
import * as analysisView from './analysis.js';
import * as settingsView from './settings.js';

const views = { entry: entryView, list: listView, analysis: analysisView, settings: settingsView };
const container = document.getElementById('view-container');
const toastEl = document.getElementById('toast');
const tabButtons = document.querySelectorAll('.tab-btn');

let toastTimer = null;
function notify(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${type}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3500);
}

let selfInitiatedHashChange = false;

async function activate(name, params = {}) {
  if (!views[name]) name = 'list';
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.view === name);
  if (window.location.hash.slice(1) !== name) {
    selfInitiatedHashChange = true;
    window.location.hash = name;
  }
  try {
    await views[name].render(container, { notify, navigate: activate, params });
  } catch (err) {
    console.error(err);
    notify(`Failed to load view: ${err.message}`, 'error');
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => activate(btn.dataset.view));
}

// Only react to hash changes the user (or browser back/forward) caused
// directly — e.g. a manually edited/bookmarked #list URL, or Alt+Left after
// following a link. Ignore the hashchange our own `activate()` just fired
// via `window.location.hash = name` above, otherwise it re-renders the
// target view with no params and silently drops things like the entry
// form's `editId` (see: "Edit" from the transaction list loading a blank
// Add form instead of the transaction being edited).
window.addEventListener('hashchange', () => {
  if (selfInitiatedHashChange) {
    selfInitiatedHashChange = false;
    return;
  }
  const name = window.location.hash.slice(1);
  if (name && views[name]) activate(name);
});

const initialHash = window.location.hash.slice(1);
activate(views[initialHash] ? initialHash : 'list');

if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}
