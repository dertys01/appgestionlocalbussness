'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, MessageCircle, Loader2, Handshake, TrendingUp, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { readablePlanError } from '@/lib/utils/planErrors';
import { isFeatureAllowed, PLAN_LABELS } from '@/lib/utils/plans';
import type { Plan } from '@/types';

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
  const { supabase, plan, canManageProducts } = useSupabase();
  const [debts, setDebts] = useState<Debt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Fonction SECURITY INVOKER : l'isolation vient de la RLS de sales et
      // customer_debts, pas d'un filtre manuel dans la requête. Le plan, lui, est
      // vérifié en base : le cadenas de l'onglet ne protège rien.
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
      const { error: err } = await supabase.rpc('pay_customer_debt', {
        p_debt_id: debt.debt_id,
        p_amount: montant,
        p_method: 'cash',
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

  const total = debts.reduce((s, d) => s + Number(d.total_due), 0);
  const bloque = !isFeatureAllowed(plan as Plan, 'reports');

  if (bloque) {
    return (
      <Card className="border-amber-200">
        <CardContent className="p-6 text-center space-y-2">
          <Handshake className="w-8 h-8 text-amber-400 mx-auto" />
          <p className="text-sm text-slate-600">
            Le carnet de dette est disponible à partir du plan {PLAN_LABELS.starter}.
          </p>
          <p className="text-xs text-slate-400">
            Il fait partie des rapports, comme la rentabilité et le résultat net.
          </p>
        </CardContent>
      </Card>
    );
  }

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
          onClick={load}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {debts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3 flex items-center gap-3">
            <TrendingUp className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-sm text-amber-900">Total à recouvrer</span>
            <span className="ml-auto text-lg font-bold text-amber-700 tabular-nums">
              {formatCFA(total)}
            </span>
          </CardContent>
        </Card>
      )}

      {error && (
        <p className="text-red-500 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
          {error}
        </p>
      )}

      {loading && debts.length === 0 ? (
        <div className="text-center text-slate-400 py-8 text-sm">Chargement...</div>
      ) : debts.length === 0 ? (
        <div className="text-center text-slate-400 py-10 text-sm">
          Aucune dette en cours. Tout ce que vous avez vendu a été encaissé.
        </div>
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
                      <div className="text-xs text-slate-400">
                        {prettyPhone(d.phone)}
                        {age !== null && ` · depuis ${age} jour${age > 1 ? 's' : ''}`}
                      </div>
                      {d.sales_count > 1 && (
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {d.sales_count} ventes, {d.payments_count} versement(s)
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-bold text-amber-700 tabular-nums">
                        {formatCFA(d.total_due)}
                      </div>
                      {urgent && (
                        <div className="text-[10px] text-red-600">plus de 30 jours</div>
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

                  <div className="flex gap-2">
                    <a
                      href={reminderLink(d)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#25D366] hover:bg-[#1ebe5d] text-white text-xs font-medium px-3 h-9"
                    >
                      <MessageCircle className="w-3.5 h-3.5" /> Relancer
                    </a>

                    {canManageProducts && (
                      <div className="flex-1 flex gap-2">
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min="0"
                          placeholder={String(d.total_due)}
                          value={amounts[d.debt_id] ?? ''}
                          onChange={(e) => setAmounts((prev) => ({ ...prev, [d.debt_id]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') pay(d); }}
                          className="text-sm h-9"
                          aria-label={`Montant encaissé pour ${d.name ?? d.phone}`}
                        />
                        <Button
                          onClick={() => pay(d)}
                          disabled={payingId === d.debt_id}
                          className="h-9 bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
                        >
                          {payingId === d.debt_id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <><X className="w-3.5 h-3.5 rotate-45" /> Encaisser</>}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {debts.length > PAGE && (
            <p className="text-center text-xs text-slate-400 pt-1">
              {debts.length} débiteurs — {PAGE} premiers
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-slate-400">
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
 */
function reminderLink(d: Debt): string {
  const age = daysSince(d.oldest_sale_at);
  const depuis = age !== null && age >= 7 ? ` depuis ${age} jours` : '';
  const message = [
    `Bonjour ${d.name ?? ''},`.trim(),
    ``,
    d.total_paid > 0
      ? `Vous avez déjà versé ${formatCFA(d.total_paid)}. Il vous reste ${formatCFA(d.total_due)}${depuis} à régler.`
      : `Vous me devez ${formatCFA(d.total_due)}${depuis} pour vos achats.`,
    `Passez me payer quand vous pouvez. Merci !`,
  ].join('\n');
  return `https://wa.me/${d.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(message)}`;
}
