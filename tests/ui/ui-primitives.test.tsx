import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Primitives d'affichage : Card et Dialog.
 *
 * Elles portent le style et les `data-slot` (utilisés par les sélecteurs de
 * style), et le dialogue doit rester accessible (rôle, titre, bouton de
 * fermeture nommé).
 */
import {
  Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter,
} from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose,
} from '@/components/ui/dialog';

describe('Card', () => {
  it('rend une carte avec sa taille et son contenu', () => {
    render(
      <Card size="sm" className="ma-classe" data-testid="carte">
        <CardHeader><CardTitle>Titre</CardTitle><CardDescription>Desc</CardDescription></CardHeader>
        <CardAction>Action</CardAction>
        <CardContent>Contenu</CardContent>
        <CardFooter>Pied</CardFooter>
      </Card>,
    );

    const carte = screen.getByTestId('carte');
    expect(carte).toHaveAttribute('data-slot', 'card');
    expect(carte).toHaveAttribute('data-size', 'sm');
    expect(carte.className).toContain('ma-classe');
    expect(screen.getByText('Titre')).toHaveAttribute('data-slot', 'card-title');
    expect(screen.getByText('Desc')).toHaveAttribute('data-slot', 'card-description');
    expect(screen.getByText('Action')).toHaveAttribute('data-slot', 'card-action');
    expect(screen.getByText('Contenu')).toHaveAttribute('data-slot', 'card-content');
    expect(screen.getByText('Pied')).toHaveAttribute('data-slot', 'card-footer');
  });
});

describe('Dialog', () => {
  it('affiche un dialogue accessible avec titre, description et fermeture', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer</DialogTitle>
            <DialogDescription>Action définitive.</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <button>OK</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const dialogue = screen.getByRole('dialog');
    expect(dialogue).toHaveAccessibleName('Confirmer');
    expect(screen.getByText('Action définitive.')).toBeInTheDocument();
    // Bouton de fermeture nommé (icône seule sinon) + celui du pied.
    expect(screen.getByRole('button', { name: 'Fermer la fenêtre' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeInTheDocument();
  });

  it('ne rend rien quand il est fermé', () => {
    render(
      <Dialog open={false}>
        <DialogContent><DialogTitle>Invisible</DialogTitle></DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('expose les déclencheurs et fermetures', () => {
    render(
      <Dialog open>
        <DialogTrigger>Ouvrir</DialogTrigger>
        <DialogContent>
          <DialogTitle>Titre</DialogTitle>
          <DialogClose>Fermer ici</DialogClose>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Fermer ici' })).toBeInTheDocument();
  });
});
