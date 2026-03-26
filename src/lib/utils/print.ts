import type { CartItem, Organization } from '@/types';

interface PrintData {
  items: CartItem[];
  total: number;
  paymentMethod: 'cash' | 'momo';
  clientName: string;
  amountGiven: number;
  change: number;
  date: Date;
  invoiceNumber?: string;
  org: Organization;
}

function fmtCFA(n: number) {
  return n.toLocaleString('fr-FR') + ' FCFA';
}

function pad(n: number) {
  return String(n).padStart(5, '0');
}

export function buildInvoiceNumber(org: Organization): string {
  return `FAC-${new Date().getFullYear()}-${pad(org.invoice_counter + 1)}`;
}

export function printReceipt(data: PrintData) {
  const isNormalized = !!data.invoiceNumber;
  const dateStr = data.date.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const rows = data.items.map((i) => [
    `<tr>`,
    `<td>${i.product.name}</td>`,
    `<td style="text-align:center">${i.quantity}</td>`,
    `<td style="text-align:right">${fmtCFA(i.product.price_sell)}</td>`,
    `<td style="text-align:right">${fmtCFA(i.product.price_sell * i.quantity)}</td>`,
    `</tr>`,
  ].join('')).join('');

  const vendorBlock = isNormalized ? [
    `<p class="bold fs13">FACTURE N° ${data.invoiceNumber}</p>`,
    `<p class="label">Date : ${dateStr}</p>`,
    `<div class="divider"></div>`,
    `<p class="bold">VENDEUR</p>`,
    `<p>${data.org.name}</p>`,
    data.org.address ? `<p>${data.org.address}</p>` : '',
    data.org.ifu    ? `<p>IFU : ${data.org.ifu}</p>` : '',
  ].join('') : [
    `<h1>${data.org.name}</h1>`,
    `<p class="center label">${dateStr}</p>`,
  ].join('');

  const clientBlock = isNormalized && data.clientName ? [
    `<div class="divider"></div>`,
    `<p class="bold">CLIENT</p>`,
    `<p>${data.clientName}</p>`,
  ].join('') : '';

  const footer = !isNormalized
    ? `<div class="divider"></div><p class="center mt8">Merci de votre visite !</p>`
    : '';

  const html = [
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">`,
    `<title>${isNormalized ? data.invoiceNumber : 'Reçu'}</title>`,
    `<style>`,
    `*{margin:0;padding:0;box-sizing:border-box}`,
    `body{font-family:'Courier New',monospace;font-size:12px;color:#000;padding:16px;max-width:320px;margin:auto}`,
    `h1{font-size:16px;text-align:center;font-weight:bold;margin-bottom:2px}`,
    `.center{text-align:center}.divider{border-top:1px dashed #000;margin:8px 0}`,
    `.bold{font-weight:bold}.label{color:#555;font-size:11px}.fs13{font-size:13px}.mt8{margin-top:8px}`,
    `table{width:100%;border-collapse:collapse;margin:8px 0}`,
    `th{font-size:10px;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:4px}`,
    `td{padding:2px 0;vertical-align:top}`,
    `.total-row td{font-size:14px;font-weight:bold;border-top:1px solid #000;padding-top:6px}`,
    `@media print{button{display:none}}`,
    `</style></head><body>`,
    vendorBlock,
    clientBlock,
    `<div class="divider"></div>`,
    `<table><thead><tr>`,
    `<th style="text-align:left">Article</th>`,
    `<th style="text-align:center">Qté</th>`,
    `<th style="text-align:right">P.U.</th>`,
    `<th style="text-align:right">Total</th>`,
    `</tr></thead><tbody>${rows}</tbody></table>`,
    `<div class="divider"></div>`,
    `<table>`,
    `<tr class="total-row"><td colspan="3">TOTAL</td><td style="text-align:right">${fmtCFA(data.total)}</td></tr>`,
    `<tr><td colspan="3" class="label">Paiement</td><td style="text-align:right">${data.paymentMethod === 'momo' ? 'Mobile Money' : 'Espèces'}</td></tr>`,
    data.paymentMethod === 'cash' && data.amountGiven >= data.total
      ? `<tr><td colspan="3" class="label">Reçu</td><td style="text-align:right">${fmtCFA(data.amountGiven)}</td></tr>` +
        `<tr><td colspan="3" class="label bold">Monnaie</td><td style="text-align:right" class="bold">${fmtCFA(data.change)}</td></tr>`
      : '',
    `</table>`,
    footer,
    `<div style="margin-top:16px;text-align:center">`,
    `<button onclick="window.print()" style="padding:8px 20px;cursor:pointer;border:1px solid #000;background:#fff;font-size:12px">`,
    `\uD83D\uDDA8 Imprimer</button></div>`,
    `</body></html>`,
  ].join('');

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'width=420,height=620');
  if (!win) return;
  win.focus();
  setTimeout(() => {
    win.print();
    win.onafterprint = () => { win.close(); URL.revokeObjectURL(url); };
  }, 400);
}
