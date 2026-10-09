/**
 * File d'attente des ventes encaissées hors-ligne (P7).
 *
 * Principe : quand la caisse ne peut pas joindre le serveur, la vente n'est pas
 * perdue — elle est écrite dans IndexedDB et rejouée au retour du réseau. Le
 * rejeu est sûr parce que chaque vente porte une référence unique
 * (`client_ref`) : `create_sale()` renvoie la vente existante si la référence a
 * déjà servi, donc une réponse perdue ne double jamais le stock ni le CA.
 *
 * Ce module ne fait AUCUN appel réseau : il ne fait qu'écrire et lire la file.
 * Le rejeu vit dans `useOfflineSync`.
 *
 * IndexedDB peut être absent (rendu serveur, navigation privée stricte, tests) :
 * toutes les fonctions s'effacent alors proprement — l'appelant décide quoi
 * faire (afficher l'erreur réseau classique).
 */

const DB_NAME = 'gestionlocal';
const DB_VERSION = 1;
const STORE = 'ventes_en_attente';

export interface VenteEnAttente {
  /** Référence idempotente, générée par la caisse (client_ref). */
  ref: string;
  /** Horodatage de mise en file (diagnostic et tri). */
  cree: number;
  /** Arguments de l'appel RPC, tels qu'ils seront rejoués. */
  payload: Record<string, unknown>;
}

/** Vrai si le navigateur expose IndexedDB (sinon : pas de file possible). */
export function fileDisponible(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Prévient l'interface que la file a changé (ajout ou retrait). Permet à
 * l'indicateur « N en attente » de se mettre à jour sans coupler la caisse au
 * composant qui l'affiche.
 */
const EVENEMENT = 'gl:file-hors-ligne';

function notifier(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENEMENT));
}

export { EVENEMENT as EVENEMENT_FILE_HORS_LIGNE };

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'ref' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transaction<T>(mode: IDBTransactionMode, travail: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return ouvrir().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = travail(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

/** Ajoute (ou remplace) une vente en attente. Renvoie false si la file est absente. */
export async function mettreEnFile(vente: VenteEnAttente): Promise<boolean> {
  if (!fileDisponible()) return false;
  try {
    await transaction('readwrite', (s) => s.put(vente));
    notifier();
    return true;
  } catch {
    return false;
  }
}

/** Toutes les ventes en attente, de la plus ancienne à la plus récente. */
export async function lireFile(): Promise<VenteEnAttente[]> {
  if (!fileDisponible()) return [];
  try {
    const tout = await transaction<VenteEnAttente[]>('readonly', (s) => s.getAll());
    return (tout ?? []).sort((a, b) => a.cree - b.cree);
  } catch {
    return [];
  }
}

/** Retire une vente de la file (après rejeu réussi). */
export async function retirerDeFile(ref: string): Promise<void> {
  if (!fileDisponible()) return;
  try {
    await transaction('readwrite', (s) => s.delete(ref));
    notifier();
  } catch {
    /* rien à faire : la vente sera rejouée et dédupliquée par client_ref */
  }
}

/** Nombre de ventes en attente (0 si la file est indisponible). */
export async function compterFile(): Promise<number> {
  return (await lireFile()).length;
}
