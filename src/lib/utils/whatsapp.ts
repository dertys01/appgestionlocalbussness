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
  /** 'credit' = la marchandise est cédée, l'argent est dû. */
  paymentMethod: 'cash' | 'momo' | 'credit';
  date: Date;
  businessName?: string;
}

/**
 * Génère un lien WhatsApp avec le récapitulatif de la vente.
 *
 * En crédit, le message n'est pas un reçu : c'est un rappel de dette. Envoyer
 * « merci pour votre achat » à quelqu'un qui n'a rien payé produirait le pire
 * effet possible — le client se sentirait malhonnêtement traité et reviendrait
 * le moins possible.
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

  if (paymentMethod === 'credit') {
    const message = [
      `📝 *${businessName}*`,
      ``,
      `Bonjour, voici le récapitulatif de votre achat :`,
      ``,
      itemLines,
      ``,
      `*Total : ${formatCFA(total)}*`,
      ``,
      `📅 Vendu le ${dateStr}`,
      `💳 Paiement : à crédit`,
      ``,
      `Merci de passer régler quand vous pouvez. 🙏`,
    ].join('\n');

    return lien(message, phone);
  }

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

  return lien(message, phone);
}

function lien(message: string, phone?: string): string {
  const encoded = encodeURIComponent(message);
  // `wa.me?text=` sans barre oblique n'est pas reconnu par WhatsApp : le lien
  // s'ouvrait mais sans message prérempli. La barre oblique est obligatoire,
  // y compris quand aucun destinataire n'est fourni.
  const base = phone
    ? `https://wa.me/${phone.replace(/[^\d]/g, '')}`
    : 'https://wa.me/';
  return `${base}?text=${encoded}`;
}
