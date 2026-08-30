// Dashboard tab: placeholder for future graphical analysis widgets. The old
// text-based summary/reconciliation views moved to js/list.js.

import { el } from './dom.js';

export async function render(container) {
  container.innerHTML = '';
  const root = el('div', { class: 'view analysis-view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  root.appendChild(el('p', { class: 'empty-state' }, 'Nothing here yet.'));
  container.appendChild(root);
}
