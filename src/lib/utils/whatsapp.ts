import type { Plan } from '@/types';
import { formatCFA } from './currency';
import { whatsappNumber } from './phone';

/**
 * Pied de page de diffusion (évaluation §6, P4) : les reçus et relances du
 * plan gratuit portent « Envoyé avec GestionLocal », retiré dès le Starter —
 * un client qui paie n'a pas à voir la marque d'un outil gratuit sur ses
 * documents. Renvoie des lignes prêtes pour un message WhatsApp (séparateur
 * compris) ; un écran HTML filtre la ligne vide et enveloppe le reste.
 */
export function piedDiffusion(plan?: Plan | null): string[] {
  return plan === 'free' ? ['', 'Envoyé avec GestionLocal'] : [];
}

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
  /** En crédit : ce qui a été versé sur-le-champ. 0 = rien. */
  advance?: number;
  /** En crédit : ce qui reste à recouvrer. */
  due?: number;
  /**
   * Plan effectif du point de vente (planEffectif(), essai compris). Le pied
   * de diffusion ne s'affiche que si c'est 'free' ; absent = pas de pied.
   */
  plan?: Plan;
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
  const { items, total, paymentMethod, date, businessName = 'Notre Boutique',
    advance = 0, due = 0, plan } = receipt;

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
    // Un reçu de crédit ne doit JAMAIS ressembler à un reçu payé, quels que
    // soient les arguments reçus. Si l'appelant oublie `due`, le reste dû vaut
    // le prix et non zéro : c'est le seul choix qui ne peut pas produire un
    // « merci pour votre achat » envoyé à quelqu'un qui n'a rien payé.
    const reste = paymentMethod === 'credit' && due <= 0 && advance <= 0 ? total : due;

    // Trois écritures possibles, et chacune dit autre chose au client :
    //   rien versé  → « total à crédit »
    //   acompte     → « 50 000 versés, 80 000 à régler » : c'est la réconciliation
    //                  immédiate, et c'est ce que le client a besoin de lire
    //   soldé       → ne devrait pas arriver ici, mais un acquittement vaut
    //                  mieux qu'un rappel de dette pour une dette soldée
    const lignesPaiement =
      reste > 0
        ? [
            `*Total : ${formatCFA(total)}*`,
            ...(advance > 0 ? [`Déjà versé : ${formatCFA(advance)}`] : []),
            `*Reste à régler : ${formatCFA(reste)}*`,
          ]
        : advance > 0
          ? [`*Total : ${formatCFA(total)}*`, `*Réglé en totalité*`]
          : [`*Total : ${formatCFA(total)}*`];

    const message = [
      `*${businessName}*`,
      ``,
      `Bonjour, voici le récapitulatif de votre achat :`,
      ``,
      itemLines,
      ``,
      ...lignesPaiement,
      ``,
      `Vendu le ${dateStr}`,
      ...(reste > 0 ? [`Paiement : à crédit`] : []),
      ``,
      reste > 0
        ? `Merci de passer régler quand vous pouvez.`
        : `Merci pour votre achat !`,
      ...piedDiffusion(plan),
    ].join('\n');

    return lien(message, phone);
  }

  const paymentLabel = paymentMethod === 'momo' ? 'Mobile Money' : 'Espèces';

  const message = [
    `*Reçu - ${businessName}*`,
    `${dateStr}`,
    ``,
    itemLines,
    ``,
    `*Total : ${formatCFA(total)}*`,
    `Paiement : ${paymentLabel}`,
    ``,
    `Merci pour votre achat !`,
    ...piedDiffusion(plan),
  ].join('\n');

  return lien(message, phone);
}

function lien(message: string, phone?: string): string {
  const encoded = encodeURIComponent(message);
  // `wa.me?text=` sans barre oblique n'est pas reconnu par WhatsApp : le lien
  // s'ouvrait mais sans message prérempli. La barre oblique est obligatoire,
  // y compris quand aucun destinataire n'est fourni.
  const base = phone
    ? `https://wa.me/${whatsappNumber(phone)}`
    : 'https://wa.me/';
  return `${base}?text=${encoded}`;
}
