/**
 * Un nom de produit ou de client commençant par `=`, `+`, `-`, `@`, tab ou CR
 * est interprété comme une formule par Excel / Google Sheets / LibreOffice.
 * On préfixe ces valeurs par une apostrophe pour neutraliser l'exécution.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  const str = String(value ?? '');
  const safe = FORMULA_TRIGGERS.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCSV(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(','));
  return [header, ...lines].join('\n');
}

export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
