import type { Organization } from '@/types';

/**
 * Le ticket de cuisine.
 *
 * Ce qui s'imprime est exactement ce que la cuisine doit savoir : le plat, la
 * quantité, la cuisson et la note. PAS le prix — un cuisinier qui voit les
 * tarifs discute avec le client, et un ticket laissé sur la table devient une
 * facture que personne n'a edited. La vue `restaurant_kitchen_ticket` ne
 * contient d'ailleurs aucune colonne de prix : c'est vérifié par un test SQL.
 *
 * Même technique d'échappement que le reçu (print.ts) : le ticket s'ouvre
 * dans une fenêtre `blob:text/html` qui hérite de l'origine de l'app. Un nom
 * de plat contenant du HTML y exécuterait du JavaScript capable de voler la
 * session Supabase du restaurant.
 */

export interface KitchenTicketItem {
  product_name: string;
  quantity: number;
  note: string | null;
  modifier: string | null;
  status: 'new' | 'sent' | 'served';
}

export interface KitchenTicket {
  orderId: string;
  tableName: string | null;
  zone: string | null;
  openedAt: string | null;
  items: KitchenTicketItem[];
  org: Organization;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

/** 80 mm : la largeur d'un imprimante thermique de cuisine, pas d'une A4. */
const CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Courier New',monospace;font-size:12px;color:#000;padding:10px;width:72mm}
  h1{font-size:15px;font-weight:bold;text-align:center;margin-bottom:2px}
  .center{text-align:center}.bold{font-weight:bold}
  .label{color:#555;font-size:11px;margin-top:2px}
  .divider{border-top:1px dashed #000;margin:6px 0}
  .meta{font-size:11px;margin-bottom:4px}
  .item{font-size:14px;font-weight:bold;margin-top:6px;padding-left:2px}
  .qty{font-size:12px;margin-left:2px}
  .mod{font-size:12px;font-weight:bold;margin-left:2px;color:#000}
  .note{font-size:12px;margin-left:2px;font-style:italic}
  .empty{text-align:center;padding:16px 0;color:#555}
  @media print{button{display:none}}
`;

export function printKitchenTicket(ticket: KitchenTicket): boolean {
  const heure = ticket.openedAt
    ? new Date(ticket.openedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : null;

  const items = ticket.items
    .map((i) => {
      const parts = [
        `<div class="item">${escapeHtml(i.product_name)}</div>`,
        `<div class="qty">× ${escapeHtml(i.quantity)}</div>`,
      ];
      // La cuisson et la portion sont LA raison du ticket : sans elles, le
      // cuisinier cuisine ce qu'il a fait la dernière fois.
      if (i.modifier) parts.push(`<div class="mod">→ ${escapeHtml(i.modifier)}</div>`);
      if (i.note) parts.push(`<div class="note">« ${escapeHtml(i.note)} »</div>`);
      return parts.join('');
    })
    .join('');

  const html = [
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">`,
    `<title>Cuisine</title><style>${CSS}</style></head><body>`,
    `<h1>TICKET CUISINE</h1>`,
    `<p class="center label">${escapeHtml(ticket.org.name)}</p>`,
    `<div class="divider"></div>`,
    `<div class="meta">`,
    ticket.tableName
      ? `<div><span class="bold">${escapeHtml(ticket.tableName)}</span>${
          ticket.zone ? ` — ${escapeHtml(ticket.zone)}` : ''
        }</div>`
      : `<div class="bold">À emporter</div>`,
    heure ? `<div class="label">ouvert à ${escapeHtml(heure)}</div>` : '',
    `<div class="label">${escapeHtml(ticket.items.length)} ligne(s)</div>`,
    `</div><div class="divider"></div>`,
    items || `<div class="empty">Aucun plat à envoyer</div>`,
    `<div style="margin-top:14px;text-align:center">`,
    `<button onclick="window.print()" style="padding:8px 20px;cursor:pointer;border:1px solid #000;background:#fff;font-size:12px">`,
    `🖨 Imprimer</button></div>`,
    `</body></html>`,
  ].join('');

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'width=380,height=560');

  if (!popup) {
    URL.revokeObjectURL(url);
    return false;
  }

  // Alias non nullable : TypeScript ne propage pas le narrowing de `popup`
  // dans une déclaration de fonction hissée (même raison que dans print.ts).
  const win = popup;

  let settled = false;
  function close() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    win.close();
    URL.revokeObjectURL(url);
  }

  const timer = setTimeout(() => { win.print(); }, 400);
  win.addEventListener('afterprint', close, { once: true });
  win.focus();
  return true;
}