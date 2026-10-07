import { escapeHtml } from '@/lib/utils/print';

export interface RapportColonne {
  label: string;
  /** Les montants s'alignent à droite, comme sur un cahier de caisse. */
  droite?: boolean;
  /** Téléphones, dates : ne passent jamais à la ligne (« 97 00 00 / 00 »). */
  insecable?: boolean;
}

export interface Rapport {
  titre: string;
  boutique: string;
  /** « du 1er au 7 octobre 2026 », « au 7 octobre 2026 »… */
  periode: string;
  colonnes: RapportColonne[];
  lignes: string[][];
  /** Ligne de total, en gras sous le tableau. */
  total?: string[];
}

/**
 * Rapport A4 imprimable — le « PDF » du commerçant.
 *
 * Une page HTML ouverte dans un nouvel onglet, avec la boîte d'impression : sur
 * Android comme sur ordinateur, elle propose « Enregistrer en PDF ». Aucune
 * bibliothèque PDF (200 Ko de plus pour tous les utilisateurs), et le rendu est
 * celui du navigateur — polices et accents compris.
 *
 * Toute donnée saisie (nom de client, de produit) passe par escapeHtml : la
 * page hérite de l'origine de l'application (même raison que le reçu).
 *
 * @returns false si le navigateur a bloqué l'ouverture de la fenêtre.
 */
export function imprimerRapport(r: Rapport): boolean {
  const classe = (c: RapportColonne | undefined) =>
    c?.droite ? ' class="d"' : c?.insecable ? ' class="n"' : '';
  const th = r.colonnes.map((c) => `<th${classe(c)}>${escapeHtml(c.label)}</th>`).join('');
  const ligne = (cells: string[], balise: 'td' | 'th') =>
    `<tr>${cells
      .map((v, i) => `<${balise}${classe(r.colonnes[i])}>${escapeHtml(v)}</${balise}>`)
      .join('')}</tr>`;

  const edite = new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const html = [
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(`${r.titre} — ${r.boutique}`)}</title>`,
    '<style>',
    '@page{size:A4;margin:14mm}',
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;margin:16px;font-size:12px}',
    'h1{font-size:18px;margin:0}',
    '.meta{color:#475569;margin:4px 0 14px}',
    'table{width:100%;border-collapse:collapse}',
    'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}',
    'thead th{background:#f1f5f9;font-weight:600}',
    'tbody tr:nth-child(even){background:#f8fafc}',
    'tfoot th{border-top:2px solid #0f172a;border-bottom:none}',
    '.d{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.n{white-space:nowrap}',
    '.pied{margin-top:16px;color:#64748b;font-size:10px}',
    '.actions{margin:0 0 14px}',
    '.actions button{padding:8px 16px;font-size:13px;border:1px solid #0f172a;background:#fff;border-radius:6px}',
    // Sur un téléphone, cinq colonnes dont deux montants insécables : sans
    // marges resserrées, le tableau dépassait l'écran de quelques pixels.
    '@media screen and (max-width:480px){body{margin:10px;font-size:11px}th,td{padding:5px 3px}}',
    '@media print{.actions{display:none}body{margin:0}}',
    '</style></head><body>',
    '<div class="actions"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>',
    `<h1>${escapeHtml(r.titre)}</h1>`,
    `<p class="meta">${escapeHtml(r.boutique)} — ${escapeHtml(r.periode)}</p>`,
    `<table><thead><tr>${th}</tr></thead><tbody>`,
    r.lignes.map((l) => ligne(l, 'td')).join(''),
    '</tbody>',
    r.total ? `<tfoot>${ligne(r.total, 'th')}</tfoot>` : '',
    '</table>',
    `<p class="pied">Édité le ${escapeHtml(edite)} avec GestionLocal</p>`,
    '</body></html>',
  ].join('');

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const fenetre = window.open(url, '_blank');
  if (!fenetre) {
    URL.revokeObjectURL(url);
    return false;
  }
  // Pas de fermeture automatique, contrairement au reçu : on relit un rapport,
  // on le partage. L'URL est libérée quand l'onglet a fini de la charger.
  fenetre.addEventListener('load', () => {
    setTimeout(() => fenetre.print(), 300);
    URL.revokeObjectURL(url);
  }, { once: true });
  return true;
}
