'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  ShoppingCart,
  Trash2,
  CreditCard,
  Handshake,
  Smartphone,
  Search,
  Share2,
  X,
  Printer,
  FileText,
  PackageX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCFA } from '@/lib/utils/currency';
import { rechercher } from '@/lib/utils/productSearch';
import { generateWhatsAppReceiptLink } from '@/lib/utils/whatsapp';
import { logActivity } from '@/lib/utils/activity';
import { printReceipt } from '@/lib/utils/print';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product, CartItem } from '@/types';

interface POSModuleProps {
  products: Product[];
  onSaleComplete?: () => void;
  /**
   * Produit à ajouter au panier (issu du scanner de la page parente).
   * Le panier vit dans ce composant : sans cette prop, un scan depuis la
   * barre latérale changeait d'onglet mais ne remplissait rien.
   */
  addToCartRequest?: { productId: string; token: number } | null;
  /**
   * Signale au parent que la demande ci-dessus a été traitée, pour qu'il la
   * remette à null. Sans ça la requête survit au remontage du POS (changement
   * d'onglet) et le produit réapparaît dans un panier vide.
   */
  onAddToCartHandled?: () => void;
}

type PaymentMethod = 'cash' | 'momo' | 'credit';

/**
 * Nombre de cartes produits rendues d'un coup. 60 tient sur deux écrans de
 * téléphone en colonne double, soit environ 2 000 nœuds DOM pour la grille —
 * au-delà, le défilement saccade sur un appareil d'entrée de gamme.
 */
const PRODUCT_PAGE_SIZE = 60;

/**
 * Quantité affichée : « 1,5 » et non « 1.50000001 » ni « 2 » pour 2 kg.
 *
 * Le point décimal est LOCAL — un Amount bruto s'affiche avec un point chez
 * les anglophones, une virgule chez nous. `maximumFractionDigits: 3` évite la
 *Notation scientifique sur les grands nombres.
 */
function formatQty(n: number): string {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
}

interface ReceiptState {
  saleId: string;
  /** Numéro de facture calculé par le serveur (Pro uniquement). */
  invoiceNumber: string | null;
  waLink: string;
  items: CartItem[];
  total: number;
  paymentMethod: PaymentMethod;
  clientName: string;
  clientPhone: string;
  amountGiven: number;
  change: number;
  date: Date;
  /** Vente à crédit : le reçu ne propose pas de monnaie, il propose de relancer. */
  isCredit: boolean;
  /** Acompte versé sur-le-champ, en crédit. 0 = rien reçu à la vente. */
  advance: number;
  /** Reste à recouvrer, renvoyé par la base. */
  due: number;
}

/**
 * Les exceptions de `create_sale` (supabase/migration_sales_rpc.sql) sont
 * rédigées pour être affichables telles quelles à la caissière. Les autres
 * messages (réseau, PostgREST) ne le sont pas.
 */
function readableSaleError(message: string): string {
  if (/^(Stock insuffisant|Produit introuvable|Panier vide|Moyen de paiement invalide)/.test(message)) {
    return message;
  }
  if (message === 'Non authentifié') return 'Session expirée, reconnectez-vous.';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "Connexion impossible. Vérifiez votre réseau et réessayez — la vente n'a pas été enregistrée.";
  }
  return "La vente n'a pas été enregistrée. Aucune modification n'a été appliquée.";
}

export function POSModule({ products, onSaleComplete, addToCartRequest, onAddToCartHandled }: POSModuleProps) {
  const { supabase, ownerId, actorName, org } = useSupabase();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanError, setScanError] = useState('');
  const [search, setSearch] = useState('');
  /** Catégorie retenue dans la barre de filtres ; null = tout le catalogue. */
  const [categorie, setCategorie] = useState<string | null>(null);
  /**
   * Quantités vendues par produit sur 30 jours, indexées par identifiant.
   *
   * `get_units_sold_since()` exige le plan pro : sur les autres plans l'appel
   * échoue, et l'absence de cette section ne doit surtout pas se lire comme une
   * erreur. Une boutique qui vend 200 références n'a pas besoin du classement
   * pour trouver un téléphone.
   */
  const [plusVendus, setPlusVendus] = useState<Record<string, number>>({});
  const rechercheRef = useRef<HTMLInputElement>(null);
  const [visibleCount, setVisibleCount] = useState(PRODUCT_PAGE_SIZE);
  // Une recherche remet la tranche au début : sans cela, taper « Nokia » après
  // avoir déroulé 400 produits affiche une grille vide alors qu'il y en a 3.
  const [lastSearch, setLastSearch] = useState('');
  if (search !== lastSearch) {
    setLastSearch(search);
    setVisibleCount(PRODUCT_PAGE_SIZE);
  }
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [amountGiven, setAmountGiven] = useState('');
  // Acompte versé sur une vente à crédit : ce que le client donne sur-le-champ.
  // Vide ou 0 = crédit total, le comportement le plus simple. « Laisse-moi
  // 50 000 sur 130 000 » est le geste le plus courant d'une boutique de quartier,
  // et sans ce champ il n'avait aucun moyen d'être enregistré.
  const [advance, setAdvance] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  /**
   * Sur mobile, le panier est un panneau plein écran plutôt qu'une colonne
   * sous la grille. En colonne il arrivait après les produits : avec 40
   * références, le caissier devait faire défiler tout le catalogue pour
   * atteindre le total et le bouton « Encaisser » — c'est-à-dire l'action
   * principale de l'écran, à chaque vente.
   */
  const [panierOuvert, setPanierOuvert] = useState(false);

  /**
   * Catalogue de la caisse : en stock, non archivé, puis filtré et classé.
   *
   * Le classement vient de `rechercher()`, qui tolère les fautes de frappe,
   * trouve une variante par son nombre (« 128/6 ») et un article par son prix.
   * Le simple `includes()` d'avant renvoyait « aucun résultat » sur une faute —
   * ce que le caissier lit comme une rupture de stock.
   */
  const disponibles = useMemo(
    () => products.filter((p) => p.stock_qty > 0 && p.is_active !== false),
    [products],
  );

  /**
   * Les + vendus remontent devant tout le reste.
   *
   * Dans une boutique de quartier, les mêmes références se vendent des
   * centaines de fois : les classer en tête rend la grille inutile. C'est
   * ce qui répond à « 1000 articles » : le classement rend la longueur du
   * catalogue indifférente.
   */
  const parFrequence = useMemo(() => {
    if (Object.keys(plusVendus).length === 0) return disponibles;
    return [...disponibles].sort((a, b) => {
      const va = plusVendus[a.id] ?? 0;
      const vb = plusVendus[b.id] ?? 0;
      if (va !== vb) return vb - va;
      return a.name.localeCompare(b.name, 'fr');
    });
  }, [disponibles, plusVendus]);

  const filtered = useMemo(() => {
    // La recherche porte sur TOUT le catalogue, jamais sur la seule catégorie
    // retenue. Filtrer sur « laptop » puis chercher « a17 » ne doit pas
    // disparaître : le caissier taperait trois mots de plus, ne trouverait
    // rien, croiraitait que le téléphone n'existe pas. La catégorie est un
    // filtre de parcours ; la recherche est une recherche.
    if (search.trim()) return rechercher(parFrequence, search).map((r) => r.product);
    return categorie === null
      ? parFrequence
      : parFrequence.filter((p) => (p.category ?? '') === categorie);
  }, [parFrequence, categorie, search]);

  /** Les catégories présentes dans le catalogue, pour la barre de filtres. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of parFrequence) if (p.category?.trim()) set.add(p.category.trim());
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }, [parFrequence]);

  /**
   * Les + vendus sur 30 jours.
   *
   * L'échec est silencieux et assumé : la fonction est verrouillée par plan, et
   * une bannière d'erreur au-dessus d'une grille de produits nuirait plus au
   * commerce qu'elle n'informerait.
   */
  const chargerPlusVendus = useCallback(async () => {
    if (!ownerId) return;
    try {
      const { data, error } = await supabase.rpc('get_units_sold_since', { p_days: 30 });
      if (error || !data) return;
      const map: Record<string, number> = {};
      for (const l of data as { product_id: string; quantity: number }[]) {
        if (l?.product_id) map[l.product_id] = Number(l.quantity ?? 0);
      }
      setPlusVendus(map);
    } catch {
      // plan gratuit ou starter : pas de classement, sans le dire.
    }
  }, [supabase, ownerId]);

  useEffect(() => {
    void chargerPlusVendus();
  }, [chargerPlusVendus]);

  /**
   * Une frappe sur une lettre met le curseur dans la recherche.
   *
   * C'est le geste de toutes les caisses à clavier : on commence à taper sans
   * viser un champ. Sans cela il faut viser le champ à la souris, puis taper —
   * deux gestes là où un seul suffit.
   */
  useEffect(() => {
    const surFrappe = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const cible = e.target as HTMLElement | null;
      if (cible) {
        const balise = cible.tagName;
        if (balise === 'INPUT' || balise === 'TEXTAREA' || balise === 'SELECT') return;
        if (cible.isContentEditable) return;
      }
      if (e.key.length !== 1 || e.key === ' ') return;
      rechercheRef.current?.focus();
    };
    window.addEventListener('keydown', surFrappe);
    return () => window.removeEventListener('keydown', surFrappe);
  }, []);

  // Rendu par tranches. La recherche porte sur tout le catalogue : une caissière
  // qui tape « Nokia » doit le trouver même si la carte est à la position 800.
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  );

  // Prix effectif de la ligne : prix convenu s'il y en a un, sinon catalogue.
  const linePrice = (item: CartItem) => item.unitPrice ?? item.product.price_sell;

  const total = useMemo(
    () => cart.reduce((sum, item) => sum + linePrice(item) * item.quantity, 0),
    [cart]
  );

  /** Remise totale accordée sur le panier, en FCFA. */
  const totalDiscount = useMemo(
    () => cart.reduce(
      (sum, item) => sum + (item.product.price_sell - linePrice(item)) * item.quantity,
      0
    ),
    [cart]
  );

  /** Lignes dont le prix convenu passe sous le prix d'achat. */
  const atLossLines = useMemo(
    () => cart.filter((i) => linePrice(i) < i.product.price_buy).length,
    [cart]
  );

  // ── Crédit client ──
  // Une vente à crédit exige un nom ET un téléphone : sans numéro, la dette
  // n'est rattachable à personne et la relance WhatsApp devient impossible.
  // On le signale pendant la saisie plutôt qu'après l'échec du serveur.
  const creditNeedsPhone = paymentMethod === 'credit' && !clientPhone.trim();

  // ── Acompte ──
  // Nombre tolérant : virgule ou point, c'est un clavier de téléphone.
  const advanceValue = Number(String(advance).replace(',', '.'));
  const advanceOk = !advance.trim() || (Number.isFinite(advanceValue) && advanceValue >= 0);
  const advanceAmount = advanceOk ? Math.min(advanceValue || 0, 1e12) : 0;
  // Un acompte supérieur au prix n'est pas un acompte, c'est un trop-perçu : le
  // serveur le refuse, et le signaler ici évite une erreur rouge après coup.
  const advanceTooHigh = paymentMethod === 'credit' && advanceAmount > total;
  const remaining = Math.max(total - advanceAmount, 0);
  const creditFormIncomplete =
    paymentMethod === 'credit' && (creditNeedsPhone || !clientName.trim() || !advanceOk || advanceTooHigh);

  const addToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock_qty) return prev;
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1, unitPrice: null }];
    });
  }, []);

  /**
   * Quantité saisie. Le champ est décimal : « 1,2 » comme « 1.2 » sont acceptés
   * — un clavier de téléphone au Bénin produit les deux.
   *
   * La valeur est bornée au stock, mais pas refusée au-delà : la caisse doit
   * pouvoir terminer sa saisie. C'est create_sale() qui refuse, avec un message
   * qui nomme le produit et les deux quantités.
   */
  const setLineQty = useCallback((productId: string, raw: string) => {
    setCart((prev) => prev.map((i) => {
      if (i.product.id !== productId) return i;
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) return i;
      return { ...i, quantity: Math.min(n, 1000000) };
    }));
  }, []);

  const setLinePrice = useCallback((productId: string, raw: string) => {
    setCart((prev) => prev.map((i) => {
      if (i.product.id !== productId) return i;
      // Vide = retour au prix catalogue, pas un prix à zéro.
      if (raw.trim() === '') return { ...i, unitPrice: null };
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return i;
      return { ...i, unitPrice: n };
    }));
  }, []);

  // Demande d'ajout venue du scanner (page parente). Le `token` permet de
  // re-scanner deux fois le même SKU : comparer la seule valeur de productId
  // ferait ignorer le second scan.
  //
  // La requête est CONSOMMÉE, pas simplement lue : addToCartRequest ne change
  // jamais dans le parent, alors que products, lui, est remplacé par un
  // nouveau tableau à chaque fetchProducts() — et onSaleComplete pointe
  // justement sur fetchProducts. Sans ce jeton, l'enchaînement « scan →
  // encaissement → setCart([]) → fetchProducts » relançait l'effet et
  // réajoutait le produit scanné au panier qu'on venait de vider.
  const consumedToken = useRef<number | null>(null);
  useEffect(() => {
    if (!addToCartRequest) return;
    // Déjà traité : on ne revient pas, quel que soit le nombre de refreshs.
    if (consumedToken.current === addToCartRequest.token) return;
    // Consommé d'office, y compris dans les branches de refus : sinon le
    // message « rupture de stock » réapparaîtrait à chaque actualisation, et
    // la requête survivrait au remontage du composant.
    consumedToken.current = addToCartRequest.token;
    onAddToCartHandled?.();

    const product = products.find((p) => p.id === addToCartRequest.productId);
    if (!product) {
      setScanError('Produit introuvable.');
      return;
    }
    if (product.stock_qty <= 0) {
      setScanError(`« ${product.name} » est en rupture de stock.`);
      return;
    }
    setScanError('');
    addToCart(product);
  }, [addToCartRequest, products, addToCart, onAddToCartHandled]);

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, []);

  const handleCheckout = async () => {
    if (cart.length === 0 || loading) return;
    setCheckoutError('');
    setLoading(true);

    try {
      const items = cart.map((i) => ({
        product_id: i.product.id,
        quantity: i.quantity,
        // Absent quand le prix catalogue s'applique : le serveur garde alors
        // son comportement habituel. Envoyé seulement s'il y a eu marchandage.
        ...(i.unitPrice !== null ? { unit_price: i.unitPrice } : {}),
      }));

      // Le crédit passe par record_credit_sale() et non create_sale() : c'est
      // elle qui rattache la vente à un numéro de téléphone et la marque non
      // encaissée. create_sale() refuse 'credit' volontairement — un appel
      // direct créerait une vente comptée comme encaissée, sans dette derrière.
      const fn = paymentMethod === 'credit' ? 'record_credit_sale' : 'create_sale';
      const payload = paymentMethod === 'credit'
        ? {
            p_items: items,
            p_client_name: clientName.trim(),
            p_client_phone: clientPhone.trim(),
            // Acompte : 0 = crédit total. La colonne amount_received en base ne
            // connaît que ce montant, donc c'est le seul endroit où il doit être
            // décidé.
            p_advance: advanceAmount,
          }
        : {
            p_items: items,
            p_payment_method: paymentMethod,
            p_client_name: clientName.trim() || null,
          };

      const { data, error: saleErr } = await supabase.rpc(fn, payload);

      if (saleErr) throw new Error(readableSaleError(saleErr.message));
      if (!data || typeof data !== 'object') throw new Error("La vente n'a pas pu être enregistrée.");

      // Total et numéro de facture sont ceux retenus par le serveur.
      const saleId = String(data.id);
      const serverTotal = Number(data.total_amount ?? total);
      const invoiceNumber = (data.invoice_number as string | null) ?? null;
      const creditPhone = (data as { client_phone?: string }).client_phone ?? null;

      // Journal d'activité : best-effort, ne doit pas faire échouer l'encaissement
      const { data: { user } } = await supabase.auth.getUser();
      if (user && ownerId) {
        const itemsDesc = cart
          .map((i) => `${i.quantity}x ${i.product.name}`)
          .join(', ');
        // La remise est mentionnée dans le journal : c'est elle qui rend la
        // concession lisible plus tard, quand le prix convenu n'est plus
        // déductible de la ligne de vente.
        const remise = Number((data as { discount_amount?: number })?.discount_amount ?? 0);
        const moyen = paymentMethod === 'cash' ? 'Espèces'
          : paymentMethod === 'momo' ? 'MoMo' : 'Crédit';
        await logActivity({
          ownerId,
          actorId: user.id,
          actorEmail: user.email ?? '',
          actorName,
          action: 'sale',
          description:
            `Vente ${formatCFA(serverTotal)} (${moyen}) — ${itemsDesc}` +
            (remise > 0 ? ` — remise ${formatCFA(remise)}` : ''),
          metadata: {
            sale_id: saleId,
            total: serverTotal,
            payment_method: paymentMethod,
            discount: remise,
            // Un crédit cède la marchandise sans encaissement : le dire dans le
            // journal est ce qui permet, des mois plus tard, de comprendre
            // pourquoi le chiffre d'affaires ne correspond pas aux articles
            // sortis du stock.
            ...(paymentMethod === 'credit' ? { credit_to: creditPhone } : {}),
          },
        });
      }

      // Lien WhatsApp. businessName et phone n'étaient jamais transmis : tous
      // les reçus disaient « Notre Boutique » et s'ouvraient sans destinataire.
      const waLink = generateWhatsAppReceiptLink(
        {
          // Prix réellement encaissé, pas le prix catalogue : envoyer un reçu
          // affichant 15 000 F pour une ligne négociée à 12 000 F met le client
          // et le commerçant en désaccord sur ce qui a été payé.
          items: cart.map((i) => ({
            product_name: i.product.name,
            quantity: i.quantity,
            unit_price: linePrice(i),
            subtotal: linePrice(i) * i.quantity,
          })),
          total: serverTotal,
          paymentMethod,
          date: new Date(),
          businessName: org?.name,
          // Acompte et reste dû, pour que le message dise la vérité au client.
          // Les deux sont calculés plus haut : sur un crédit, advanceAmount est l'acompte
          // saisi et remaining ce qui reste — les deux viennent du même calcul
          // que le bouton, donc pas de désaccord possible à l'écran.
          advance: paymentMethod === 'credit' ? advanceAmount : 0,
          due: paymentMethod === 'credit' ? remaining : 0,
        },
        clientPhone.trim() || undefined
      );

      const given = parseFloat(amountGiven) || 0;
      setReceipt({
        saleId,
        invoiceNumber,
        waLink,
        items: [...cart],
        total: serverTotal,
        paymentMethod,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        amountGiven: given,
        change: paymentMethod === 'cash' && given >= serverTotal ? given - serverTotal : 0,
        date: new Date(),
        // Après un crédit, on revient à l'espèces : enchaîner deux ventes à
        // crédit par inadvertance transformerait une boutique en bureau de
        // crédit sans que personne l'ait voulu.
        isCredit: paymentMethod === 'credit',
        // Renvoyés par la base, qui est la seule à savoir le prix retenu après
        // les remises. Les recalculer ici donnerait un reçu différent du dû en
        // cas d'arrondi.
        advance: Number((data as { amount_advance?: number }).amount_advance ?? 0),
        due: Number((data as { amount_due?: number }).amount_due ?? serverTotal),
      });
      setCart([]);
      setClientName('');
      setClientPhone('');
      setAmountGiven('');
      setAdvance('');
      // Le panneau se referme avec la vente : le caisser doit voir la grille
      // vide pour la vente suivante, pas un panier vide à faire fermer.
      setPanierOuvert(false);
      if (paymentMethod === 'credit') setPaymentMethod('cash');
      onSaleComplete?.();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full">
      {/* ── Grille produits ── */}
      {/* pb-24 : la barre du bas est fixe, sans cette réserve la dernière
          rangée de produits passe dessous et devient incliquable.
          inert : quand le panneau est ouvert il recouvre la grille, qui doit
          alors sortir du parcours de tabulation et des lecteurs d'écran —
          sinon le clavier saute dans un contenu que l'utilisateur ne voit pas. */}
      <div className="flex-1 space-y-4 pb-24 lg:pb-0" inert={panierOuvert}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            ref={rechercheRef}
            placeholder="Rechercher un produit, une variante ou un prix..."
            aria-label="Rechercher un produit, une variante ou un prix"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Barre de catégories, collante sous la recherche.
            C'est ce qui remplace le défilement quand le catalogue est grand :
            on choisit un rayon au lieu de parcours 1000 cartes. sticky pour que
            le filtre reste atteignable au milieu de la liste. */}
        {categories.length > 1 && (
          <div className="sticky top-14 lg:top-0 z-10 -mx-1 bg-slate-50/95 backdrop-blur px-1 py-1">
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filtrer par catégorie">
              <button
                onClick={() => setCategorie(null)}
                aria-pressed={categorie === null}
                className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                  categorie === null
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                Tous
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategorie(categorie === c ? null : c)}
                  aria-pressed={categorie === c}
                  className={`shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                    categorie === c
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Le compteur évite qu'un commerçant cherche un produit absent en
            croyant qu'il n'existe pas : avec 1 000 références, une grille
            tronquée sans indication paraît vide. */}
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {filtered.length} produit{filtered.length > 1 ? 's' : ''}
            {search.trim() && ` pour « ${search.trim()} »`}
            {search.trim() && categorie !== null && ' — tout le catalogue'}
          </span>
          {visibleProducts.length < filtered.length && (
            <span>affichage par tranches</span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {visibleProducts.map((p) => {
            const inCart = cart.find((i) => i.product.id === p.id);
            return (
              <button
                key={p.id}
                onClick={() => addToCart(p)}
                className="group relative text-left rounded-xl border border-slate-200 bg-white p-3 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all active:scale-95"
              >
                {inCart && (
                  <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">
                    {inCart.quantity}
                  </span>
                )}
                <div className="text-xs text-slate-500 mb-1">{p.category ?? '—'}</div>
                <div className="font-semibold text-slate-800 text-sm leading-tight line-clamp-2">
                  {p.name}
                </div>
                <div className="mt-2 font-bold text-indigo-600">{formatCFA(p.price_sell)}</div>
                <div className="text-xs text-slate-500">
                  Stock : {formatQty(p.stock_qty)} {p.unit ?? 'pce'}
                </div>
              </button>
            );
          })}

          {filtered.length === 0 && (
            <div className="col-span-full">
              {search.trim() ? (
                <div className="py-12 text-center text-sm text-slate-500">
                  Aucun produit ne correspond à « {search.trim()} »
                </div>
              ) : (
                <EmptyState
                  icon={PackageX}
                  title="Aucun produit disponible"
                  hint="Ajoutez d’abord vos produits depuis l’onglet Stock : ils apparaîtront ici pour la caisse."
                />
              )}
            </div>
          )}
        </div>

        {/* Pagination par tranches plutôt que rendu de 1 000 cartes : le DOM
            devient inutilisable sur un téléphone, et une caissière doit
            trouver un produit en deux secondes. La recherche porte toujours
            sur le catalogue entier, pas sur la tranche affichée. */}
        {visibleProducts.length < filtered.length && (
          <button
            onClick={() => setVisibleCount((n) => n + PRODUCT_PAGE_SIZE)}
            className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
          >
            Afficher plus de produits
            <span className="text-slate-500 font-normal">
              {' '}({visibleProducts.length} / {filtered.length})
            </span>
          </button>
        )}
      </div>

      {/* ── Panier ──
          Sur grand écran : une colonne à droite, toujours visible.
          Sur mobile : absent du flux, et la barre fixe du bas l'ouvre en
          plein écran. Sans cette bifurcation, il se retrouvait sous les
          produits — il fallait défiler tout le catalogue pour encaisser. */}
      <div
        className={
          panierOuvert
            ? 'fixed inset-0 z-40 bg-white flex flex-col gap-3 p-4 overflow-hidden'
            : 'hidden lg:flex lg:w-80 flex-col gap-3'
        }
      >
        <div className="flex items-center gap-2 font-semibold text-slate-700">
          <ShoppingCart className="h-5 w-5 text-indigo-600" />
          Panier
          {cart.length > 0 && (
            <Badge className="ml-auto bg-indigo-600">{cart.length}</Badge>
          )}
          {/* Présent seulement quand le panneau a été ouvert, c'est-à-dire
              depuis la barre du bas. Sans le `lg:hidden`, un passage en
              grand écran après ouverture (rotation du téléphone) laisserait
              la grille inerte sans issue visible pour la réactiver. */}
          {panierOuvert && (
            <button
              onClick={() => setPanierOuvert(false)}
              className="ml-auto p-1 text-slate-500 hover:text-slate-700"
              aria-label="Fermer le panier et revenir aux produits"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Articles — la zone défilante. En panneau mobile elle remplit la hauteur
            disponible et laisse le total puis « Encaisser » toujours
            atteignables en bas ; sur grand écran elle reste bornée pour ne
            pas pousser le total hors de l'écran. */}
        <div className="flex-1 space-y-2 overflow-y-auto pr-1 lg:max-h-[45vh]">
          {cart.length === 0 ? (
            <div className="text-center text-slate-500 py-10 text-sm">
              Cliquez sur un produit pour l&apos;ajouter
            </div>
          ) : (
            cart.map((item) => {
              const prix = linePrice(item);
              const remise = item.product.price_sell - prix;
              const sousCout = prix < item.product.price_buy;
              return (
              <Card
                key={item.product.id}
                className={`shadow-none ${remise ? 'border-amber-300' : 'border-slate-200'}`}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">
                        {item.product.name}
                      </div>
                      <div className="text-xs text-indigo-600 font-semibold">
                        {formatCFA(prix * item.quantity)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {/* Quantité saisie directement : un poids vendu ne
                          s'atteint pas avec des boutons +/-. Le champ reste
                          numérique pour le clavier mobile, et l'unité du
                          produit s'affiche à côté. */}
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min="0"
                        value={item.quantity}
                        onChange={(e) => setLineQty(item.product.id, e.target.value)}
                        aria-label={`Quantité pour ${item.product.name}`}
                        className="w-14 rounded-lg border border-slate-200 px-1.5 py-0.5 text-sm font-bold text-center focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <span className="text-[11px] text-slate-500 w-8">
                        {item.product.unit ?? 'pce'}
                      </span>
                      <button
                        aria-label="Retirer du panier"
                        onClick={() => removeFromCart(item.product.id)}
                        className="ml-1 text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Prix négocié : tapotable directement, sans menu. Un
                      marchandage se fait en trois secondes, un écran
                      supplémentaire le ferait abandonner. */}
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="1"
                        value={item.unitPrice ?? ''}
                        onChange={(e) => setLinePrice(item.product.id, e.target.value)}
                        placeholder={String(item.product.price_sell)}
                        aria-label={`Prix unitaire négocié pour ${item.product.name}`}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs pr-14 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-500 pointer-events-none">
                        {formatCFA(item.product.price_sell)}
                      </span>
                    </div>

                    {remise > 0 && (
                      <span className="text-[11px] font-medium text-amber-700 whitespace-nowrap">
                        −{formatCFA(remise * item.quantity)}
                      </span>
                    )}
                  </div>

                  {/* Vente sous le prix d'achat : signalée, jamais bloquée.
                      Écouler un stock aging est un motif légitime ; ce qui ne
                      l'est pas, c'est de le faire sans le savoir. */}
                  {sousCout && (
                    <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-1">
                      Sous le prix d&apos;achat ({formatCFA(item.product.price_buy)})
                    </p>
                  )}
                </CardContent>
              </Card>
              );
            })
          )}
        </div>

        {scanError && (
          <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {scanError}
          </p>
        )}

        {/* Nom + téléphone client. Facultatif en espèces et MoMo, obligatoire
            en crédit : sans numéro, la dette n'est rattachable à personne. */}
        <div className="border-t border-slate-200 pt-3 space-y-2">
          <Input
            aria-label="Nom du client"
            placeholder={creditNeedsPhone ? 'Nom du client *' : 'Nom du client (optionnel)'}
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className={`text-sm ${creditNeedsPhone ? 'border-amber-400' : ''}`}
          />
          <Input
            type="tel"
            inputMode="tel"
            aria-label="Téléphone du client"
            placeholder={creditNeedsPhone ? 'Téléphone du client *' : 'Téléphone WhatsApp (optionnel)'}
            value={clientPhone}
            onChange={(e) => setClientPhone(e.target.value)}
            className={`text-sm ${creditNeedsPhone ? 'border-amber-400' : ''}`}
          />
          {creditNeedsPhone && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Une vente à crédit exige le nom et le téléphone du client, sans quoi
              la dette ne peut pas être suivie.
            </p>
          )}
        </div>

        {/* Total */}
        <div className="border-t border-slate-200 pt-3 space-y-3">
          {/* Le prix catalogue reste visible quand une remise a été faite :
              sans lui, le commerçant ne peut plus contrôler ce qu'il
              concède, et l'écart se normalise sans qu'on s'en aperçoive. */}
          {totalDiscount > 0 && (
            <div className="flex justify-between text-xs text-slate-500">
              <span>Prix catalogue</span>
              <span className="line-through">{formatCFA(total + totalDiscount)}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold text-slate-800">
            <span>Total</span>
            <span className="text-indigo-600">{formatCFA(total)}</span>
          </div>
          {totalDiscount > 0 && (
            <div className="flex justify-between text-xs text-amber-700 font-medium">
              <span>Remise accordée</span>
              <span>− {formatCFA(totalDiscount)}</span>
            </div>
          )}
          {atLossLines > 0 && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
              {atLossLines} ligne(s) sous le prix d&apos;achat. La vente reste possible.
            </p>
          )}

          {/* Mode de paiement — trois colonnes : le crédit est aussi fréquent
              qu'un paiement normal dans une boutique de quartier, et
              l'enterrer dans un menu le ferait oublier. */}
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setPaymentMethod('cash')}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-2 text-xs font-medium transition-colors ${
                paymentMethod === 'cash'
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <CreditCard className="h-4 w-4" />
              Espèces
            </button>
            <button
              onClick={() => setPaymentMethod('momo')}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-2 text-xs font-medium transition-colors ${
                paymentMethod === 'momo'
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Smartphone className="h-4 w-4" />
              MoMo
            </button>
            <button
              onClick={() => setPaymentMethod('credit')}
              className={`flex flex-col items-center justify-center gap-1 rounded-lg border py-2 text-xs font-medium transition-colors ${
                paymentMethod === 'credit'
                  ? 'border-amber-500 bg-amber-50 text-amber-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Handshake className="h-4 w-4" />
              Crédit
            </button>
          </div>

          {paymentMethod === 'credit' && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Le stock part, mais le chiffre d&apos;affaires n&apos;augmente qu&apos;au
              moment du règlement. La dette apparaîtra dans l&apos;écran Dettes.
            </p>
          )}

          {/* Montant donné + monnaie (espèces uniquement) */}
          {paymentMethod === 'cash' && (
            <div className="space-y-2">
              <div className="space-y-1">
                <label htmlFor="pos-amount-given" className="text-xs font-medium text-slate-500">Montant donné (FCFA)</label>
                <Input
                  id="pos-amount-given"
                  type="number"
                  placeholder={String(total)}
                  value={amountGiven}
                  onChange={(e) => setAmountGiven(e.target.value)}
                  min={0}
                  className="text-sm"
                />
              </div>
              {parseFloat(amountGiven) >= total && (
                <div className="flex justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                  <span className="text-sm font-medium text-emerald-700">Monnaie à rendre</span>
                  <span className="text-sm font-bold text-emerald-700">
                    {formatCFA(parseFloat(amountGiven) - total)}
                  </span>
                </div>
              )}
              {parseFloat(amountGiven) > 0 && parseFloat(amountGiven) < total && (
                <div className="flex justify-between rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                  <span className="text-sm font-medium text-red-600">Reste à payer</span>
                  <span className="text-sm font-bold text-red-600">
                    {formatCFA(total - parseFloat(amountGiven))}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Acompte — le cas « il donne 50 000 sur 130 000 », plus courant en
              boutique de quartier que le crédit total. Le champ est vide par
              défaut : ne pas pré-remplir un champ à chaque vente ferait perdre le
              geste simple, qui est majoritaire. */}
          {paymentMethod === 'credit' && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-500">
                Acompte versé maintenant (FCFA)
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                placeholder="Rien — tout à crédit"
                value={advance}
                onChange={(e) => setAdvance(e.target.value)}
                className={`text-sm ${advanceTooHigh ? 'border-red-400' : ''}`}
              />
              {advanceTooHigh ? (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                  L&apos;acompte ne peut pas dépasser le prix de {formatCFA(total)}.
                </p>
              ) : (
                <div className="flex justify-between rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                  <span className="text-sm font-medium text-amber-800">Reste à recouvrer</span>
                  <span className="text-sm font-bold text-amber-900 tabular-nums">
                    {formatCFA(remaining)}
                  </span>
                </div>
              )}
              <p className="text-[11px] text-slate-500">
                L&apos;acompte compte au chiffre d&apos;affaires aujourd&apos;hui. Le reste
                apparaîtra dans l&apos;écran Dettes, et le client sera relance&apos; par
                WhatsApp.
              </p>
            </div>
          )}

          {checkoutError && (
            <p className="text-red-600 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              {checkoutError}
            </p>
          )}
          <Button
            onClick={handleCheckout}
            // Le crédit est bloqué tant que le nom, le téléphone ou l'acompte
            // sont inexploitables : le serveur refuserait de toute façon, et
            // mieux vaut le dire avant que renvoyer une erreur rouge après coup.
            disabled={cart.length === 0 || loading || creditFormIncomplete}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl"
          >
            {loading
              ? 'Enregistrement...'
              : paymentMethod === 'credit'
                ? advanceAmount > 0
                  ? `Encaisser ${formatCFA(advanceAmount)} — dû ${formatCFA(remaining)}`
                  : `Céder à crédit ${formatCFA(total)}`
                : `Encaisser ${formatCFA(total)}`}
          </Button>
        </div>
      </div>

      {/* ── Modal reçu ── */}
      <Dialog open={!!receipt} onOpenChange={() => setReceipt(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2 ${receipt?.isCredit ? 'text-amber-700' : 'text-emerald-700'}`}>
              {receipt?.isCredit ? '🤝 Vente cédée à crédit' : '✅ Vente enregistrée !'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-slate-600 text-sm text-center">
              {receipt?.isCredit
                ? receipt.advance > 0
                  // Avec acompte, la phrase doit dire ce qui est payé et ce qui
                  // reste — sinon la caissière ne sait pas quoi annoncer au
                  // client qui demande « je te dois combien ? ».
                  ? `${formatCFA(receipt.advance)} encaissés, ${formatCFA(receipt.due)} à recouvrer.`
                  : `${formatCFA(receipt.total)} à recouvrer. Comptabilisé au règlement.`
                : 'La vente a été enregistrée avec succès.'}
            </p>
            {receipt?.isCredit && receipt.advance > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-center">
                  <div className="text-[11px] text-emerald-700">Encaissé</div>
                  <div className="text-sm font-bold text-emerald-700 tabular-nums">
                    {formatCFA(receipt.advance)}
                  </div>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-center">
                  <div className="text-[11px] text-amber-700">Reste dû</div>
                  <div className="text-sm font-bold text-amber-800 tabular-nums">
                    {formatCFA(receipt.due)}
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              {/* WhatsApp — en crédit, le message sert de rappel de dette */}
              <a
                href={receipt?.waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] text-white font-semibold py-3 hover:bg-[#1ebe5d] transition-colors"
              >
                <Share2 className="h-4 w-4" />
                {receipt?.isCredit
                  ? 'Envoyer le rappel WhatsApp'
                  : receipt?.clientPhone
                    ? 'Envoyer le reçu WhatsApp'
                    : 'Partager le reçu WhatsApp'}
              </a>
              {!receipt?.clientPhone && (
                <p className="text-xs text-slate-500 text-center -mt-1">
                  Renseignez un téléphone ci-dessus pour envoyer directement au client.
                </p>
              )}

              {/* Reçu simple — tous les plans */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  if (!receipt || !org) return;
                  printReceipt({ ...receipt, org });
                }}
              >
                <Printer className="h-4 w-4" />
                Imprimer le reçu
              </Button>

              {/* Facture normalisée — Pro uniquement.
                  Le numéro est attribué par create_sale au moment de l'encaissement
                  (incrément atomique côté serveur), il n'est plus recalculé ici. */}
              {receipt?.invoiceNumber ? (
                <Button
                  variant="outline"
                  className="w-full gap-2 border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => {
                    if (!receipt || !org) return;
                    printReceipt({ ...receipt, org });
                  }}
                >
                  <FileText className="h-4 w-4" />
                  Facture normalisée
                </Button>
              ) : (
                <button
                  className="text-xs text-slate-500 flex items-center justify-center gap-1"
                  onClick={() => setReceipt(null)}
                >
                  <FileText className="h-3 w-3" />
                  Facture normalisée — Plan Pro uniquement
                </button>
              )}

              <Button variant="ghost" onClick={() => setReceipt(null)} className="w-full gap-2 text-slate-500">
                <X className="h-4 w-4" />
                Fermer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Barre fixe, mobile seulement ──
          Le total et l'accès à la caisse restent sous le pouce. Sans elle, le
          panier était une colonne sous la grille : le caissier défilait tout
          le catalogue pour vendre. Une seule cible, une seule action — ouvrir
          le panier, où le total et « Encaisser » sont déjà affichés. */}
      <button
        onClick={() => setPanierOuvert(true)}
        disabled={cart.length === 0}
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 flex items-center gap-3 border-t border-slate-200 bg-white px-4 py-3 text-left shadow-lg disabled:bg-white"
        aria-label={
          cart.length === 0
            ? 'Panier vide'
            : `Ouvrir le panier : ${cart.length} article${cart.length > 1 ? 's' : ''}, total ${formatCFA(total)}`
        }
      >
        <span className="relative shrink-0">
          <ShoppingCart className="h-5 w-5 text-indigo-600" />
          {cart.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-indigo-600 text-white text-[10px] leading-4 text-center font-bold">
              {cart.length}
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-xs text-slate-500">
            {cart.length === 0
              ? 'Panier vide'
              : `${cart.length} article${cart.length > 1 ? 's' : ''} · Total`}
          </span>
          <span className="block text-base font-bold text-slate-800">{formatCFA(total)}</span>
        </span>
        {cart.length > 0 && (
          <span className="ml-auto shrink-0 text-indigo-600 font-medium text-sm">Encaisser ›</span>
        )}
      </button>
    </div>
  );
}
