import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';
import { invitationARecevoir, modeOuverture } from '@/lib/pwa/installation';
import { matchMediaPour } from './setup';

/**
 * P2 — installabilité : le manifeste, les icônes qu'il désigne, la
 * portée du service worker et la décision d'invitation.
 *
 * Les icônes sont vérifiées sur disque (même méthode que le test du
 * livre d'import) : un manifeste qui pointe un fichier absent passe
 * inaperçu jusqu'au téléphone d'un commerçant.
 */

const SIGNATURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('manifeste PWA', () => {
  const m = manifest();

  it('déclare une application installable, en français', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.lang).toBe('fr');
    expect(m.short_name).toBe('GestionLocal');
  });

  it('porte les couleurs de la marque', () => {
    // Indigo-600 (logo, boutons principaux) et slate-50 (fond du body).
    expect(m.theme_color).toBe('#4f46e5');
    expect(m.background_color).toBe('#f8fafc');
  });

  it('reste sans chiffre : c’est un manifeste, pas un document tarifaire', () => {
    // Les prix contiennent des chiffres : la moindre valeur chiffrée ici
    // serait une fuite dans un dépôt public.
    for (const texte of [m.name, m.short_name, m.description ?? '']) {
      expect(texte).not.toMatch(/\d/);
    }
  });

  it('désigne les trois icônes standard, plein cadre et masquable', () => {
    const icônes = m.icons ?? [];
    expect(icônes).toHaveLength(3);
    const parSrc = new Map(icônes.map((i) => [i.src, i]));
    expect(parSrc.get('/icon-192x192.png')).toMatchObject({ sizes: '192x192', type: 'image/png' });
    expect(parSrc.get('/icon-512x512.png')).toMatchObject({ sizes: '512x512', type: 'image/png' });
    expect(parSrc.get('/icon-maskable-512x512.png')).toMatchObject({
      sizes: '512x512',
      purpose: 'maskable',
    });
  });

  it('les icônes existent sur disque et sont de vrais PNG', () => {
    const cibles = [
      '/icon-192x192.png',
      '/icon-512x512.png',
      '/icon-maskable-512x512.png',
      '/apple-touch-icon.png', // lien posé par le layout pour iOS
    ];
    for (const nom of cibles) {
      const octets = readFileSync(path.join(process.cwd(), 'public', nom));
      expect(octets.subarray(0, 8), `${nom} n'est pas un PNG`).toEqual(SIGNATURE_PNG);
    }
  });
});

describe('service worker — portée', () => {
  const sw = readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');

  it('ne répond que sur les fichiers statiques hashés de Next', () => {
    const prefixes = [...sw.matchAll(/startsWith\('([^']+)'\)/g)].map((d) => d[1]);
    expect(prefixes).toEqual(['/_next/static/']);
  });

  it('ne touche jamais à l’API ni aux données de la boutique', () => {
    expect(sw).not.toContain('supabase');
    expect(sw).not.toContain('/api/');
  });
});

describe('décision d’invitation à l’installation', () => {
  const base = { installe: false, inviteDisponible: false, ios: false, refusee: false };

  it('propose le bouton natif quand Chrome le permet', () => {
    expect(invitationARecevoir({ ...base, inviteDisponible: true })).toEqual({ type: 'bouton' });
  });

  it('donne la consigne iOS quand aucun prompt natif existe', () => {
    expect(invitationARecevoir({ ...base, ios: true })).toEqual({ type: 'ios' });
  });

  it('se tait quand l’application est déjà installée', () => {
    expect(
      invitationARecevoir({ ...base, installe: true, inviteDisponible: true, ios: true })
    ).toEqual({ type: 'aucune' });
  });

  it('respecte un refus déjà exprimé', () => {
    expect(invitationARecevoir({ ...base, refusee: true, inviteDisponible: true })).toEqual({
      type: 'aucune',
    });
  });

  it('ne propose rien sans invitation ni iOS', () => {
    expect(invitationARecevoir(base)).toEqual({ type: 'aucune' });
  });
});

describe('modeOuverture — le relevé P2/P3', () => {
  // jsdom ne joue pas display-mode : on répond à la question posée, et
  // seulement à celle-là, comme le ferait un vrai navigateur.
  const repondre = (standalone: boolean) =>
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: standalone,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: matchMediaPour(1440),
    });
  });

  it("relève 'standalone' quand l'application est ouverte installée", () => {
    repondre(true);
    expect(modeOuverture()).toBe('standalone');
  });

  it("relève 'navigateur' sinon — c'est la valeur par défaut d'un onglet", () => {
    repondre(false);
    expect(modeOuverture()).toBe('navigateur');
  });

  it('la valeur relève se relit telle quelle dans organizations.display_mode', () => {
    // Le CHECK de migration_display_mode.sql n’accepte que ces deux-là :
    // écrire une valeur hors de ce couple échouerait en base.
    repondre(true);
    expect(['standalone', 'navigateur']).toContain(modeOuverture());
    repondre(false);
    expect(['standalone', 'navigateur']).toContain(modeOuverture());
  });
});
