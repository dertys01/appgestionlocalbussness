import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption,
} from '@/components/ui/table';

/**
 * Primitives de tableau : un minimum de couverture, mais surtout la preuve que
 * la sémantique HTML attendue par les lecteurs d'écran est bien rendue
 * (table / columnheader / cell).
 */
describe('ui/table', () => {
  it('rend un tableau avec ses rôles accessibles', () => {
    render(
      <Table>
        <TableCaption>Ventes du jour</TableCaption>
        <TableHeader>
          <TableRow><TableHead>Produit</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell>Riz</TableCell></TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Produit' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Riz' })).toBeInTheDocument();
    expect(screen.getByText('Ventes du jour')).toBeInTheDocument();
  });
});
