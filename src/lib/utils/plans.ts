import type { Plan, PlanLimits } from '@/types';

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    products: 30,
    employees: 1,
    salesHistoryDays: 30,
    exportCsv: false,
    reports: false,
    forecast: false,
  },
  starter: {
    products: 200,
    employees: 5,
    salesHistoryDays: 365,
    exportCsv: true,
    reports: true,
    forecast: false,
  },
  pro: {
    products: Infinity,
    employees: Infinity,
    salesHistoryDays: Infinity,
    exportCsv: true,
    reports: true,
    forecast: true,
  },
};

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Gratuit',
  starter: 'Starter',
  pro: 'Pro',
};

export const PLAN_PRICES: Record<Plan, { usd: number; label: string }> = {
  free: { usd: 0, label: 'Gratuit' },
  starter: { usd: 5, label: '5 USD / mois' },
  pro: { usd: 15, label: '15 USD / mois' },
};

export function getLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan];
}

export function canAddProduct(plan: Plan, currentCount: number): boolean {
  return currentCount < PLAN_LIMITS[plan].products;
}

export function canAddEmployee(plan: Plan, currentCount: number): boolean {
  return currentCount < PLAN_LIMITS[plan].employees;
}

export function isFeatureAllowed(plan: Plan, feature: keyof Pick<PlanLimits, 'exportCsv' | 'reports' | 'forecast'>): boolean {
  return PLAN_LIMITS[plan][feature];
}

export function getUpgradeMessage(plan: Plan, feature: string): string {
  const next: Record<Plan, Plan | null> = { free: 'starter', starter: 'pro', pro: null };
  const nextPlan = next[plan];
  if (!nextPlan) return '';
  return `${feature} nécessite le plan ${PLAN_LABELS[nextPlan]}. Passez au plan supérieur pour y accéder.`;
}
