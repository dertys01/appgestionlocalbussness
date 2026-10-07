// Le reçu d'une vente à moitié payée doit dire ce qui est payé et ce qui
// reste. C'est la seule chose que le client et le commerçant ont besoin de
// savoir au comptoir, et c'est aussi ce que le message WhatsApp doit porter : un
// « merci pour votre achat » à quelqu'un qui doit 80 000 F produit le pire
// effet possible.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateWhatsAppReceiptLink } from '../src/lib/utils/whatsapp.ts';

const base = {
  items: [{ product_name: 'Samsung A17', quantity: 1, unit_price: 130000, subtotal: 130000 }],
  total: 130000,
  date: new Date('2026-06-15T10:00:00Z'),
  businessName: 'Chez Koffi',
};

const texte = (url: string) => decodeURIComponent(url.split('?text=')[1]);

describe('Reçu WhatsApp — vente à crédit', () => {
  it('crédit total : annonce le montant et la dette', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'credit' }, '22997000001'));
    assert.match(m, /130\s?000/);
    assert.match(m, /à crédit/i);
    assert.match(m, /régler quand vous pouvez/i);
  });

  it('crédit total : ne dit jamais « merci pour votre achat »', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'credit' }, '22997000001'));
    assert.doesNotMatch(m, /Merci pour votre achat/);
  });

  it('acompte : sépare ce qui est versé de ce qui reste', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'credit', advance: 50000, due: 80000 }, '22997000001'));
    assert.match(m, /Déjà versé\s*:?\s*50\s?000/);
    assert.match(m, /Reste à régler\s*:?\s*80\s?000/);
  });

  it("acompte : n'annonce que le reste comme dette", () => {
    // C'est le point : annoncer 130 000 quand 50 000 sont dans la caisse est
    // la source de désaccord la plus fréquente entre un commerçant et son client.
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'credit', advance: 50000, due: 80000 }, '22997000001'));
    assert.match(m, /80\s?000/);
    assert.doesNotMatch(m, /Vous me devez 130/);
  });

  it('acompte intégral : un acquittement, pas un rappel de dette', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'credit', advance: 130000, due: 0 }, '22997000001'));
    assert.match(m, /Réglé en totalité/);
    assert.doesNotMatch(m, /Reste à régler/);
    assert.doesNotMatch(m, /à crédit/i);
  });

  it('espèces : le message reste un reçu, pas une relance', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'cash' }, '22997000001'));
    assert.match(m, /Merci pour votre achat/);
    assert.match(m, /Espèces/);
    assert.doesNotMatch(m, /Reste à régler/);
  });

  it('MoMo : le reçu nomme le moyen de paiement', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...base, paymentMethod: 'momo' }, '22997000001'));
    assert.match(m, /Mobile Money/);
  });

  it('le lien porte le numéro du client', () => {
    const url = generateWhatsAppReceiptLink({ ...base, paymentMethod: 'cash' }, '+229 97 00 00 01');
    assert.match(url, /^https:\/\/wa\.me\/22997000001\?text=/);
  });

  it('sans numéro, la barre oblique reste présente', () => {
    // `wa.me?text=` sans barre oblique s'ouvre sans message prérempli : le reçu
    // partait vide, et le commerçant ne comprenait pas pourquoi.
    const url = generateWhatsAppReceiptLink({ ...base, paymentMethod: 'cash' });
    assert.match(url, /^https:\/\/wa\.me\/\?text=/);
  });
});

// Depuis fin 2024 un mobile béninois s'écrit 01 + 8 chiffres. Un lien wa.me
// sans indicatif ne mène nulle part : la relance échouait sans rien dire.
describe('Lien WhatsApp — numéro béninois', () => {
  const numero = (tel: string) =>
    generateWhatsAppReceiptLink({ ...base, paymentMethod: 'cash' }, tel).split('?')[0];

  it('ajoute l\'indicatif au format actuel à 10 chiffres', () => {
    assert.equal(numero('01 97 00 00 01'), 'https://wa.me/2290197000001');
  });

  it('ajoute l\'indicatif à l\'ancien format à 8 chiffres', () => {
    assert.equal(numero('97000001'), 'https://wa.me/22997000001');
  });

  it('laisse un numéro déjà international tel quel', () => {
    assert.equal(numero('+229 01 97 00 00 01'), 'https://wa.me/2290197000001');
    assert.equal(numero('+225 07 07 07 07 07'), 'https://wa.me/2250707070707');
  });
});
