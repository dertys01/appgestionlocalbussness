'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UtensilsCrossed, Loader2, Plus, Users, Clock, CheckCircle2, PackageX, ChefHat,
} from 'lucide-react';

import { useSupabase } from '@/components/providers/SupabaseProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { logActivity } from '@/lib/utils/activity';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';
import type { Product } from '@/types';

/**
 * La salle : le plan des tables et la commande en cours.
 *
 * Ce module ne fait PAS d'encaissement. Une commande vit sur sa table jusqu'à
 * sa clôture (Sprint 14, qui écrira la vente) : ici on prend la commande, on
 * marque ce qui part en cuisine et ce qui est servi. Le stock n'est pas
 * touché tant que la commande n'est pas close — le serveur ne « vend » rien.
 */

interface TableRow {
  id: string;
  name: string;
  zone: string;
  seats: number | null;
  is_active: boolean;
  order_id: string | null;
  status: 'open' | 'bill_requested' | null;
  customer_name: string | null;
  opened_at: string | null;
  amount_paid: number;
  order_total: number;
}

interface OrderLine {
  id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  note: string | null;
  status: 'new' | 'sent' | 'served';
  name?: string;
}

const STATUT_LIBELLE = {
  open: 'En service',
  bill_requested: 'Addition demandée',
} as const;

const minutesDepuis = (iso: string | null) => {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
};

export function FloorModule({ products }: { products: Product[] }) {
  const { supabase, ownerId, actorName, user, canManageProducts, isEmployee } = useSupabase();

  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Commande ouverte sélectionnée. On retient l'IDENTITÉ de la table, pas sa
  // lignecopiée : la vue restaurant_floor la rafraîchit (montant, statut) et le
  // rendu prend toujours la version la plus récente quand elle existe.
  const [orderId, setOrderId] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<{ tableId: string; nom: string; client: string | null } | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  // Saisie
  const [clientName, setClientName] = useState('');
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newTableName, setNewTableName] = useState('');

  // Le client Supabase n'est typé sur aucun schéma : les noms de colonnes ne
  // sont pas vérifiés. Une petite surface typée vaut mieux que des `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const loadTables = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await db
      .from('restaurant_floor')
      .select('id, name, zone, seats, is_active, order_id, status, customer_name, opened_at, amount_paid, order_total')
      .order('zone')
      .order('name');
    setLoading(false);
    if (err) { setError(err.message); return; }
    setTables((data ?? []) as TableRow[]);
  }, [db]);

  const loadLines = useCallback(async (id: string) => {
    setLinesLoading(true);
    const { data, error: err } = await db
      .from('restaurant_order_items')
      .select('id, product_id, quantity, unit_price, note, status, product:products(name)')
      .eq('order_id', id)
      .order('created_at');
    setLinesLoading(false);
    if (err) { setError(err.message); return; }
    setLines(
      ((data ?? []) as Array<Omit<OrderLine, 'name'> & { product: { name: string } | null }>).map((l) => ({
        ...l,
        name: l.product?.name ?? 'Produit',
      }))
    );
  }, [db]);

  // Les effets encapsulent l'appel async plutôt que d'appeler loadTables()
// directement : setLoading(true) serait alors un setState synchrone dans un
// effet, ce qui provoque un rendu en cascade (react-hooks/set-state-in-effect).
  useEffect(() => {
    const t = setTimeout(() => { void loadTables(); }, 0);
    return () => clearTimeout(t);
  }, [loadTables]);

  useEffect(() => {
    if (!orderId) return;
    const id = orderId;
    const t = setTimeout(() => { void loadLines(id); }, 0);
    return () => clearTimeout(t);
  }, [orderId, loadLines]);

  // La vue recharge la commande ouverte (montant, statut) : on la reprend dès
  // qu'elle est revenue, sinon le panneau afficherait un total à zéro. Un effet
  // qui appelle setState ici déclencherait un rendu en cascade — d'où la
  // dérivation ci-dessous, purement calculée au rendu.
  const tableOuverte: TableRow | null = useMemo(() => {
    const vue = tables.find((t) => t.order_id === orderId);
    if (vue) return vue;
    if (!ouverte || !orderId) return null;
    return {
      id: ouverte.tableId,
      name: ouverte.nom,
      zone: '',
      seats: null,
      is_active: true,
      order_id: orderId,
      status: 'open',
      customer_name: ouverte.client,
      opened_at: null,
      amount_paid: 0,
      order_total: 0,
    };
  }, [tables, orderId, ouverte]);

  // Une commande ouverte sur une table : c'est ce que le serveur fait en
  // arrivant. Le nom du client est facultatif — la table parle déjà.
  const openOrder = async (tableId: string) => {
    if (!ownerId) return;
    setBusy(true);
    setError('');
    const { data, error: err } = await db
      .from('restaurant_orders')
      .insert({
        owner_id: ownerId,
        table_id: tableId,
        customer_name: clientName.trim() || null,
        opened_by: user?.id ?? null,
      })
      .select('id')
      .single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    setClientName('');
    // La table vient d'être ouverte : on retient son identité pour que le panneau
    // existe avant le prochain rechargement de la vue.
    const table = tables.find((t) => t.id === tableId);
    if (table) setOuverte({ tableId, nom: table.name, client: clientName.trim() || null });
    setOrderId(data.id);
    await loadTables();
  };

  const addLine = async (product: Product) => {
    if (!orderId) return;
    const n = lireMontant(qty) ?? 1;
    if (n <= 0) return;
    setBusy(true);
    setError('');
    const { error: err } = await db.from('restaurant_order_items').insert({
      order_id: orderId,
      product_id: product.id,
      quantity: n,
      // Prix convenu : comme au POS, le patron négocie à la table.
      unit_price: product.price_sell,
      note: note.trim() || null,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setQty('');
    setNote('');
    await Promise.all([loadLines(orderId), loadTables()]);
  };

  const cycleLine = async (line: OrderLine) => {
    if (!orderId) return;
    const suivant = line.status === 'new' ? 'sent' : line.status === 'sent' ? 'served' : 'new';
    const { error: err } = await db
      .from('restaurant_order_items')
      .update({ status: suivant })
      .eq('id', line.id);
    if (err) { setError(err.message); return; }
    await loadLines(orderId);
  };

  const removeLine = async (line: OrderLine) => {
    if (!orderId) return;
    const { error: err } = await db.from('restaurant_order_items').delete().eq('id', line.id);
    if (err) { setError(err.message); return; }
    await Promise.all([loadLines(orderId), loadTables()]);
  };

  const addTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerId || !newTableName.trim()) return;
    setBusy(true);
    const { error: err } = await db.from('restaurant_tables').insert({
      owner_id: ownerId,
      name: newTableName.trim(),
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setNewTableName('');
    await loadTables();
    if (user) {
      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: 'restaurant_table_add',
        description: `Table ajoutée : ${newTableName.trim()}`,
      });
    }
  };

  // Recherche : même tolérance que la caisse (fautes de frappe), pour qu'un
  // serveur ne doive pas épeler un plat au client.
  const resultats = useMemo(() => {
    const q = search.trim().toLowerCase();
    const actifs = products.filter((p) => p.is_active !== false);
    if (!q) return actifs.slice(0, 12);
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nq = norm(q);
    return actifs
      .map((p) => {
        const n = norm(p.name);
        if (n.includes(nq)) return { p, rang: 0 };
        if (norm(p.sku ?? '').includes(nq)) return { p, rang: 1 };
        if (n.startsWith(nq)) return { p, rang: 2 };
        return null;
      })
      .filter((x): x is { p: Product; rang: number } => x !== null)
      .sort((a, b) => a.rang - b.rang)
      .map((x) => x.p)
      .slice(0, 12);
  }, [products, search]);

  const totalLignes = lines.reduce((n, l) => n + Number(l.quantity) * Number(l.unit_price), 0);

  // ── Clôture ────────────────────────────────────────────────
  // Fractionner ne multiplie PAS les ventes : trois convives à 12 000 F font
  // une vente de 36 000 F, répartie en 3 parts pour l'affichage. La part de
  // chacun est donc purement visuelle, et c'est le total qu'on encaisse.
  const [splitCount, setSplitCount] = useState(1);
  const [splitOpen, setSplitOpen] = useState(false);
  const [payment, setPayment] = useState<'cash' | 'momo'>('cash');
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<{ total: number; paid: number; invoice: string | null; saleId: string; perShare: number } | null>(null);
  // Le caissier encaisse en salle mais ne solde pas : la clôture écrit dans
  // sales, c'est la vente du patron. Le patron peut, lui.
  const peutEncaisser = !isEmployee || canManageProducts;

  const part = splitCount > 0 ? Math.round((totalLignes / splitCount) * 100) / 100 : 0;

  const closeOrder = async () => {
    if (!orderId) return;
    setClosing(true);
    setError('');
    const { data, error: err } = await db.rpc('close_table_order', {
      p_order_id: orderId,
      p_payment_method: payment,
      p_split_count: splitCount,
      // Une addition à crédit exige un numéro : close_table_order() le refuse
      // sans, sinon la dette ne serait rattachable à personne. Le Sprint 16
      // ouvrira le crédit depuis cet écran ; ici on ne l'expose pas.
      p_client_phone: null,
    });
    setClosing(false);
    if (err) { setError(err.message); return; }
    const r = data as { total_amount: number; amount_paid: number; invoice_number: string | null; sale_id: string; per_share: number };
    setClosed({
      total: Number(r.total_amount),
      paid: Number(r.amount_paid),
      invoice: r.invoice_number ?? null,
      saleId: r.sale_id,
      perShare: Number(r.per_share),
    });
    // La commande disparaît du plan : la table redevient libre.
    setOrderId(null);
    setOuverte(null);
    setLines([]);
    setSplitOpen(false);
    await loadTables();
  };

  const sendToKitchen = async () => {
    if (!orderId) return;
    setBusy(true);
    setError('');
    const { error: err } = await db.rpc('send_order_items', { p_order_id: orderId });
    setBusy(false);
    if (err) { setError(err.message); return; }
    await loadLines(orderId);
  };

  // ── Aucune table : le module n'a rien à montrer tant que la salle est vide
  if (!loading && tables.length === 0) {
    return (
      <div className="space-y-4">
        {error && (
          <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <EmptyState
          icon={UtensilsCrossed}
          title="Aucune table configurée"
          hint={
            canManageProducts
              ? 'Créez vos tables pour prendre les commandes en salle. Le point de vente reste disponible pour le comptoir.'
              : 'Votre patron n’a pas encore créé les tables. Vous pouvez encaisser au point de vente.'
          }
        />
        {canManageProducts && (
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <form onSubmit={addTable} className="flex gap-2">
                <Input
                  value={newTableName}
                  onChange={(e) => setNewTableName(e.target.value)}
                  placeholder="Nom de la table (ex: Table 1)"
                  aria-label="Nom de la table"
                />
                <Button type="submit" disabled={busy} className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Ajouter
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* ── Addition encaissée ── */}
      {closed && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-4 space-y-1">
            <p className="text-sm font-semibold text-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Addition encaissée
            </p>
            <p className="text-xs text-emerald-700">
              {formatCFA(closed.total)}
              {closed.invoice ? ` · facture ${closed.invoice}` : ''}
              {closed.perShare !== closed.total ? ` · ${formatCFA(closed.perShare)} par part` : ''}
            </p>
            <button
              onClick={() => setClosed(null)}
              className="text-xs text-emerald-700 underline"
            >
              Fermer
            </button>
          </CardContent>
        </Card>
      )}

      {/* ── Plan de la salle ── */}
      {tables.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {tables.map((t) => {
            const libre = !t.order_id;
            const minutes = minutesDepuis(t.opened_at);
            const actif = t.order_id === orderId;
            return (
              <button
                key={t.id}
                onClick={() => {
                  if (libre) { void openOrder(t.id); return; }
                  setOuverte({ tableId: t.id, nom: t.name, client: t.customer_name });
                  setOrderId(t.order_id);
                }}
                disabled={busy}
                className={`text-left rounded-xl border-2 p-3 transition-colors disabled:opacity-60 ${
                  actif
                    ? 'border-indigo-500 bg-indigo-50'
                    : libre
                      ? 'border-slate-200 bg-white hover:border-emerald-300'
                      : t.status === 'bill_requested'
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-indigo-200 bg-white hover:border-indigo-300'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-slate-800 text-sm truncate">{t.name}</span>
                  {!t.is_active && <Badge className="bg-slate-100 text-slate-500 text-[10px] py-0">fermée</Badge>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                  {libre ? (
                    <><span className="text-emerald-600 font-medium">Libre</span></>
                  ) : (
                    <>
                      <span className={t.status === 'bill_requested' ? 'text-amber-700 font-medium' : 'text-indigo-600 font-medium'}>
                        {STATUT_LIBELLE[t.status ?? 'open']}
                      </span>
                      {minutes !== null && <><span>·</span><Clock className="h-3 w-3" /><span>{minutes} min</span></>}
                    </>
                  )}
                </div>
                {!libre && (
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-sm font-bold text-indigo-600">{formatCFA(t.order_total)}</span>
                    {t.seats && <span className="text-[10px] text-slate-400">{t.seats} pl.</span>}
                  </div>
                )}
                {t.customer_name && (
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">{t.customer_name}</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Commande ouverte ── */}
      {orderId && tableOuverte && (
        <Card className="border-indigo-200">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 text-sm">
                {tableOuverte.name}
                {tableOuverte.customer_name ? ` · ${tableOuverte.customer_name}` : ''}
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setOrderId(null); setOuverte(null); setLines([]); }}
              >
                Fermer le panneau
              </Button>
            </div>

            {/* Lignes */}
            {linesLoading ? (
              <p className="text-sm text-slate-500 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
              </p>
            ) : lines.length === 0 ? (
              <p className="text-sm text-slate-500 py-3 text-center">
                Aucun plat commandé. Choisissez ci-dessous.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {lines.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => cycleLine(l)}
                      className="shrink-0"
                      aria-label={`État de ${l.name} : ${l.status === 'new' ? 'à envoyer' : l.status === 'sent' ? 'envoyé' : 'servi'}. Changer.`}
                      title={l.status === 'new' ? 'À envoyer' : l.status === 'sent' ? 'Envoyé' : 'Servi'}
                    >
                      <Badge
                        className={
                          l.status === 'new'
                            ? 'bg-slate-100 text-slate-600 hover:bg-slate-100'
                            : l.status === 'sent'
                              ? 'bg-amber-100 text-amber-700 hover:bg-amber-100'
                              : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                        }
                      >
                        {l.status === 'new' ? 'À envoyer' : l.status === 'sent' ? 'Envoyé' : 'Servi'}
                      </Badge>
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800 truncate">
                        {formatQty(l.quantity)} × {l.name}
                      </div>
                      {l.note && <div className="text-xs text-amber-700 truncate">{l.note}</div>}
                    </div>
                    <span className="text-sm font-medium text-slate-700 whitespace-nowrap">
                      {formatCFA(Number(l.quantity) * Number(l.unit_price))}
                    </span>
                    <button
                      onClick={() => removeLine(l)}
                      aria-label={`Retirer ${l.name} de la commande`}
                      className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-b-lg">
                  <span className="text-sm font-medium text-slate-600">Total</span>
                  <span className="font-bold text-indigo-600">{formatCFA(totalLignes)}</span>
                </div>
              </div>
            )}

            {/* Encaissement */}
            {lines.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={sendToKitchen}
                    disabled={busy || !lines.some((l) => l.status === 'new')}
                    className="gap-1.5"
                  >
                    <ChefHat className="h-3.5 w-3.5" /> Tout est parti en cuisine
                  </Button>

                  {!splitOpen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { // 2 parts par défaut : c'est le cas le plus fréquent (« on est deux »), et
                      // l'utilisateur ajuste immédiatement s'il est trois.
                      setSplitCount(2); setSplitOpen(true); }}
                      className="gap-1.5"
                    >
                      <Users className="h-3.5 w-3.5" /> Partager l&apos;addition
                    </Button>
                  ) : null}
                </div>

                {splitOpen && (
                  <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600">Répartir en</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSplitCount((n) => Math.max(2, n - 1))}
                          aria-label="Moins de parts"
                          className="h-7 w-7 rounded-lg border border-slate-200 text-slate-600"
                        >
                          −
                        </button>
                        <span className="font-semibold text-slate-800 w-6 text-center">{splitCount}</span>
                        <button
                          onClick={() => setSplitCount((n) => Math.min(20, n + 1))}
                          aria-label="Plus de parts"
                          className="h-7 w-7 rounded-lg border border-slate-200 text-slate-600"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatCFA(part)} par personne. L&apos;addition reste
                      {' '}<strong>{formatCFA(totalLignes)}</strong> : une seule vente est écrite,
                      le partage est pour l&apos;affichage.
                    </p>
                    <button
                      onClick={() => setSplitOpen(false)}
                      className="text-xs text-slate-500 hover:text-slate-700 underline"
                    >
                      Annuler le partage
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                    {(['cash', 'momo'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setPayment(m)}
                        aria-pressed={payment === m}
                        className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                          payment === m ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600'
                        }`}
                      >
                        {m === 'cash' ? 'Espèces' : 'Mobile Money'}
                      </button>
                    ))}
                  </div>

                  {peutEncaisser ? (
                    <Button
                      onClick={closeOrder}
                      disabled={closing}
                      className="bg-emerald-700 hover:bg-emerald-800 gap-2"
                    >
                      {closing
                        ? <><Loader2 className="h-4 w-4 animate-spin" /> Encaissement…</>
                        : <><CheckCircle2 className="h-4 w-4" /> Encaisser {formatCFA(totalLignes)}</>}
                    </Button>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Demandez l&apos;addition : seul le patron encaisse.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Ajout */}
            <div className="space-y-2 pt-1">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Chercher un plat…"
                aria-label="Chercher un plat à commander"
              />
              <div className="flex gap-2">
                <Input
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="Qté"
                  aria-label="Quantité"
                  className="w-24"
                />
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note cuisine (ex: peu épicé)"
                  aria-label="Note cuisine"
                />
              </div>
              {resultats.length === 0 ? (
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <PackageX className="h-3.5 w-3.5" /> Aucun produit ne correspond. Ajoutez-le depuis l&apos;onglet Stock.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {resultats.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => addLine(p)}
                      disabled={busy}
                      className="rounded-lg border border-slate-200 px-2 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50/40 disabled:opacity-60"
                    >
                      <span className="block text-xs font-medium text-slate-800 truncate">{p.name}</span>
                      <span className="block text-xs text-indigo-600">{formatCFA(p.price_sell)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Le stock n'est pas touché ici : c'est la règle que le test vérifie. */}
            <p className="text-[11px] text-slate-500">
              <CheckCircle2 className="h-3 w-3 inline -mt-0.5 mr-1" />
              Le stock n&apos;est décrémenté qu&apos;à la clôture de l&apos;addition.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Détail d'une table occupée, sans commande ouverte dans le panneau ── */}
      {!orderId && tables.some((t) => t.order_id) && (
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Touchez une table occupée pour ouvrir sa commande.
        </p>
      )}
    </div>
  );
}