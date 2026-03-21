import { formatCFA } from './currency';

interface SaleItem {
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

interface SaleReceipt {
  items: SaleItem[];
  total: number;
  paymentMethod: 'cash' | 'momo';
  date: Date;
  businessName?: string;
}

/**
 * Génère un lien WhatsApp avec le récapitulatif de la vente
 */
export function generateWhatsAppReceiptLink(receipt: SaleReceipt, phone?: string): string {
  const { items, total, paymentMethod, date, businessName = 'Notre Boutique' } = receipt;

  const dateStr = date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const itemLines = items
    .map((i) => `• ${i.product_name} x${i.quantity} = ${formatCFA(i.subtotal)}`)
    .join('\n');

  const paymentLabel = paymentMethod === 'momo' ? 'Mobile Money' : 'Espèces';

  const message = [
    `🧾 *Reçu - ${businessName}*`,
    `📅 ${dateStr}`,
    ``,
    itemLines,
    ``,
    `💰 *Total : ${formatCFA(total)}*`,
    `💳 Paiement : ${paymentLabel}`,
    ``,
    `Merci pour votre achat ! 🙏`,
  ].join('\n');

  const encoded = encodeURIComponent(message);
  const base = phone ? `https://wa.me/${phone}` : `https://wa.me`;
  return `${base}?text=${encoded}`;
}
