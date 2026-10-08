import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMULES_TEST } from './formules.fixture';

/**
 * Mobile Money — le squelette (Sprint 19).
 *
 * Ce qui est vérifié ici, à la main, parce qu'aucune clé ni aucun appel
 * réseau n'existe encore :
 *   1. montantPeriode() : l'unique transformation prix config → montant de
 *      commande (annuel prioritaire, refus net si prix absent) ;
 *   2. planEffectif() : l'échéance prépayée éteint le plan, jamais l'essai ;
 *   3. la sélection des prestataires : nom inconnu = erreur, squelettes =
 *      refus, bac à sable = parcours complet DERRIÈRE PAYMENTS_SANDBOX.
 *
 * Un test qui passerait avec un vrai appel réseau échouerait ici : les
 * squelettes n'ont rien à appeler, et c'est le contrat.
 */

const VAR = 'NEXT_PUBLIC_PLANS_CONFIG';
const REF = '0123456789abcdef0123456789abcdef0123'; // 36 hex, comme randomBytes(18)

beforeEach(() => {
  process.env[VAR] = JSON.stringify(FORMULES_TEST);
  process.env.PAYMENTS_PROVIDER = 'sandbox';
  process.env.PAYMENTS_SANDBOX = '1';
});

afterEach(() => {
  process.env[VAR] = JSON.stringify(FORMULES_TEST);
  delete process.env.PAYMENTS_PROVIDER;
  delete process.env.PAYMENTS_SANDBOX;
});

async function modules(env?: string) {
  vi.resetModules();
  if (env === undefined) delete process.env[VAR];
  else process.env[VAR] = env;
  return {
    plans: await import('@/lib/utils/plans'),
    pay: await import('@/lib/payments'),
  };
}

describe('montantPeriode — prix config → montant de commande', () => {
  it('multiplie le mensuel, et prend l’annuel pour 12 mois', async () => {
    const { plans } = await modules(JSON.stringify(FORMULES_TEST));
    expect(plans.montantPeriode('starter', 1)).toBe(FORMULES_TEST.prices.starter.monthly);
    expect(plans.montantPeriode('starter', 3)).toBe(FORMULES_TEST.prices.starter.monthly * 3);
    // 12 mois : le prix ANNUEL, pas douze mensualités (leur écart est
    // l'argument commercial de l'annualité — pas un bug d'arrondi).
    expect(plans.montantPeriode('starter', 12)).toBe(FORMULES_TEST.prices.starter.yearly);
    expect(plans.montantPeriode('pro', 3)).toBe(FORMULES_TEST.prices.pro.monthly * 3);
    expect(plans.montantPeriode('pro', 12)).toBe(FORMULES_TEST.prices.pro.yearly);
  });

  it('sans configuration : null partout, jamais un montant inventé', async () => {
    const { plans } = await modules();
    expect(plans.montantPeriode('starter', 1)).toBeNull();
    expect(plans.montantPeriode('starter', 12)).toBeNull();
    expect(plans.montantPeriode('pro', 3)).toBeNull();
    // Une année configurée sans mensuel : 12 mois passe, 3 mois refuse.
    const { plans: partiel } = await modules(
      JSON.stringify({ prices: { starter: { yearly: 5000 } } }),
    );
    expect(partiel.montantPeriode('starter', 12)).toBe(5000);
    expect(partiel.montantPeriode('starter', 3)).toBeNull();
  });
});

describe('planEffectif — l’échéance prépayée', () => {
  const passe = '2020-01-01T00:00:00Z';
  const future = `${new Date(Date.now() + 86400000).toISOString()}`;

  it('période écoulée → free, quelle que soit la formule payée', async () => {
    const { plans } = await modules(JSON.stringify(FORMULES_TEST));
    expect(plans.planEffectif('starter', null, passe)).toBe('free');
    expect(plans.planEffectif('pro', null, passe)).toBe('free');
    expect(plans.planEffectif('starter', null, future)).toBe('starter');
    expect(plans.planEffectif('pro', null, future)).toBe('pro');
    expect(plans.planEffectif('starter')).toBe('starter');
  });

  it('essai actif sur plan brut gratuit : une échéance résiduelle n’éteint rien', async () => {
    const { plans } = await modules(JSON.stringify(FORMULES_TEST));
    // Le résidu d'une période d'avant ne peut exister que dans ce cas-là :
    // start_free_trial n'accepte que le plan brut gratuit.
    expect(plans.planEffectif('free', future, passe)).toBe('starter');
    expect(plans.planEffectif('free', future)).toBe('starter');
    expect(plans.planEffectif('free', passe, passe)).toBe('free');
    expect(plans.planEffectif('free', null, passe)).toBe('free');
  });
});

describe('prestataires', () => {
  it('sélectionne par configuration, refuse un nom inconnu', async () => {
    const { pay } = await modules(JSON.stringify(FORMULES_TEST));
    expect(pay.getPrestataire().id).toBe('sandbox');
    expect(pay.getPrestataire('fedapay').id).toBe('fedapay');
    expect(pay.getPrestataire('paydunya').id).toBe('paydunya');
    expect(() => pay.getPrestataire('paypal')).toThrow(/inconnue/i);
    // Sans configuration : sandbox (mais fermé sans PAYMENTS_SANDBOX, plus bas).
    delete process.env.PAYMENTS_PROVIDER;
    expect(pay.getPrestataire().id).toBe('sandbox');
  });

  it('les squelettes rejettent sans rien appeler', async () => {
    const { pay } = await modules(JSON.stringify(FORMULES_TEST));
    const demande = { reference: REF, plan: 'starter' as const, mois: 1 as const, montant: 7777 };
    for (const nom of ['fedapay', 'paydunya'] as const) {
      const p = pay.getPrestataire(nom);
      await expect(p.creerPaiement(demande)).rejects.toThrow(/non branché/i);
      // Un webhook « tout signé » arrive dans un trou noir : fail closed.
      expect(p.verifierCallback(JSON.stringify({ reference: REF }), new Headers())).toBeNull();
    }
  });

  it('bac à sable : page locale ouverte, confirmation refermée sans PAYMENTS_SANDBOX', async () => {
    const { pay } = await modules(JSON.stringify(FORMULES_TEST));
    const p = pay.getPrestataire('sandbox');
    const demande = { reference: REF, plan: 'pro' as const, mois: 3 as const, montant: 7777 };

    const cree = await p.creerPaiement(demande);
    // Chemin relatif : la redirection appartient au navigateur, pas à un
    // hôte codé en dur.
    expect(cree.redirectUrl).toBe(`/paiement/sandbox/${REF}`);
    expect(cree.providerRef).toMatch(/^sbx_/);
    expect(p.verifierCallback(JSON.stringify({ reference: REF }), new Headers()))
      .toEqual({ reference: REF, ok: true });

    // Point de bascule : sans l'interrupteur explicitement ouvert, le bac à
    // sable ne crée ni n'accepte quoi que ce soit (défaut fermé en prod).
    delete process.env.PAYMENTS_SANDBOX;
    await expect(p.creerPaiement(demande)).rejects.toThrow(/désactivé/i);
    expect(p.verifierCallback(JSON.stringify({ reference: REF }), new Headers())).toBeNull();
  });

  it('corps malformé ou référence mal formée : refus', async () => {
    const { pay } = await modules(JSON.stringify(FORMULES_TEST));
    const p = pay.getPrestataire('sandbox');
    expect(p.verifierCallback('pas du json', new Headers())).toBeNull();
    expect(p.verifierCallback('{"reference":"abc"}', new Headers())).toBeNull();
    expect(p.verifierCallback('{"reference":42}', new Headers())).toBeNull();
    expect(p.verifierCallback('{}', new Headers())).toBeNull();
  });
});
