import { useEffect } from 'react';
import type { Tab } from '@/types';

/**
 * Bouton retour du système (Android, navigateur) : chaque onglet pose sa
 * propre entrée d'historique, sinon le retour quitte l'application au lieu
 * de revenir au tableau de bord ou à l'écran précédent — une SPA à onglets
 * n'offre qu'une entrée, le retour la ferme.
 *
 * À l'ouverture, l'entrée est REMPLACÉE (pas empilée) : revenir du premier
 * écran affiché doit sortir, il n'y a nulle part où aller. Un état inconnu
 * retombe sur le tableau de bord, comme la garde de rendu de l'accueil.
 */
const ONGLETS: Tab[] = ['dashboard', 'pos', 'inventory', 'sales', 'debts',
  'reports', 'forecast', 'team', 'floor', 'recipes', 'settings'];

export function useHistoriqueOnglets(tab: Tab, setTab: (t: Tab) => void) {
  useEffect(() => {
    window.history.replaceState({ tab: 'dashboard' }, '');
    const retour = (e: PopStateEvent) => {
      const t = (e.state as { tab?: unknown } | null)?.tab;
      setTab(
        typeof t === 'string' && (ONGLETS as string[]).includes(t)
          ? (t as Tab)
          : 'dashboard',
      );
    };
    window.addEventListener('popstate', retour);
    return () => window.removeEventListener('popstate', retour);
  }, [setTab]);

  useEffect(() => {
    // Déjà l'entrée courante (retour arrière traité ci-dessus) : ne pas
    // réempiler, sinon le retour tournerait en rond sur le même écran.
    if ((window.history.state as { tab?: unknown } | null)?.tab === tab) return;
    window.history.pushState({ tab }, '');
  }, [tab]);
}
