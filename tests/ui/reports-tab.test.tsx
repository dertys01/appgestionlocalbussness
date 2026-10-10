import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * L'onglet Rapports : trois vues, un seul sélecteur.
 *
 * Les modules lourds (graphiques recharts, rentabilité, charges) sont mockés :
 * on vérifie seulement l'aiguillage et l'état accessible des onglets.
 */
vi.mock('@/components/reports/ReportsModule', () => ({ ReportsModule: () => <div>VUE-VENTES</div> }));
vi.mock('@/components/reports/ProfitabilityModule', () => ({ ProfitabilityModule: () => <div>VUE-RENTABILITE</div> }));
vi.mock('@/components/reports/ExpensesModule', () => ({ ExpensesModule: () => <div>VUE-CHARGES</div> }));

import { ReportsTab } from '@/components/reports/ReportsTab';

describe('ReportsTab', () => {
  it('affiche la vue demandée', () => {
    render(<ReportsTab view="profit" onView={() => {}} />);
    expect(screen.getByText('VUE-RENTABILITE')).toBeInTheDocument();
    expect(screen.queryByText('VUE-CHARGES')).toBeNull();
  });

  it('marque l’onglet actif pour l’accessibilité', () => {
    render(<ReportsTab view="expenses" onView={() => {}} />);
    expect(screen.getByRole('button', { name: 'Charges' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ventes' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('VUE-CHARGES')).toBeInTheDocument();
  });

  it('change de vue au clic', () => {
    const onView = vi.fn();
    render(<ReportsTab view="profit" onView={onView} />);

    fireEvent.click(screen.getByRole('button', { name: 'Charges' }));
    expect(onView).toHaveBeenCalledWith('expenses');
    fireEvent.click(screen.getByRole('button', { name: 'Ventes' }));
    expect(onView).toHaveBeenCalledWith('sales');
  });
});
