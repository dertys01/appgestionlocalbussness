'use client';

import { useEffect } from 'react';

/**
 * Enregistre le service worker (P2).
 *
 * Le service worker ne met en cache que les fichiers statiques de Next :
 * les données de la boutique (ventes, stock, dettes) passent toujours par
 * le réseau. Ce n'est pas le mode hors ligne — chantier distinct (P7).
 *
 * Rien en développement : un service worker actif en local fige les
 * ressources et brouille les recettes.
 */
export function EnregistreurPWA() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .catch(() => {
        // Un service worker qui échoue ne doit jamais gêner l'application.
      });
  }, []);
  return null;
}
