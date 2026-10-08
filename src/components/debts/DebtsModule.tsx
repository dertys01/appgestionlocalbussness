'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, MessageCircle, Loader2, Handshake, TrendingUp, X, FileSpreadsheet, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { readablePlanError } from '@/lib/utils/planErrors';
import { whatsappNumber } from '@/lib/utils/phone';
import { isFeatureAllowed } from '@/lib/utils/plans';
import { piedDiffusion } from '@/lib/utils/whatsapp';
import type { Plan } from '@/types';
import { downloadCSV, toCSV } from '@/lib/utils/export';
import { imprimerRapport } from '@/lib/utils/rapport';

interface Debt {
  debt_id: string;
  phone: string;
  name: string | null;
  total_due: number;
  /** Déjà versé sur ces ventes, acomptes compris. */
  total_paid: number;
  last_sale_at: string | null;
  sales_count: number;
  oldest_sale_at: string | null;
  payments_count: number;
  last_payment_at: string | null;
}

const PAGE = 20;

/** Numéro lisible : 22997000001 → « 97 00 00 01 ». */
function prettyPhone(phone: string): string {
  const d = phone.replace(/^229/, '');
  return d.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Le carnet de dette.
 *
 * Une vente à crédit sort la marchandise mais n'entre pas dans le chiffre
 * d'affaires : l'écran d'encaissement l'a déjà fait, et c'est ici qu'on suit ce
 * qui reste à recouvrer. Le tri par ancienneté n'est pas décoratif — la dette la
 * plus vieille est celle qu'il faut relancer, et celle qu'un commerçant oublie
 * en premier.
 */
export function DebtsModule() {
  const { supabase, canManageProducts, plan, org } = useSupabase();
  const [debts, setDebts] = useState<Debt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  /**
   * Moyen du règlement en cours de saisie.
   *
   * L'argent reçu d'un client ne peut pas être en Mobile Money ET en espèces.
   * La fonction le demande déjà (p_method), et le module envoyait « cash » en
   * dur : une boutique qui encaisse par Orange Money voyait cet argent entrer
   * dans le total « Espèces » du rapport. Le choix est donc ici, à côté du
   * montant — c'est de l'information que le caissier a sous les yeux au
   * moment de compter.
   */
  const [method, setMethod] = useState<'cash' | 'momo'>('cash');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Fonction SECURITY INVOKER : l'isolation vient de la RLS de sales et
      // customer_debts, pas d'un filtre manuel dans la requête.
      const { data, error: err } = await supabase.rpc('get_customer_debts');
      if (err) throw new Error(readablePlanError(err.message));
      setDebts((data ?? []) as Debt[]);
    } catch (e) {
      setError((e as Error).message);
      setDebts([]);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const pay = async (debt: Debt) => {
    const raw = (amounts[debt.debt_id] ?? '').trim();
    const montant = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(montant) || montant <= 0) {
      setError('Saisissez le montant encaissé.');
      return;
    }

    setPayingId(debt.debt_id);
    setError('');
    try {
      // Le moyen est choisi ici, pas par la fonction : c'est une décision de
      // l'encaissement, et une boutique qui reçoit en Mobile Money doit le
      // voir entrer dans le MoMo du rapport — pas dans « Espèces ».
      const { error: err } = await supabase.rpc('pay_customer_debt', {
        p_debt_id: debt.debt_id,
        p_amount: montant,
        p_method: method,
      });
      if (err) throw new Error(readablePlanError(err.message));
      setAmounts((prev) => ({ ...prev, [debt.debt_id]: '' }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPayingId(null);
    }
  };

  // Plus de cadenas : le carnet est gratuit (migration_onboarding_mode.sql).
  const total = debts.reduce((s, d) => s + Number(d.total_due), 0);

  // Exports : la liste ENTIÈRE, pas la page affichée (PAGE premières dettes).
  // Plan Starter, comme l'export des ventes.
  const peutExporter = isFeatureAllowed(plan, 'exportCsv');
  const jourFichier = new Date().toISOString().slice(0, 10);
  const dateCourte = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '');

  const exporterExcel = () => {
    const csv = toCSV(
      debts.map((d) => ({
        client: d.name ?? '',
        tel: prettyPhone(d.phone),
        du: Number(d.total_due),
        verse: Number(d.total_paid),
        ventes: d.sales_count,
        depuis: dateCourte(d.oldest_sale_at),
        dernier: dateCourte(d.last_payment_at),
      })),
      [
        { key: 'client', label: 'Client' },
        { key: 'tel', label: 'Téléphone' },
        { key: 'du', label: 'Reste dû (F)' },
        { key: 'verse', label: 'Déjà versé (F)' },
        { key: 'ventes', label: 'Ventes à crédit' },
        { key: 'depuis', label: 'Plus ancienne vente' },
        { key: 'dernier', label: 'Dernier versement' },
      ],
      ';',
    );
    downloadCSV(csv, `dettes-${jourFichier}.csv`);
  };

  const exporterPdf = () => {
    const ok = imprimerRapport({
      titre: 'Dettes clients',
      boutique: org?.name ?? '',
      periode: `au ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      colonnes: [
        { label: 'Client' }, { label: 'Téléphone', insecable: true }, { label: 'Depuis le', insecable: true },
        { label: 'Déjà versé', droite: true }, { label: 'Reste dû', droite: true },
      ],
      lignes: debts.map((d) => [
        d.name ?? 'Client sans nom', prettyPhone(d.phone), dateCourte(d.oldest_sale_at),
        formatCFA(Number(d.total_paid)), formatCFA(Number(d.total_due)),
      ]),
      total: [`${debts.length} client${debts.length > 1 ? 's' : ''}`, '', '', '', formatCFA(total)],
    });
    if (!ok) setError('Votre navigateur a bloqué la fenêtre du PDF : autorisez les fenêtres pour ce site, puis réessayez.');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-800">Carnet de dette</h2>
          <p className="text-xs text-slate-500">
            Ce que les clients vous doivent, du plus ancien au plus récent
          </p>
        </div>
        <button
          aria-label="Actualiser"
          onClick={load}
          disabled={loading}
          className="p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {debts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3 flex items-center gap-3">
            <TrendingUp className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="text-sm text-amber-900">Total à recouvrer</span>
            <span className="ml-auto text-lg font-bold text-amber-700 tabular-nums">
              {formatCFA(total)}
            </span>
          </CardContent>
        </Card>
      )}

      {debts.length > 0 && (
        peutExporter ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exporterExcel} className="gap-2 h-10 sm:h-8">
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <Button variant="outline" size="sm" onClick={exporterPdf} className="gap-2 h-10 sm:h-8">
              <FileText className="h-4 w-4" /> PDF
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">L&apos;export Excel et PDF est inclus à partir du plan Starter.</p>
        )
      )}

      {error && (
        <p className="text-red-600 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
          {error}
        </p>
      )}

      {loading && debts.length === 0 ? (
        <div className="text-center text-slate-500 py-8 text-sm">Chargement...</div>
      ) : debts.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="Aucune dette en cours"
          hint="Tout ce que vous avez vendu a été encaissé."
        />
      ) : (
        <div className="space-y-2">
          {debts.slice(0, PAGE).map((d) => {
            const age = daysSince(d.oldest_sale_at);
            const urgent = age !== null && age >= 30;
            return (
              <Card key={d.debt_id} className={urgent ? 'border-red-200' : 'border-slate-200'}>
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-800 text-sm truncate">
                        {d.name ?? 'Client sans nom'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {prettyPhone(d.phone)}
                        {age !== null && ` · depuis ${age} jour${age > 1 ? 's' : ''}`}
                      </div>
                      {d.sales_count > 1 && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {d.sales_count} ventes, {d.payments_count} versement(s)
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-amber-700 tabular-nums">
                        {formatCFA(d.total_due)}
                      </div>
                      {urgent && (
                        <div className="text-[11px] text-red-600">plus de 30 jours</div>
                      )}
                    </div>
                  </div>

                  {/* Ce qui a déjà été versé. Un solde nu ne dit pas si le
                      client a payé la moitié ou rien du tout — et la réponse
                      change tout : c'est la question que le client pose au
                      comptoir, et celle que la relance WhatsApp doit pouvoir
                      éviter. */}
                  {d.total_paid > 0 && (
                    <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-100 rounded px-2 py-1">
                      Déjà versé <span className="font-medium tabular-nums">{formatCFA(d.total_paid)}</span>
                      {' '}sur {formatCFA(d.total_paid + d.total_due)}
                    </p>
                  )}

                  {/* flex-wrap + ordre explicite.
                      Les trois contrôles tiennent sur une ligne à 1280 px :
                      « Relancer », le montant, le moyen, « Encaisser ». Sur un
                      téléphone, la rangée non-wrap gardait la largeur de ses
                      voisins à largeur fixe — « Relancer », « Espèces/MoMo » et
                      « Encaisser » — et le champ montant se retrouvait
                      écrasé à 22 px, illisible et impossible à viser juste.
                      Ici les deux boutons passent en tête de rangée (order-1,
                      Encaisser poussé à droite par ml-auto) et le montant +
                      moyen occupent la rangée du dessous, en pleine largeur. */}
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={reminderLink(d, plan)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="order-1 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#25D366] hover:bg-[#1ebe5d] text-white text-xs font-medium px-3 h-11 sm:h-9"
                    >
                      <MessageCircle className="w-3.5 h-3.5" /> Relancer
                    </a>

                    {canManageProducts && (
                      <>
                        <div className="order-3 sm:order-2 basis-full sm:basis-auto flex-1 min-w-[9rem] flex gap-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min="0"
                            placeholder={String(d.total_due)}
                            value={amounts[d.debt_id] ?? ''}
                            onChange={(e) => setAmounts((prev) => ({ ...prev, [d.debt_id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') pay(d); }}
                            className="text-sm h-11 sm:h-9"
                            aria-label={`Montant encaissé pour ${d.name ?? d.phone}`}
                          />
                          {/* Le moyen se choisit au moment de compter l'argent,
                              pas dans un réglage caché plus haut : c'est
                              précisément l'information que le caissier a sous
                              les yeux. */}
                          <div
                            role="radiogroup"
                            aria-label={`Moyen du règlement pour ${d.name ?? d.phone}`}
                            className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0 h-11 sm:h-9"
                          >
                            {(['cash', 'momo'] as const).map((m) => (
                              <button
                                key={m}
                                type="button"
                                role="radio"
                                aria-checked={method === m}
                                onClick={() => setMethod(m)}
                                className={`px-2.5 text-xs font-medium transition-colors ${
                                  method === m
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-white text-slate-500 hover:bg-slate-50'
                                }`}
                              >
                                {m === 'cash' ? 'Espèces' : 'MoMo'}
                              </button>
                            ))}
                          </div>
                        </div>
                        <Button
                          onClick={() => pay(d)}
                          disabled={payingId === d.debt_id}
                          className="order-2 sm:order-3 ml-auto sm:ml-0 h-11 sm:h-9 bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
                        >
                          {payingId === d.debt_id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <><X className="w-3.5 h-3.5 rotate-45" /> Encaisser</>}
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {debts.length > PAGE && (
            <p className="text-center text-xs text-slate-500 pt-1">
              {debts.length} débiteurs — {PAGE} premiers
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Une vente à crédit n&apos;entre pas dans le chiffre d&apos;affaires : elle y
        entre quand vous encaissez. Le stock, lui, est sorti dès la vente.
        {' '}Les versements soldent les ventes les plus anciennes d&apos;abord.
      </p>
    </div>
  );
}

/**
 * Message de relance. Le ton compte : « bonjour, vous me devez X » dit la
 * même chose que « passe me payer quand tu peux » sans humilier le client devant
 * ses voisins WhatsApp.
 *
 * Les montants déjà versés sont mentionnés quand ils existent. Relander quelqu'un
 * qui a déjà payé la moitié en ne donnant que le solde — sans dire que les 50 000
 * sont arrivés — passe pour un oubli, alors que c'est une vente à moitié
 * réglée. Le client le comprend, et répond « je les ai déjà donnés » ; le
 * commerçant doit alors vérifier. Mieux vaut l'écrire.
 *
 * Exportée pour le test : c'est aussi le seul message du produit qui part
 * sans reçu (le pied de diffusion P4 y est vérifié).
 */
export function reminderLink(d: Debt, plan: Plan): string {
  const age = daysSince(d.oldest_sale_at);
  const depuis = age !== null && age >= 7 ? ` depuis ${age} jours` : '';
  const message = [
    `Bonjour ${d.name ?? ''},`.trim(),
    ``,
    d.total_paid > 0
      ? `Vous avez déjà versé ${formatCFA(d.total_paid)}. Il vous reste ${formatCFA(d.total_due)}${depuis} à régler.`
      : `Vous me devez ${formatCFA(d.total_due)}${depuis} pour vos achats.`,
    `Passez me payer quand vous pouvez. Merci !`,
    ...piedDiffusion(plan),
  ].join('\n');
  return `https://wa.me/${whatsappNumber(d.phone)}?text=${encodeURIComponent(message)}`;
}
