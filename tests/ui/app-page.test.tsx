import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * La racine du site : le serveur y porte les métadonnées (titre, aperçu de
 * partage que lit WhatsApp), le corps reste le client.
 */
vi.mock('@/app/home-client', () => ({ default: () => <div>HOME-CLIENT</div> }));

import Page, { metadata } from '@/app/page';

describe('app/page', () => {
  it('rend le composant client', () => {
    render(<Page />);
    expect(screen.getByText('HOME-CLIENT')).toBeInTheDocument();
  });

  it('expose des métadonnées partageables', () => {
    expect(String(metadata.title)).toMatch(/GestionLocal/);
    expect(metadata.description).toBeTruthy();
    const images = metadata.openGraph?.images as Array<{ url: string }>;
    expect(images[0]).toMatchObject({ url: '/icon-512x512.png' });
  });
});
