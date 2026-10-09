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

/**
 * `separateur` : ',' par défaut (gabarit d'import, outils anglo-saxons). Les
 * exports destinés à Excel passent ';' — c'est le séparateur d'Excel en
 * français : avec ',', tout le fichier s'ouvre dans une seule colonne.
 */
export function toCSV(
  rows: Record<string, unknown>[],
  columns: { key: string; label: string }[],
  separateur: ',' | ';' = ',',
): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(separateur);
  const lines = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(separateur));
  return [header, ...lines].join('\n');
}

export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Rattaché au DOM (Firefox notamment ignore le clic sur un lien détaché),
  // puis retiré. La révocation est différée : appelée juste après click(), elle
  // pouvait annuler le téléchargement avant que le navigateur ait lu le blob.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
