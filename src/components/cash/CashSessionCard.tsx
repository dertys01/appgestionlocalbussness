'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wallet, Loader2, ArrowDownCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';

interface Session {
  id: string;
  opened_at: string;
  opening_float: number;
  closed_at: string | null;
  counted_cash: number | null;
  expected_cash: number | null;
  difference: number | null;
  note: string | null;
}

const heure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Session de caisse : ouvrir avec un fond, clôturer avec un comptage.
 *
 * L'attendu (fond + espèces encaissées depuis l'ouverture) et l'écart sont
 * calculés EN BASE (close_cash_session), jamais ici : le navigateur ne fait que
 * les afficher. Voir supabase/migration_cash_sessions.sql.
 */
export function CashSessionCard() {
  const { supabase } = useSupabase();
  const [ouverte, setOuverte] = useState<Session | null>(null);
  const [historique, setHistorique] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [fond, setFond] = useState('');
  const [compte, setCompte] = useState('');
  const [note, setNote] = useState('');
  const [cloture, setCloture] = useState<Session | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [ouv, hist] = await Promise.all([
      supabase.from('cash_sessions').select('*').is('closed_at', null).maybeSingle(),
      supabase.from('cash_sessions').select('*').not('closed_at', 'is', null)
        .order('closed_at', { ascending: false }).limit(5),
    ]);
    if (ouv.error) setErreur(ouv.error.message);
    setOuverte((ouv.data as Session) ?? null);
    setHistorique((hist.data as Session[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const ouvrir = async () => {
    setEnCours(true);
    setErreur('');
    try {
      const { error } = await supabase.rpc('open_cash_session', {
        p_opening_float: lireMontant(fond) ?? 0,
      });
      if (error) throw new Error(error.message);
      setFond('');
      setCloture(null);
      await load();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Ouverture impossible.');
    } finally {
      setEnCours(false);
    }
  };

  const fermer = async () => {
    const montant = lireMontant(compte);
    if (montant === null) { setErreur('Saisissez le montant compté en caisse.'); return; }
    setEnCours(true);
    setErreur('');
    try {
      const { data, error } = await supabase.rpc('close_cash_session', {
        p_counted_cash: montant,
        p_note: note.trim() || null,
      });
      if (error) throw new Error(error.message);
      setCloture((data as Session) ?? null);
      setCompte('');
      setNote('');
      await load();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Clôture impossible.');
    } finally {
      setEnCours(false);
    }
  };

  const ecart = (s: Session) => Number(s.difference ?? 0);

  return (
    <Card className="border-slate-200">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-indigo-600 shrink-0" />
          <h3 className="font-semibold text-slate-800 text-sm">Caisse</h3>
          {ouverte && (
            <span className="ml-auto text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
              Ouverte depuis {heure(ouverte.opened_at)}
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement…
          </p>
        ) : cloture ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1 text-sm">
            <p className="font-medium text-slate-800">Caisse clôturée.</p>
            <div className="flex justify-between text-slate-600">
              <span>Attendu</span><span className="tabular-nums">{formatCFA(Number(cloture.expected_cash ?? 0))}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Compté</span><span className="tabular-nums">{formatCFA(Number(cloture.counted_cash ?? 0))}</span>
            </div>
            <div className={`flex justify-between font-semibold ${ecart(cloture) === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
              <span>Écart</span>
              <span className="tabular-nums">{ecart(cloture) > 0 ? '+' : ''}{formatCFA(ecart(cloture))}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCloture(null)} className="text-slate-500">
              Fermer ce résumé
            </Button>
          </div>
        ) : ouverte ? (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Fond de caisse : <strong className="text-slate-700">{formatCFA(Number(ouverte.opening_float))}</strong>.
              Comptez le tiroir, puis clôturez.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={compte}
                onChange={(e) => setCompte(e.target.value)}
                inputMode="decimal"
                placeholder="Montant compté (F)"
                aria-label="Montant compté en caisse"
              />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (facultatif)"
                aria-label="Note de clôture"
              />
            </div>
            <Button onClick={fermer} disabled={enCours} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
              {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownCircle className="h-4 w-4" />}
              Clôturer la caisse
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Ouvrez la caisse avec le fond de départ. L&apos;attendu de la clôture = fond + espèces encaissées.
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={fond}
                onChange={(e) => setFond(e.target.value)}
                inputMode="decimal"
                placeholder="Fond de caisse (F)"
                aria-label="Fond de caisse"
              />
              <Button onClick={ouvrir} disabled={enCours} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                Ouvrir la caisse
              </Button>
            </div>
          </div>
        )}

        {erreur && <p className="text-xs text-red-600">{erreur}</p>}

        {historique.length > 0 && !ouverte && !cloture && (
          <div className="pt-1 border-t border-slate-100">
            <p className="text-[11px] text-slate-500 mb-1">Dernières clôtures</p>
            <ul className="space-y-1">
              {historique.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-xs text-slate-600">
                  <span>{s.closed_at ? heure(s.closed_at) : ''}</span>
                  <span className={`tabular-nums ${ecart(s) === 0 ? 'text-slate-500' : 'text-amber-700'}`}>
                    {ecart(s) > 0 ? '+' : ''}{formatCFA(ecart(s))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
