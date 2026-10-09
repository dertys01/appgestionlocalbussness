import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LandingPage } from '@/components/marketing/LandingPage';

/**
 * Page d'accueil publique (P8).
 *
 * Avant P8, l'adresse du site ouvrait le formulaire de connexion. Ce test
 * tient les trois promesses de la page : elle est publique (aucun champ de
 * session), elle présente l'application avec ses captures, et chaque chemin
 * de sortie (inscription, tarifs, connexion, WhatsApp) est atteignable.
 *
 * Le numéro WhatsApp est lu depuis le composant, pas répété ici : c'est le
 * composant qui doit être juste, le test ne fait que vérifier qu'il y est.
 */

describe('LandingPage — accueil public', () => {
  it('présente le produit en un titre et une accroche', () => {
    render(<LandingPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: /caisse qui suit vos ventes/i }),
    ).toBeTruthy();
    expect(screen.getByText(/application des commerçants/i)).toBeTruthy();
  });

  it('affiche les trois captures avec un texte alternatif', () => {
    render(<LandingPage />);
    expect(screen.getByAltText(/tableau du jour/i)).toBeTruthy();
    expect(screen.getByAltText(/point de vente/i)).toBeTruthy();
    expect(screen.getByAltText(/journal des ventes/i)).toBeTruthy();
  });

  it('ne contient aucun champ de session (le formulaire est à /connexion)', () => {
    render(<LandingPage />);
    expect(screen.queryByLabelText('Mot de passe')).toBeNull();
    expect(screen.queryByRole('button', { name: /connexion|connectez/i })).toBeNull();
  });

  it('emmène vers l’inscription, les tarifs, la connexion et WhatsApp', () => {
    render(<LandingPage />);
    const liens = screen.getAllByRole('link');
    const hrefs = liens.map((l) => l.getAttribute('href'));

    expect(hrefs.filter((h) => h === '/register').length).toBeGreaterThanOrEqual(2);
    expect(hrefs).toContain('/tarifs');
    expect(hrefs).toContain('/connexion');

    const wa = liens.find((l) => l.getAttribute('href')?.includes('wa.me/'));
    expect(wa).toBeTruthy();
    expect(wa?.getAttribute('href')).toContain('wa.me/');
    expect(wa?.getAttribute('target')).toBe('_blank');
    // Relance le même message qu'une relance : ouverture sans destinataire,
    // texte prérempli.
    expect(decodeURIComponent(wa?.getAttribute('href') ?? '')).toContain(
      'créer ma boutique',
    );
  });

  it('ouvre le lien WhatsApp dans un nouvel onglet, sans page ouverte', () => {
    render(<LandingPage />);
    const wa = screen.getAllByRole('link').filter((l) =>
      l.getAttribute('href')?.includes('wa.me/'),
    );
    expect(wa.length).toBeGreaterThanOrEqual(2); // héros + pied de page
    for (const lien of wa) {
      expect(lien.getAttribute('rel')).toContain('noopener');
      expect(lien.getAttribute('target')).toBe('_blank');
    }
  });

  it('ne promet aucune valeur d’offre dans la copie', () => {
    render(<LandingPage />);
    const texte = document.body.textContent ?? '';
    // Ni prix, ni plafond, ni durée : ces chiffres ne vivent pas dans le dépôt.
    expect(texte).not.toMatch(/\d[\d\s .]*F\b/);
    expect(texte).not.toMatch(/\d+ (produits?|utilisateurs?|jours)/i);
    expect(texte).not.toMatch(/\/ mois/);
  });
});
