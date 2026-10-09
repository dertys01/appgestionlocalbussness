import Link from 'next/link';
import type { Metadata } from 'next';
import { Check, Zap, ArrowRight, Store } from 'lucide-react';

import {
  PLAN_LABELS,
  isFeatureAllowed,
  lignesQuotas,
  prixMensuelLabel,
  prixAAnnuelLabel,
} from '@/lib/utils/plans';
import type { Plan } from '@/types';

/**
 * Page publique des formules — servie sans session, avant l'inscription.
 *
 * TOUT ce qui est chiffre vient de la configuration du build
 * (NEXT_PUBLIC_PLANS_CONFIG) : un prix, un plafond ou un nombre d'employés
 * écrit ici reviendrait à publier la stratégie tarifaire dans le dépôt
 * public. La copie, elle, est écrite : ce ne sont pas des valeurs.
 *
 * Le plan gratuit n'a pas de bouton d'essai : l'essai est un ACTE
 * (Paramètres → Abonnement, une fois par boutique), jamais une conséquence
 * de l'inscription. Ici on ne promet qu'une chose : le lien vers le moment
 * où l'essai pourra être démarré.
 */
export const metadata: Metadata = {
  title: 'Tarifs - GestionLocal',
  description:
    'Commencez gratuitement, évoluez quand votre boutique grandit : trois formules sans engagement, essai de 14 jours sans carte bancaire.',
};

/** Ce que TOUS les plans ont — la caisse n'est jamais verrouillée. */
const FONCTIONS_BASE = [
  'Caisse et scanner de codes-barres',
  'Journal du jour',
  'Catalogue produits et stocks',
  'Suivi des dettes clients',
];

/** Les fonctions qui dépendent du plan : même seuils que require_feature(). */
function lignesFonctions(plan: Plan): string[] {
  const l = [...FONCTIONS_BASE];
  if (isFeatureAllowed(plan, 'exportCsv')) l.push('Export CSV des données');
  if (isFeatureAllowed(plan, 'reports')) l.push('Rapports : rentabilité, charges, dettes');
  if (isFeatureAllowed(plan, 'forecast')) l.push('Prévisions de réapprovisionnement');
  return l;
}

const ANNONCES: Record<Plan, string> = {
  free: 'Pour démarrer, sans rien payer.',
  starter: 'Pour la boutique qui tourne tous les jours.',
  pro: 'Pour piloter jusqu’aux prévisions.',
};

export default function TarifsPage() {
  const plans: Plan[] = ['free', 'starter', 'pro'];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* ── En-tête ── */}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-indigo-600" />
          <span className="font-semibold">GestionLocal</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-slate-500 hover:text-slate-800">
            Se connecter
          </Link>
          <Link
            href="/register"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
          >
            Créer ma boutique
          </Link>
        </div>
      </header>

      {/* ── Introduction ── */}
      <section className="mx-auto max-w-3xl px-4 pb-8 pt-6 text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Un plan pour chaque étape de votre commerce
        </h1>
        <p className="mt-3 text-slate-600">
          Commencez gratuitement. Passez au niveau supérieur quand c&apos;est le moment :
          vos données, elles, ne bougent jamais d&apos;un plan à l&apos;autre.
        </p>
      </section>

      {/* ── Les trois formules ── */}
      <section className="mx-auto grid max-w-5xl gap-4 px-4 pb-10 sm:grid-cols-3">
        {plans.map((id) => {
          const annuel = prixAAnnuelLabel(id);
          const lignes = [...lignesQuotas(id), ...lignesFonctions(id)];
          return (
            <div
              key={id}
              className={`flex flex-col rounded-xl border bg-white p-5 ${
                id === 'starter' ? 'border-indigo-300 shadow-sm' : 'border-slate-200'
              }`}
            >
              <h2 className="text-lg font-semibold">{PLAN_LABELS[id]}</h2>
              <p className="mt-1 text-sm text-slate-500">{ANNONCES[id]}</p>

              <p className="mt-4 text-2xl font-bold">
                {id === 'free' ? 'Gratuit, pour toujours' : prixMensuelLabel(id)}
              </p>
              {annuel && <p className="text-xs text-slate-500">ou {annuel}</p>}

              <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-700">
                {lignes.map((ligne) => (
                  <li key={ligne} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                    <span>{ligne}</span>
                  </li>
                ))}
              </ul>

              <Link
                href="/register"
                className={`mt-5 rounded-lg px-3 py-2 text-center text-sm font-medium ${
                  id === 'starter'
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                Créer ma boutique
              </Link>
            </div>
          );
        })}
      </section>

      {/* ── L'essai, explicite ── */}
      <section className="mx-auto max-w-5xl px-4 pb-10">
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-indigo-900">
              <Zap className="h-5 w-5 text-indigo-600" />
              Démarrer l&apos;essai : 14 jours, sans carte
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-indigo-800">
              Essayez Starter avec toutes ses fonctions pendant 14 jours : aucune carte
              bancaire, aucun prélèvement, aucun abonnement caché. L&apos;essai se démarre
              d&apos;un clic dans Paramètres → Abonnement, après votre inscription : jamais
              automatiquement, et une seule fois par boutique. À la fin, tout revient au
              plan Gratuit : rien ne se perd.
            </p>
          </div>
          <Link
            href="/register"
            className="mt-4 inline-flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 sm:mt-0"
          >
            Créer ma boutique
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Pied de page ── */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            GestionLocal : caisse et gestion pour commerces, restaurants et services,
            pensé pour le Bénin.
          </p>
          <p>
            Paiement Mobile Money (MTN, Moov) en cours de mise en place ·{' '}
            <Link href="/connexion" className="underline hover:text-slate-800">
              Se connecter
            </Link>
          </p>
        </div>
      </footer>
    </main>
  );
}
