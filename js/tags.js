// Reusable tag-chip input with autocomplete against existing tag names.
// Tracks display names only (already normalized); resolving names to tag
// ids/creating new tags happens at save time via db.findOrCreateTags.

import { listTags, normalizeTagName } from './db.js';
import { el } from './dom.js';

/**
 * @param {HTMLElement} container - mount point, gets one child appended.
 * @param {{ initialTagNames?: string[] }} [opts]
 * @returns {{ getTagNames(): string[], setTagNames(names: string[]): void, destroy(): void }}
 */
export function mountTagInput(container, opts = {}) {
  const chips = [];
  let allTagNames = [];
  listTags().then((tags) => {
    allTagNames = tags.map((t) => t.name);
  });

  const wrap = el('div', { class: 'tag-input' });
  const chipList = el('div', { class: 'tag-chip-list' });
  const textInput = el('input', {
    type: 'text',
    class: 'tag-text-input',
    placeholder: 'Add tag…',
    autocomplete: 'off',
  });
  const suggestionBox = el('div', { class: 'tag-suggestions', hidden: true });
  wrap.append(chipList, textInput, suggestionBox);
  container.appendChild(wrap);

  function renderChips() {
    chipList.innerHTML = '';
    for (const name of chips) {
      const removeBtn = el('button', { type: 'button', class: 'tag-chip-remove', 'aria-label': `Remove tag ${name}` }, '✕');
      removeBtn.addEventListener('click', () => {
        const idx = chips.indexOf(name);
        if (idx >= 0) chips.splice(idx, 1);
        renderChips();
      });
      chipList.appendChild(el('span', { class: 'tag-chip' }, [name, removeBtn]));
    }
  }

  function hideSuggestions() {
    suggestionBox.hidden = true;
    suggestionBox.innerHTML = '';
  }

  function showSuggestions() {
    const query = normalizeTagName(textInput.value);
    if (!query) return hideSuggestions();
    const matches = allTagNames.filter((n) => n.includes(query) && !chips.includes(n)).slice(0, 8);
    if (matches.length === 0) return hideSuggestions();
    suggestionBox.innerHTML = '';
    for (const match of matches) {
      const item = el('button', { type: 'button', class: 'tag-suggestion' }, match);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addChip(match);
      });
      suggestionBox.appendChild(item);
    }
    suggestionBox.hidden = false;
  }

  function addChip(raw) {
    const name = normalizeTagName(raw);
    if (!name) return;
    if (!chips.includes(name)) chips.push(name);
    textInput.value = '';
    hideSuggestions();
    renderChips();
  }

  textInput.addEventListener('input', showSuggestions);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addChip(textInput.value);
    } else if (e.key === 'Backspace' && textInput.value === '' && chips.length > 0) {
      chips.pop();
      renderChips();
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });
  textInput.addEventListener('blur', () => {
    // Delay so a suggestion's mousedown still fires before we hide the list.
    setTimeout(() => {
      if (textInput.value.trim()) addChip(textInput.value);
      hideSuggestions();
    }, 150);
  });

  for (const name of opts.initialTagNames || []) addChip(name);

  return {
    getTagNames: () => chips.slice(),
    setTagNames: (names) => {
      chips.length = 0;
      renderChips();
      for (const n of names) addChip(n);
    },
    destroy: () => wrap.remove(),
  };
}
