/**
 * Service worker GestionLocal (P7) — app shell hors-ligne.
 *
 * Deux responsabilités, et rien d'autre :
 *
 *   1. fichiers statiques de Next (`/_next/static/`, noms hashés) → cache-first.
 *      Ils ne changent jamais en place, un cache qui vieillit est inoffensif.
 *
 *   2. NAVIGATIONS (chargements de page) → réseau d'abord, repli sur le cache.
 *      C'est ce qui permet de ROUVRIR l'application sans réseau : sans lui, le
 *      navigateur affichait une erreur de connexion, et le caissier ne pouvait
 *      pas atteindre la caisse — alors même que la file de ventes hors-ligne
 *      existait. Le réseau reste prioritaire : en ligne, la page est toujours
 *      fraîche ; le cache ne sert qu'en secours.
 *
 * Ce qui n'est PAS mis en cache : les routes serveur (API) et les données
 * Supabase (données vivantes). Le catalogue, lui, a son propre cache IndexedDB
 * (voir src/lib/offline/catalogue.ts), indexé par boutique.
 */

const VERSION = 'v2';
const STATIQUE = `gestionlocal-statique-${VERSION}`;
const APP = `gestionlocal-app-${VERSION}`;

self.addEventListener('install', (event) => {
  // Pré-cache de la coquille : dès l'installation (en ligne), on garde le HTML
  // de la racine pour pouvoir le resservir hors-ligne.
  event.waitUntil(
    caches.open(APP)
      .then((cache) => cache.add('/').catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const anciennes = await caches.keys();
    await Promise.all(
      anciennes
        .filter((nom) => nom !== STATIQUE && nom !== APP)
        .map((nom) => caches.delete(nom))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Même origine, GET, rien d'autre.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Navigations : réseau d'abord, cache en secours.
  if (event.request.mode === 'navigate') {
    event.respondWith(reseauPuisCache(event.request));
  }
});

async function cacheFirst(requete) {
  const cache = await caches.open(STATIQUE);
  const enCache = await cache.match(requete);
  if (enCache) return enCache;
  const reponse = await fetch(requete);
  if (reponse.ok) cache.put(requete, reponse.clone());
  return reponse;
}

async function reseauPuisCache(requete) {
  const cache = await caches.open(APP);
  try {
    const reponse = await fetch(requete);
    if (reponse.ok) cache.put(requete, reponse.clone());
    return reponse;
  } catch {
    const enCache = await cache.match(requete);
    if (enCache) return enCache;
    // Repli ultime : la coquille de la racine, pré-cachée à l'installation.
    const coquille = await cache.match('/');
    if (coquille) return coquille;
    throw new Error('hors-ligne, aucune page en cache');
  }
}
