import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PeriodPicker } from '@/components/ui/PeriodPicker';
import { daysBetween, rangeFromDays, todayISO } from '@/lib/utils/period';

/**
 * PeriodPicker — le sélecteur de période partagé par Rapports et Charges.
 *
 * Les fonctions pures (bornage, clamp) sont déjà couvertes par
 * `tests/period.test.mts`. On teste ici ce qui n'existe que dans le
 * composant : ce que fait un clic, et ce que fait changer le plafond de plan.
 */
type Range = { from: string; to: string };

function lastRange(onChange: ReturnType<typeof vi.fn>): Range {
  return onChange.mock.calls.at(-1)?.[0] as Range;
}

describe('PeriodPicker', () => {
  it('applique le raccourci cliqué, calé sur aujourd’hui', () => {
    const onChange = vi.fn();
    render(<PeriodPicker value={rangeFromDays(30)} onChange={onChange} />);

    // la plage de départ est valide : aucune correction à l'affichage
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '7 jours' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const range = lastRange(onChange);
    expect(range.to).toBe(todayISO());
    expect(daysBetween(range.from, range.to)).toBe(7);
  });

  it('ne propose aucun raccourci au-delà du plafond du plan', () => {
    render(
      <PeriodPicker value={rangeFromDays(7)} onChange={vi.fn()} maxDays={7} />
    );

    expect(screen.getByRole('button', { name: '7 jours' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '30 jours' })).toBeNull();
    expect(screen.queryByRole('button', { name: '1 an' })).toBeNull();
  });

  it('ramène dans le plafond une période qui le dépasse, sans rien afficher en clair', () => {
    const onChange = vi.fn();
    render(
      <PeriodPicker value={rangeFromDays(90)} onChange={onChange} maxDays={7} />
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    const range = lastRange(onChange);
    expect(daysBetween(range.from, range.to)).toBeLessThanOrEqual(7);
    // la période reste cohérente : début <= fin
    expect(range.from <= range.to).toBe(true);
  });

  it('n’ouvre le choix libre que sur demande', () => {
    render(<PeriodPicker value={rangeFromDays(7)} onChange={vi.fn()} />);

    expect(screen.queryByLabelText('Date de début')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Dates/ }));

    expect(screen.getByLabelText('Date de début')).toBeInTheDocument();
    expect(screen.getByLabelText('Date de fin')).toBeInTheDocument();
  });
});
