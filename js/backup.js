// Export/import all IndexedDB data as a downloadable/uploadable JSON file.
// Plain browser download/upload APIs — works identically on desktop and
// mobile, doubles as the manual cloud-backup mechanism (drop the file into
// Drive/Dropbox/etc. by hand).

import { exportAll, importAll } from './db.js';

export async function exportToFile() {
  const data = await exportAll();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `expense-tracker-backup-${data.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function importFromFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Selected file is not valid JSON');
  }
  await importAll(data);
}
