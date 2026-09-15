// Tiny DOM-builder helper shared by every view module. Not a framework —
// just enough to avoid innerHTML string-splicing for dynamic UI.

/**
 * @param {string} tag
 * @param {Object<string, any>} [attrs] - 'class' sets className; 'onXxx'
 *   functions attach listeners; keys that exist as an IDL property on the
 *   element (value, checked, hidden, disabled, required, min, max, ...) are
 *   set directly; everything else falls back to setAttribute.
 * @param {Array|Node|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      node.className = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (key in node) {
      node[key] = value === true ? true : value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(
      typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child
    );
  }
  return node;
}

let fieldUid = 0;

/**
 * Builds a `.field` wrapper with a properly associated <label for> —
 * `el('div', { class: 'field' }, [el('label', {}, text), input])` looks
 * right but leaves label and input as unlinked siblings, so screen
 * readers/automation fall back to the placeholder instead of the label.
 * @param {string} labelText
 * @param {HTMLElement} inputEl
 * @param {Array|Node} [extra] - extra nodes appended after the input (e.g. a "+ New" button)
 */
export function field(labelText, inputEl, extra = []) {
  const id = inputEl.id || `f${++fieldUid}`;
  inputEl.id = id;
  const label = el('label', { for: id }, labelText);
  return el('div', { class: 'field' }, [label, inputEl, ...[].concat(extra)]);
}

/**
 * A `<input type="date">` with ◀/▶ buttons on either side that step it by
 * one day — same interaction as the Month field's prev/next in filters.js,
 * for the common case of "same day, one field off" repeat entry.
 * @param {string} initialValue - YYYY-MM-DD
 * @returns {{ dateInput: HTMLInputElement, row: HTMLElement }} `row` is what
 *   to actually place in the form (e.g. via `field('Date', row)`).
 */
export function mountDateInputWithNav(initialValue) {
  const dateInput = el('input', { type: 'date', required: true, value: initialValue });
  const prevBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon date-nav-btn' }, '◀');
  const nextBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-icon date-nav-btn' }, '▶');
  function shift(days) {
    if (!dateInput.value) return;
    const d = new Date(`${dateInput.value}T00:00:00`);
    d.setDate(d.getDate() + days);
    dateInput.value = d.toISOString().slice(0, 10);
  }
  prevBtn.addEventListener('click', () => shift(-1));
  nextBtn.addEventListener('click', () => shift(1));
  const row = el('div', { class: 'month-field-row' }, [prevBtn, dateInput, nextBtn]);
  return { dateInput, row };
}
