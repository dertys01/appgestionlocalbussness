/**
 * Cache local du catalogue (P7 — app utilisable hors-ligne).
 *
 * Sans lui, rouvrir l'application sans réseau montrait une caisse VIDE : le
 * caissier ne pouvait plus rien vendre, alors même que la file hors-ligne
 * existait. On conserve donc le dernier catalogue lu, par boutique, dans un
 * IndexedDB dédié.
 *
 * Ce cache n'est PAS une source de vérité : il ne sert qu'en repli quand la
 * lecture réseau échoue. Dès que le réseau revient, la lecture serveur
 * l'écrase. Il est indexé par `ownerId` : deux boutiques sur le même appareil
 * ne se voient pas.
 *
 * IndexedDB absent (rendu serveur, navigation privée stricte) : toutes les
 * fonctions s'effacent proprement, l'appelant retombe sur son erreur réseau.
 */

const DB_NAME = 'gestionlocal-catalogue';
const DB_VERSION = 1;
const STORE = 'catalogue';

/** Une entrée = { ownerId, produits, maj }. `ownerId` est la clé. */
interface EntreeCatalogue {
  ownerId: string;
  produits: unknown[];
  maj: number;
}

function disponible(): boolean {
  return typeof indexedDB !== 'undefined';
}

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'ownerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transaction<T>(mode: IDBTransactionMode, travail: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return ouvrir().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = travail(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

/** Enregistre le catalogue courant pour cette boutique. */
export async function ecrireCatalogue(ownerId: string, produits: unknown[]): Promise<void> {
  if (!disponible() || !ownerId) return;
  try {
    await transaction('readwrite', (s) => s.put({ ownerId, produits, maj: Date.now() } satisfies EntreeCatalogue));
  } catch {
    /* stockage plein / privé : le cache est un confort, pas une condition */
  }
}

/** Lit le dernier catalogue enregistré pour cette boutique, ou null. */
export async function lireCatalogue(ownerId: string): Promise<unknown[] | null> {
  if (!disponible() || !ownerId) return null;
  try {
    const e = await transaction<EntreeCatalogue | undefined>('readonly', (s) => s.get(ownerId));
    return e?.produits ?? null;
  } catch {
    return null;
  }
}
