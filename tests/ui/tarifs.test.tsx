import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import TarifsPage, { metadata } from '@/app/tarifs/page';
import {
  PLAN_LABELS,
  isFeatureAllowed,
  lignesQuotas,
  prixAAnnuelLabel,
  prixMensuelLabel,
} from '@/lib/utils/plans';

/**
 * Page publique des formules.
 *
 * Ce qu'on vérifie : chaque plan y figure avec SES valeurs (lues dans la
 * configuration de test, jamais répétées en clair), les fonctions suivent le
 * même verrou que require_feature(), et l'essai reste un bouton explicite —
 * la page ne promet aucun essai automatique à l'inscription.
 */

/**
 * formatCFA sépare les milliers par une espace fine insécable (U+202F) :
 * le normaliseur de Testing Library ne la traite pas de la même façon des
 * deux côtés de la comparaison, et un getByText string échoue sur une
 * chaîne pourtant identique au caractère près. On compare donc le texte
 * brut des <p> de prix.
 */
const dansLeP = (attendu: string) => (_: string, el: Element | null) =>
  el?.tagName === 'P' && el?.textContent === attendu;

const PLANS = ['free', 'starter', 'pro'] as const;

describe('Page /tarifs', () => {
  it('présente les trois formules, avec les prix de la configuration', () => {
    render(<TarifsPage />);

    for (const id of PLANS) {
      expect(screen.getAllByText(PLAN_LABELS[id]).length).toBeGreaterThan(0);
    }

    // Le gratuit est gratuit — la seule valeur tarifaire autorisée en clair.
    expect(screen.getByText('Gratuit, pour toujours')).toBeDefined();

    // Les payants affichent CE QUE DIT LA CONFIGURATION, pas un chiffre du dépôt.
    expect(screen.getByText(dansLeP(prixMensuelLabel('starter')))).toBeDefined();
    expect(screen.getByText(dansLeP(prixMensuelLabel('pro')))).toBeDefined();
    expect(screen.getByText(dansLeP(`ou ${prixAAnnuelLabel('starter')}`))).toBeDefined();
    expect(screen.getByText(dansLeP(`ou ${prixAAnnuelLabel('pro')}`))).toBeDefined();
  });

  it('affiche les quotas de la configuration et les fonctions verrouillées comme en base', () => {
    render(<TarifsPage />);

    // Les lignes de quotas viennent de lignesQuotas() — la configuration, pas
    // un littéral. « 50 produits » n'apparaît ici que parce que le fixture dit
    // 50 ; changer le fixture change le test.
    for (const ligne of lignesQuotas('free')) {
      expect(screen.getAllByText(ligne).length).toBeGreaterThan(0);
    }

    // Miroir de require_feature() : une ligne de fonction par plan qui y a
    // droit, ni une de plus — le total sur la page doit être exactement le
    // nombre de plans autorisés.
    const lignesFonction = [
      { texte: 'Export CSV des données', cle: 'exportCsv' as const },
      { texte: 'Rapports : rentabilité, charges, dettes', cle: 'reports' as const },
      { texte: 'Prévisions de réapprovisionnement', cle: 'forecast' as const },
    ];
    for (const { texte, cle } of lignesFonction) {
      const autorises = PLANS.filter((p) => isFeatureAllowed(p, cle)).length;
      expect(screen.getAllByText(texte)).toHaveLength(autorises);
    }
  });

  it('l’essai est un bouton explicite, jamais une promesse automatique', () => {
    render(<TarifsPage />);

    // L'intitulé voulu, quelque part sur la page.
    expect(screen.getByText(/Démarrer l.essai : 14 jours, sans carte/)).toBeDefined();

    // La page dit que l'essai se démarre depuis les paramètres — pas à
    // l'inscription, pas tout seul — et qu'il n'est proposé qu'une fois.
    expect(screen.getByText(/jamais automatiquement/)).toBeDefined();
    expect(screen.getByText(/une seule fois par boutique/)).toBeDefined();
    expect(screen.getByText(/Paramètres → Abonnement/)).toBeDefined();

    // La page ne démarre rien elle-même : tous ses appels mènent à
    // l'inscription, au retour sur l'accueil, ou au formulaire de connexion
    // (depuis P8 : /connexion, l'accueil étant la page publique).
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs.every((h) => h === '/register' || h === '/' || h === '/connexion')).toBe(true);
    expect(hrefs.filter((h) => h === '/register').length).toBeGreaterThanOrEqual(3);
  });

  it('porte des métadonnées publiques sans montant en clair', () => {
    expect(metadata.title).toBe('Tarifs - GestionLocal');
    expect(metadata.description).toBeTruthy();
    // La description meta est affichée dans les résultats de recherche :
    // elle raconte la structure de l'offre, pas ses montants.
    expect(metadata.description).not.toMatch(/\d[\d\s.]*\s?F/);
    expect(metadata.description).not.toMatch(/FCFA/);
  });
});
