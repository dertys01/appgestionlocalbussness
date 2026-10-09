/**
 * Cache local par clé (P7 — app utilisable hors-ligne).
 *
 * Trois choses y vivent, toutes indexées par identifiant pour ne jamais
 * mélanger deux commerces sur le même appareil :
 *
 *   • `catalogue:<ownerId>` → les produits. Sans lui, rouvrir l'app sans
 *     réseau montrait une caisse VIDE.
 *   • `boutique:<ownerId>`  → l'organisation. Sans lui, `home-client` restait
 *     bloqué sur « Lecture de la boutique impossible » et NE RENDAIT PAS la
 *     caisse — le cache catalogue devenait donc inutile.
 *   • `membre:<userId>`     → le rattachement (patron/employé, ownerId). Sans
 *     lui, un employé hors-ligne était pris pour un patron, et cherchait un
 *     catalogue sous le mauvais identifiant.
 *
 * Ce n'est PAS une source de vérité : on n'y lit qu'en repli quand le réseau
 * échoue. Dès que le réseau revient, la lecture serveur écrase. La RLS reste
 * la garde réelle : ce cache ne donne accès à rien qui ne soit déjà local.
 *
 * IndexedDB absent (rendu serveur, navigation privée stricte) : tout s'efface
 * proprement, l'appelant retombe sur son erreur réseau.
 */

const DB_NAME = 'gestionlocal-cache';
const DB_VERSION = 1;
const STORE = 'cache';

interface Entree {
  cle: string;
  valeur: unknown;
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
        db.createObjectStore(STORE, { keyPath: 'cle' });
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

async function ecrire(cle: string, valeur: unknown): Promise<void> {
  if (!disponible()) return;
  try {
    await transaction('readwrite', (s) => s.put({ cle, valeur, maj: Date.now() } satisfies Entree));
  } catch {
    /* stockage plein / privé : le cache est un confort, pas une condition */
  }
}

async function lire<T>(cle: string): Promise<T | null> {
  if (!disponible()) return null;
  try {
    const e = await transaction<Entree | undefined>('readonly', (s) => s.get(cle));
    return e ? (e.valeur as T) : null;
  } catch {
    return null;
  }
}

// ── Catalogue ───────────────────────────────────────────────
export const ecrireCatalogue = (ownerId: string, produits: unknown[]) => ecrire(`catalogue:${ownerId}`, produits);
export const lireCatalogue = <T = unknown[]>(ownerId: string) => lire<T>(`catalogue:${ownerId}`);

// ── Boutique (organisation) ─────────────────────────────────
export const ecrireBoutique = (ownerId: string, org: unknown) => ecrire(`boutique:${ownerId}`, org);
export const lireBoutique = <T>(ownerId: string) => lire<T>(`boutique:${ownerId}`);

// ── Rattachement (membre) ───────────────────────────────────
export const ecrireMembre = (userId: string, membre: unknown) => ecrire(`membre:${userId}`, membre);
export const lireMembre = <T>(userId: string) => lire<T>(`membre:${userId}`);
