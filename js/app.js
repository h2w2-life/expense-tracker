// Tab navigation and wiring. Each view is re-fetched fresh from IndexedDB
// on every render — no separate app-level state store needed.
//
// Navigation state (which view + its params, e.g. filters/editId) lives in
// the browser's session history via history.pushState, not just the URL
// hash — that's what lets Back/Forward restore a view exactly as it was
// (e.g. clicking a Dashboard tag into filtered Transactions, then Back
// returns to the same Dashboard filters instead of resetting them). A
// reload is a deliberate exception: it always starts fresh on Dashboard
// with no params, ignoring whatever hash/state a previous session left in
// this tab, since "refresh" should mean "start over," not "resume."

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

async function renderView(name, params = {}) {
  if (!views[name]) name = 'list';
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.view === name);
  try {
    await views[name].render(container, { notify, navigate, params });
  } catch (err) {
    console.error(err);
    notify(`Failed to load view: ${err.message}`, 'error');
  }
}

// Every in-app navigation (tab click, Edit button, a Dashboard tag, ...)
// goes through here, pushing a history entry that carries `params` along
// with the view name so popstate (below) can restore it verbatim.
function navigate(name, params = {}) {
  if (!views[name]) name = 'list';
  history.pushState({ name, params }, '', `#${name}`);
  renderView(name, params);
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
}

window.addEventListener('popstate', (e) => {
  const state = e.state || { name: 'analysis', params: {} };
  renderView(state.name, state.params);
});

// Always land on Dashboard with a clean slate on load/reload — replace
// (not push) so this is the one bottom-most history entry, not an extra
// step Back has to pass through.
history.replaceState({ name: 'analysis', params: {} }, '', '#analysis');
renderView('analysis', {});

if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}
