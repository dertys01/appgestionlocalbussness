'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { PLAN_LABELS } from '@/lib/utils/plans';

/**
 * Page de paiement Mobile Money — bac à sable.
 *
 * Étape intermédiaire du parcours : la route /api/payments/order renvoie
 * cette URL tant qu'aucun prestataire réel n'est branché. La page montre la
 * commande (telle que la base la connaît — montant compris, jamais recopié
 * depuis l'URL), puis confirme via /api/payments/callback/sandbox, la seule
 * porte d'activation du plan.
 *
 * La confirmation n'existe QUE si PAYMENTS_SANDBOX=1 : en production, cette
 * page répond « indisponible » et rien ne s'active. C'est voulu — le bac à
 * sable n'est pas une porte de service.
 */

interface Commande {
  reference: string;
  plan: 'starter' | 'pro';
  period_months: number;
  amount: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
}

const ETATS: Record<Commande['status'], string> = {
  pending: 'En attente de confirmation',
  paid: 'Payée',
  failed: 'Échouée',
  expired: 'Expirée',
};

export default function PaiementSandboxPage({ params }: { params: Promise<{ ref: string }> }) {
  const { supabase } = useSupabase();
  const [reference, setReference] = useState('');
  const [commande, setCommande] = useState<Commande | null>(null);
  const [erreur, setErreur] = useState('');
  const [pret, setPret] = useState(false);
  const [enCours, setEnCours] = useState(false);

  // Les routes paiement lisent le jeton dans l'en-tête Authorization
  // (bearerOf, jamais les cookies) : sans lui, « Non authentifié » alors que
  // la session existe — c'est ce qui cassait l'affichage PUIS la confirmation.
  // useCallback : l'effet de chargement en dépend, un arrow inline le
  // relancerait à chaque rendu.
  const entetesSession = useCallback(async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : {};
  }, [supabase]);

  useEffect(() => {
    let active = true;
    params.then(async (p) => {
      setReference(p.ref);
      const res = await fetch(
        `/api/payments/order?ref=${encodeURIComponent(p.ref)}`,
        { headers: await entetesSession() },
      ).catch(() => null);
      if (!active) return;
      if (!res) {
        setErreur('Réseau indisponible.');
        return;
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setErreur(json?.error ?? `Erreur serveur (${res.status})`);
        return;
      }
      setCommande((await res.json()) as Commande);
      setPret(true);
    });
    return () => { active = false; };
  }, [params, entetesSession]);

  const confirmer = async () => {
    setEnCours(true);
    setErreur('');
    try {
      const res = await fetch('/api/payments/callback/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await entetesSession()) },
        body: JSON.stringify({ reference }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErreur(json?.error ?? `Erreur serveur (${res.status})`);
        setEnCours(false);
        return;
      }
      // Retour plein : l'application relit l'organisation au montage, le
      // plan et son échéance se mettent à jour sans action supplémentaire.
      window.location.href = '/';
    } catch {
      setErreur('Réseau indisponible.');
      setEnCours(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardContent className="p-6 space-y-5">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-emerald-600" aria-hidden />
            <h1 className="text-lg font-semibold">Paiement Mobile Money</h1>
          </div>

          {!pret && !erreur && (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Chargement de la commande…
            </p>
          )}

          {erreur && (
            <p className="text-sm text-red-600" role="alert">{erreur}</p>
          )}

          {commande && (
            <dl className="text-sm divide-y divide-slate-100 rounded-md border border-slate-200">
              <div className="flex justify-between px-3 py-2">
                <dt className="text-slate-500">Formule</dt>
                <dd className="font-medium">{PLAN_LABELS[commande.plan]}</dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-slate-500">Période</dt>
                <dd className="font-medium">{commande.period_months} mois</dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-slate-500">Montant</dt>
                <dd className="font-medium">{formatCFA(commande.amount)}</dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-slate-500">État</dt>
                <dd className="font-medium">{ETATS[commande.status]}</dd>
              </div>
            </dl>
          )}

          {commande?.status === 'pending' && (
            <div className="space-y-3">
              <Button className="w-full" onClick={confirmer} disabled={enCours || !reference}>
                {enCours ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Confirmation…
                  </span>
                ) : (
                  'Confirmer le paiement (simulation)'
                )}
              </Button>
              <p className="text-xs text-slate-500">
                Aucun argent ne bouge : ce parcours est le bac à sable, sans
                appel à un opérateur. Le vrai prestataire sera branché après
                l’essai prévu au Sprint 19.
              </p>
            </div>
          )}

          {commande?.status === 'paid' && (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Cette période est déjà active, retournez à l’application.
            </p>
          )}

          {(commande?.status === 'failed' || commande?.status === 'expired') && (
            <p className="text-sm text-slate-600">
              Cette commande n’est plus valable. Repartez de Paramètres →
              Abonnement pour en créer une nouvelle.
            </p>
          )}

          <Link
            href="/"
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Retour à l’application
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
