/**
 * Service worker GestionLocal (P2) — volontairement minimal.
 *
 * Il ne met en cache QUE les fichiers statiques de Next (`/_next/static/`),
 * reconnaissables à leur nom hashé : ils ne changent jamais en place, donc
 * un cache pour vieillir est inoffensif et accélère les revisions.
 *
 * Aucune donnée de commerce ici : l'API Supabase, les ventes, le stock et
 * les dettes passent toujours par le réseau. Ce service worker n'apporte
 * PAS le mode hors ligne — c'est un chantier distinct (P7), qui n'a rien à
 * faire passer pour autre chose.
 */

const CACHE = 'gestionlocal-statique-v1';

self.addEventListener('install', () => {
  // Pas d'attente : la version suivante prend le relais immédiatement.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const anciennes = await caches.keys();
    await Promise.all(
      anciennes.filter((nom) => nom !== CACHE).map((nom) => caches.delete(nom))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Même origine, GET, et fichier statique hashé — rien d'autre.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/_next/static/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const enCache = await cache.match(event.request);
    if (enCache) return enCache;
    const reponse = await fetch(event.request);
    if (reponse.ok) cache.put(event.request, reponse.clone());
    return reponse;
  })());
});
