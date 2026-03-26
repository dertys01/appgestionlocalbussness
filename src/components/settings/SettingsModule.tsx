'use client';

import { useState } from 'react';
import { Save, Loader2, CreditCard, Zap, CheckCircle, ExternalLink, Building2, Globe, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { PLAN_LABELS, PLAN_LIMITS } from '@/lib/utils/plans';
import type { Plan } from '@/types';

const PLANS: { id: Plan; price: string; features: string[] }[] = [
  {
    id: 'free',
    price: 'Gratuit',
    features: ['30 produits', '1 employé', 'Historique 30 jours', 'Caisse + scanner'],
  },
  {
    id: 'starter',
    price: '3 000 FCFA / mois',
    features: ['200 produits', '5 employés', 'Historique 1 an', 'Export CSV', 'Rapports avancés'],
  },
  {
    id: 'pro',
    price: '9 000 FCFA / mois',
    features: ['Produits illimités', 'Employés illimités', 'Historique illimité', 'Prévisions IA', 'Support prioritaire'],
  },
];

export function SettingsModule() {
  const { supabase, org, plan, refreshOrg, user } = useSupabase();
  const [tab, setTab] = useState<'org' | 'billing'>('org');

  // Org form
  const [orgName, setOrgName] = useState(org?.name ?? '');
  const [orgAddress, setOrgAddress] = useState(org?.address ?? '');
  const [orgIfu, setOrgIfu] = useState(org?.ifu ?? '');
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgSuccess, setOrgSuccess] = useState('');
  const [orgError, setOrgError] = useState('');

  // Billing
  const [loadingCheckout, setLoadingCheckout] = useState<Plan | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [billingError, setBillingError] = useState('');

  const saveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) return;
    setSavingOrg(true);
    setOrgSuccess('');
    setOrgError('');

    const { error } = await supabase
      .from('organizations')
      .update({
        name: orgName.trim(),
        address: orgAddress.trim() || null,
        ifu: orgIfu.trim() || null,
      } as Record<string, unknown>)
      .eq('id', org?.id);

    if (error) {
      setOrgError(error.message);
    } else {
      setOrgSuccess('Modifications enregistrées');
      await refreshOrg();
    }
    setSavingOrg(false);
  };

  const startCheckout = async (targetPlan: Plan) => {
    if (targetPlan === 'free') return;
    setBillingError('');
    setLoadingCheckout(targetPlan);

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ plan: targetPlan }),
    });

    const json = await res.json();
    setLoadingCheckout(null);

    if (!res.ok) {
      setBillingError(json.error ?? 'Erreur lors de la création du paiement');
      return;
    }

    if (json.url) window.location.href = json.url;
  };

  const openPortal = async () => {
    setBillingError('');
    setLoadingPortal(true);

    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/stripe/portal', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session?.access_token}` },
    });

    const json = await res.json();
    setLoadingPortal(false);

    if (!res.ok) {
      setBillingError(json.error ?? 'Erreur');
      return;
    }

    if (json.url) window.location.href = json.url;
  };

  const limits = PLAN_LIMITS[plan];

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2">
        {(['org', 'billing'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}>
            {t === 'org' ? <><Building2 className="h-4 w-4" /> Boutique</> : <><CreditCard className="h-4 w-4" /> Abonnement</>}
          </button>
        ))}
      </div>

      {/* ── ORG TAB ── */}
      {tab === 'org' && (
        <div className="space-y-4">
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 text-sm">Informations de la boutique</h3>

              <form onSubmit={saveOrg} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Nom de la boutique</label>
                  <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Nom affiché" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Adresse</label>
                  <Input value={orgAddress} onChange={(e) => setOrgAddress(e.target.value)} placeholder="Ex: Cotonou, Bénin" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">
                    IFU
                    <span className="ml-1 text-xs text-slate-400 font-normal">(pour factures normalisées — Plan Pro)</span>
                  </label>
                  <Input value={orgIfu} onChange={(e) => setOrgIfu(e.target.value)} placeholder="Ex: 1234567890123" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Email du compte</label>
                  <Input value={user?.email ?? ''} disabled className="bg-slate-50 text-slate-400" />
                </div>
                {orgError && <p className="text-red-500 text-sm">{orgError}</p>}
                {orgSuccess && <p className="text-emerald-600 text-sm">{orgSuccess}</p>}
                <Button type="submit" disabled={savingOrg} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                  {savingOrg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Enregistrer
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Limites actuelles */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Plan actuel</h3>
                <Badge className={`${plan === 'free' ? 'bg-slate-100 text-slate-600' : plan === 'starter' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'}`}>
                  {PLAN_LABELS[plan]}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Produits', value: limits.products === Infinity ? 'Illimité' : limits.products },
                  { label: 'Employés', value: limits.employees === Infinity ? 'Illimité' : limits.employees },
                  { label: 'Historique', value: limits.salesHistoryDays === Infinity ? 'Illimité' : `${limits.salesHistoryDays}j` },
                  { label: 'Export CSV', value: limits.exportCsv ? '✓' : '✗' },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs text-slate-500">{item.label}</p>
                    <p className="font-semibold text-slate-800 text-sm">{item.value}</p>
                  </div>
                ))}
              </div>
              {plan === 'free' && (
                <button onClick={() => setTab('billing')}
                  className="w-full text-sm text-indigo-600 hover:text-indigo-800 font-medium underline">
                  Passer à un plan supérieur →
                </button>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── BILLING TAB ── */}
      {tab === 'billing' && (
        <div className="space-y-4">
          {billingError && (
            <p className="text-red-500 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              {billingError}
            </p>
          )}

          {/* Plans */}
          <div className="space-y-3">
            {PLANS.map((p) => {
              const isCurrent = plan === p.id;
              const isUpgrade = PLANS.findIndex((x) => x.id === p.id) > PLANS.findIndex((x) => x.id === plan);

              return (
                <Card key={p.id} className={`border-2 transition-colors ${isCurrent ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200'}`}>
                  <CardContent className="p-4 flex items-start gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-800">{PLAN_LABELS[p.id]}</span>
                        {isCurrent && (
                          <Badge className="bg-indigo-100 text-indigo-700 text-xs">Plan actuel</Badge>
                        )}
                        {p.id === 'pro' && (
                          <Badge className="bg-amber-100 text-amber-700 text-xs">Populaire</Badge>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-slate-600">{p.price}</p>
                      <ul className="space-y-0.5">
                        {p.features.map((f) => (
                          <li key={f} className="text-xs text-slate-500 flex items-center gap-1.5">
                            <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
                            {f}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="shrink-0">
                      {isCurrent ? (
                        <span className="text-xs text-indigo-600 font-medium">Actif</span>
                      ) : isUpgrade ? (
                        <Button
                          size="sm"
                          onClick={() => startCheckout(p.id)}
                          disabled={loadingCheckout !== null}
                          className="bg-indigo-600 hover:bg-indigo-700 gap-1 text-xs"
                        >
                          {loadingCheckout === p.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Zap className="h-3.5 w-3.5" />}
                          Passer
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Moyens de paiement */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide px-1">Moyens de paiement</p>

            {/* Stripe */}
            <Card className="border-slate-200">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                  <Globe className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-700">Stripe</p>
                    <Badge className="bg-emerald-100 text-emerald-700 text-xs">Disponible</Badge>
                  </div>
                  <p className="text-xs text-slate-400">Carte bancaire internationale</p>
                </div>
                {plan !== 'free' && (
                  <Button variant="outline" size="sm" onClick={openPortal} disabled={loadingPortal} className="gap-2 shrink-0">
                    {loadingPortal ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                    Gérer
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* FedaPay */}
            <Card className="border-slate-200 opacity-60">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-orange-100 flex items-center justify-center shrink-0">
                  <Smartphone className="h-5 w-5 text-orange-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-700">FedaPay</p>
                    <Badge className="bg-slate-100 text-slate-500 text-xs">Bientôt disponible</Badge>
                  </div>
                  <p className="text-xs text-slate-400">Mobile Money (MTN, Moov) · Paiement local</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
