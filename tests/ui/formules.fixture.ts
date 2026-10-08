/**
 * Configuration des formules utilisée par TOUS les tests (vitest).
 *
 * Posée dans `tests/ui/setup.ts` avant tout import de `src/lib/utils/plans.ts`.
 * Valeurs volontairement quelconques — ni celles de l'offre réelle, ni
 * réutilisables pour la deviner : un test lit `PLAN_LIMITS`, il ne répète pas
 * un plafond dans une assertion.
 */
export const FORMULES_TEST = {
  quotas: {
    free:    { products: 50,   employees: 0, historyDays: 30 },
    starter: { products: null, employees: 3, historyDays: null },
    pro:     { products: null, employees: null, historyDays: null },
  },
  prices: {
    starter: { monthly: 1000, yearly: 10000 },
    pro:     { monthly: 2000, yearly: 20000 },
  },
} as const;
