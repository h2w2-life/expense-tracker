// Export/import all IndexedDB data as a downloadable/uploadable JSON file.
// Plain browser download/upload APIs — works identically on desktop and
// mobile, doubles as the manual cloud-backup mechanism (drop the file into
// Drive/Dropbox/etc. by hand).

import { exportAll, importAll } from './db.js';

export async function exportToFile() {
  const data = await exportAll();
  const json = JSON.stringify(data, null, 2);
  // `application/octet-stream` rather than `application/json` is
  // deliberate: some mobile browsers try to open/preview a recognized JSON
  // blob instead of force-downloading it, and that alternate path often
  // ignores the anchor's `download` filename entirely, substituting its own
  // timestamp-based name instead. An opaque binary type reliably triggers a
  // plain download that honors `download` everywhere.
  const blob = new Blob([json], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `expense-tracker-backup-${data.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking the object URL immediately can race the browser's own
  // handling of the download (which isn't always synchronous, especially
  // on mobile) — the click "succeeds" from this function's point of view
  // either way, so a too-early revoke silently breaks the actual download
  // with no error to catch. Give the browser a moment first.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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
