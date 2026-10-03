import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { EmptyState } from '@/components/ui/empty-state';
import { PackageX } from 'lucide-react';

describe('EmptyState', () => {
  it('dit ce qu’on attendait et quoi faire ensuite', () => {
    const { container } = render(
      <EmptyState
        icon={PackageX}
        title="Aucun produit disponible"
        hint="Ajoutez vos produits depuis l’onglet Stock."
      />
    );

    expect(screen.getByText('Aucun produit disponible')).toBeInTheDocument();
    expect(
      screen.getByText('Ajoutez vos produits depuis l’onglet Stock.')
    ).toBeInTheDocument();

    // le pictogramme est décoratif : enterré dans un aria-hidden, jamais lu
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('ne propose de bouton que s’il y a vraiment une action', () => {
    const { rerender } = render(
      <EmptyState icon={PackageX} title="Vide" />
    );
    expect(screen.queryByRole('button')).toBeNull();

    const onClick = vi.fn();
    rerender(<EmptyState icon={PackageX} title="Vide" action={{ label: 'Ajouter', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('se comprime quand il vit dans une carte déjà entourée', () => {
    render(<EmptyState icon={PackageX} title="Vide" className="py-2" />);
    expect(screen.getByText('Vide').parentElement).toHaveClass('py-2');
  });
});
