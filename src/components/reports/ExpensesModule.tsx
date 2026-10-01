'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Wallet, TrendingUp, TrendingDown, Loader2, Plus, Trash2,
  AlertTriangle, X, CalendarDays,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { PeriodPicker } from '@/components/ui/PeriodPicker';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import { rangeFromDays, todayISO, type DateRange } from '@/lib/utils/period';
import { formatCFA } from '@/lib/utils/currency';
import { readablePlanError } from '@/lib/utils/planErrors';
import { logActivity } from '@/lib/utils/activity';

/** Ligne renvoyée par get_cash_flow(date, date). */
interface CashFlowDay {
  day: string;
  revenue: number;
  expenses: number;
  net: number;
  transactions: number;
}

interface Expense {
  id: string;
  category: string;
  label: string;
  amount: number;
  day: string;
  note: string | null;
}

interface ExpenseCategory {
  id: string;
  name: string;
  sort_order: number;
}

/** Date du jour au format YYYY-MM-DD, en heure locale. */
function today(): string {
  return todayISO();
}

export function ExpensesModule() {
  const { supabase, canManageProducts, ownerId, actorName, user, plan } = useSupabase();
  const canEdit = canManageProducts;

  const [period, setPeriod] = useState<DateRange>(() => rangeFromDays(30));
  const [flow, setFlow] = useState<CashFlowDay[]>([]);
  /** Refus de plan sur la seule courbe de résultat net. N'empêche pas de saisir. */
  const [flowError, setFlowError] = useState('');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState('');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Pagination de la liste des charges : voir le rendu.
  const [shownExpenses, setShownExpenses] = useState(50);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');

    const from = period.from;
    const to = period.to;

    try {
      const [flowRes, expRes, catRes] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc('get_cash_flow', { p_from: from, p_to: to }),
        supabase
          .from('expenses')
          .select('*')
          .gte('day', from)
          .lte('day', to)
          .order('day', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase.from('expense_categories').select('id, name, sort_order').order('sort_order'),
      ]);

      // get_cash_flow est refusée en base si le plan ne permet pas les rapports.
      // Les charges, elles, ne le sont pas : enregistrer une dépense n'est pas un
      // avantage payant, c'est la tenue du commerce.
      //
      // L'échec ne doit donc pas faire tomber tout l'écran. On le note à part et
      // on continue : le commerçant garde sa liste de charges et peut continuer
      // à saisir, seule la courbe de résultat net est remplacée par une phrase
      // qui explique ce qu'il lui faut. Lever une exception ici le priverait des
      // deux — le pire des deux mondes.
      if (expRes.error) throw new Error(expRes.error.message);
      if (catRes.error) throw new Error(catRes.error.message);

      setFlowError(flowRes.error ? readablePlanError(flowRes.error.message) : '');
      setFlow(flowRes.error ? [] : ((flowRes.data as CashFlowDay[]) ?? []));
      setExpenses((expRes.data as Expense[]) ?? []);

      const cats = (catRes.data as ExpenseCategory[]) ?? [];
      setCategories(cats);
      if (cats.length > 0) setCategory((prev) => prev || cats[0].name);
    } catch (e) {
      setError((e as Error).message);
      setFlow([]);
      setExpenses([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, period, user]);

  useEffect(() => {
    load();
  }, [load]);

  // Changer de periode remet la liste au debut : sinon on arrive sur une
  // periode plus courte avec la pagination deja ouverte, et le bouton
  // « Afficher plus » propose un nombre de lignes qui n'existe plus.
  useEffect(() => {
    setShownExpenses(50);
  }, [period.from, period.to]);

  /**
   * Seed du plan de comptes, une seule fois.
   *
   * La version précédente dépendait de `loading`, que `load()` fait lui-même
   * basculer : l'effet se relançait à chaque oscillation et le module
   * clignotait en boucle (le bandeau « aucune charge » apparaissait et
   * disparaissait). On dépend donc uniquement de l'identifiant utilisateur,
   * et un ref empêche le double appel en mode strict.
   */
  const seedAttempted = useRef(false);
  useEffect(() => {
    if (!user || seedAttempted.current) return;
    seedAttempted.current = true;

    (async () => {
      const { data, error: catErr } = await supabase
        .from('expense_categories')
        .select('id')
        .limit(1);

      if (catErr) {
        setError(catErr.message);
        return;
      }
      if ((data ?? []).length > 0) return; // déjà initialisé

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: seedErr } = await (supabase as any).rpc('seed_expense_categories');
      if (seedErr) {
        setError(seedErr.message);
        return;
      }
      await load();
    })();
  }, [user, supabase, load]);

  const totalRevenue = flow.reduce((s, d) => s + Number(d.revenue), 0);
  const totalExpenses = flow.reduce((s, d) => s + Number(d.expenses), 0);
  const net = totalRevenue - totalExpenses;
  const marginPct = totalRevenue > 0 ? (net / totalRevenue) * 100 : 0;
  const bestDay = flow.reduce<CashFlowDay | null>(
    (best, d) => (d.net > (best?.net ?? -Infinity) ? d : best), null
  );

  // Regroupement des charges par catégorie
  const byCategory = expenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount);
    return acc;
  }, {});
  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const value = parseFloat(amount);
    if (!label.trim()) { setFormError('Décrivez la dépense.'); return; }
    if (!Number.isFinite(value) || value <= 0) { setFormError('Montant invalide.'); return; }
    if (!category) { setFormError('Choisissez une catégorie.'); return; }

    setSaving(true);
    try {
      const { error: err } = await supabase
        .from('expenses')
        .insert({
          user_id: ownerId,
          category,
          label: label.trim(),
          amount: value,
          day,
          note: note.trim() || null,
        });

      if (err) throw new Error(err.message);

      if (user && ownerId) {
        await logActivity({
          ownerId,
          actorId: user.id,
          actorEmail: user.email ?? '',
          actorName,
          action: 'expense',
          description: `Dépense ${formatCFA(value)} — ${category} (${label.trim()})`,
          metadata: { category, amount: value, day },
        });
      }

      setLabel('');
      setAmount('');
      setNote('');
      setDay(today());
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (expense: Expense) => {
    if (!window.confirm(`Supprimer la dépense « ${expense.label} » ?`)) return;
    setDeletingId(expense.id);
    try {
      const { error: err } = await supabase.from('expenses').delete().eq('id', expense.id);
      if (err) throw new Error(err.message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  if (error) {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
        <p className="font-medium">Module de dépenses indisponible</p>
        <p className="text-xs mt-1">{error}</p>
        <p className="text-xs mt-2">
          Appliquez <code>supabase/migration_expenses.sql</code> dans l&apos;éditeur SQL.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Sélecteur de période */}
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-500">
          Combien vous <strong>gagnez vraiment</strong> après vos charges
        </p>
        <PeriodPicker
          value={period}
          onChange={setPeriod}
          maxDays={PLAN_LIMITS[plan].salesHistoryDays}
          className="bg-slate-100 rounded-lg p-1 self-start"
        />
      </div>

      {/* Refus de plan sur la synthèse. Isolé de l'erreur générale : la liste
          des charges et le formulaire restent utilisables en dessous. */}
      {flowError && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4" />
            Synthèse indisponible
          </div>
          <p className="text-xs mt-1">{flowError}</p>
          <p className="text-xs mt-1 text-amber-700">
            Vos charges restent enregistrées et modifiables ci-dessous — seule la
            synthèse de résultat est masquée.
          </p>
        </div>
      )}

      {/* Synthèse */}
      {!flowError && (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <TrendingUp className="h-3.5 w-3.5" /> Chiffre d&apos;affaires
            </div>
            <div className="text-lg font-bold text-slate-800">{formatCFA(totalRevenue)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <TrendingDown className="h-3.5 w-3.5" /> Charges
            </div>
            <div className="text-lg font-bold text-slate-800">{formatCFA(totalExpenses)}</div>
          </CardContent>
        </Card>
        <Card className={`border-${net >= 0 ? 'emerald' : 'red'}-200 bg-${net >= 0 ? 'emerald' : 'red'}-50`}>
          <CardContent className="p-4">
            <div className={`flex items-center gap-2 text-xs mb-1 ${net >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              <Wallet className="h-3.5 w-3.5" /> Résultat net
            </div>
            <div className={`text-lg font-bold ${net >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {formatCFA(net)}
            </div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-slate-500 text-xs mb-1">Marge nette</div>
            <div className={`text-lg font-bold ${marginPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {marginPct.toFixed(1)} %
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              {marginPct >= 0 ? 'bénéfice' : 'perte'}
            </div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Avertissement : aucune charge saisie */}
      {expenses.length === 0 && !loading && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Aucune charge enregistrée sur la période
          </div>
          <p className="text-xs mt-1">
            Sans loyer, salaires ni électricité, le résultat net affiché vaut le chiffre
            d&apos;affaires — il ne vous dit pas si la boutique est rentable.
          </p>
        </div>
      )}

      {/* Bouton d'ajout */}
      {canEdit && (
        <div className="flex justify-end">
          {!showForm ? (
            <Button
              onClick={() => setShowForm(true)}
              className="bg-indigo-600 hover:bg-indigo-700 gap-2"
            >
              <Plus className="h-4 w-4" /> Enregistrer une dépense
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setShowForm(false)} className="gap-2">
              <X className="h-4 w-4" /> Annuler
            </Button>
          )}
        </div>
      )}

      {/* Formulaire */}
      {showForm && canEdit && (
        <Card className="border-indigo-200 bg-indigo-50">
          <CardContent className="p-4">
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Catégorie</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Montant (FCFA)</label>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Ex : 50000"
                    min="0"
                    step="1"
                    className="bg-white"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Description</label>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Ex : Loyer juin"
                    className="bg-white"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Date</label>
                  <Input
                    type="date"
                    value={day}
                    onChange={(e) => setDay(e.target.value)}
                    max={today()}
                    className="bg-white"
                    required
                  />
                </div>
              </div>
              {formError && <p className="text-xs text-red-600">{formError}</p>}
              <Button
                type="submit"
                disabled={saving}
                className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2"
              >
                {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Enregistrement...</> : 'Enregistrer la dépense'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Répartition par catégorie */}
      {topCategories.length > 0 && (
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <h3 className="font-semibold text-slate-700 mb-3">Répartition des charges</h3>
            <div className="space-y-2">
              {topCategories.map(([name, value]) => (
                <div key={name} className="flex items-center gap-3">
                  <span className="text-sm text-slate-600 w-32 truncate shrink-0">{name}</span>
                  <div className="flex-1 h-2 bg-slate-100 rounded-full">
                    <div
                      className="h-2 bg-red-400 rounded-full"
                      style={{ width: `${totalExpenses > 0 ? (value / totalExpenses) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium text-slate-700 tabular-nums w-24 text-right">
                    {formatCFA(value)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Journal des dépenses */}
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <h3 className="font-semibold text-slate-700 mb-3">
            Dépenses ({expenses.length})
            {bestDay && bestDay.net > 0 && (
              <span className="ml-2 text-xs font-normal text-slate-400">
                meilleure journée : {new Date(bestDay.day).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ({formatCFA(bestDay.net)})
              </span>
            )}
          </h3>

          {loading ? (
            <div className="text-center text-slate-400 py-8 text-sm">Chargement...</div>
          ) : expenses.length === 0 ? (
            <div className="text-center text-slate-400 py-8 text-sm">
              Aucune dépense sur la période
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {expenses.slice(0, shownExpenses).map((exp) => (
                <div key={exp.id} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{exp.label}</div>
                    <div className="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
                      <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        {exp.category}
                      </span>
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" />
                        {new Date(exp.day).toLocaleDateString('fr-FR', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-bold text-red-600 tabular-nums shrink-0">
                    − {formatCFA(exp.amount)}
                  </span>
                  {canEdit && (
                    <button
                      onClick={() => handleDelete(exp)}
                      disabled={deletingId === exp.id}
                      className="p-1.5 text-slate-300 hover:text-red-500 disabled:opacity-40 shrink-0"
                      title="Supprimer"
                    >
                      {deletingId === exp.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              ))}

              {/* Sur un an, une boutique saisit des centaines de charges : tout
                  afficher d'un bloc rend le montant du haut introuvable. On
                  pagine par paliers, le total restant inchangé. */}
              {shownExpenses < expenses.length && (
                <button
                  onClick={() => setShownExpenses((n) => n + 50)}
                  className="w-full py-2.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  Afficher plus ({expenses.length - shownExpenses} restante(s))
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-slate-400">
        Le résultat net croise le chiffre d&apos;affaires des ventes et vos charges sur la
        période choisie. Il ne comprend ni les salaires implicites ni l&apos;amortissement du stock.
      </p>
    </div>
  );
}
