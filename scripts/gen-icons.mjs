#!/usr/bin/env node
/**
 * Génère les icônes PWA (P2) depuis un dessin source unique.
 *
 * Quatre fichiers, quatre usages :
 *   icon-192x192.png / icon-512x512.png  — icônes du manifeste, coins
 *      arrondis déjà dans le dessin (Android les recoupe de toute façon)
 *   icon-maskable-512x512.png            — masquable : plein cadre, le « G »
 *      reste dans la zone de sécurité centrale (80 %)
 *   apple-touch-icon.png                 — iOS : plein cadre carré
 *
 * Usage : node scripts/gen-icons.mjs
 * sharp est déjà présent (chaîne d'images de Next) ; les PNG sont commités :
 * on ne relance ce script que si le dessin change.
 */
import path from 'node:path';
import sharp from 'sharp';

/** Couleur de marque : indigo-600, la même que le logo de la barre latérale. */
const MARQUE = '#4f46e5';

/**
 * @param {number} taille  côté du carré en px
 * @param {boolean} pleinCadre  vrai = sans coins arrondis (maskable, iOS)
 */
function dessin(taille, pleinCadre) {
  const rayon = pleinCadre ? 0 : Math.round(taille * 0.185);
  const tailleG = Math.round(taille * (pleinCadre ? 0.5 : 0.56));
  // Baseline : la hauteur des capitales fait ~0,72 em, on centre ce bloc.
  const baseline = Math.round(taille / 2 + tailleG * 0.36);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${taille}" height="${taille}" viewBox="0 0 ${taille} ${taille}">
  <rect width="${taille}" height="${taille}" rx="${rayon}" fill="${MARQUE}"/>
  <text x="${taille / 2}" y="${baseline}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-weight="bold"
        font-size="${tailleG}" fill="#ffffff">G</text>
</svg>`;
}

const cibles = [
  ['icon-192x192.png', 192, false],
  ['icon-512x512.png', 512, false],
  ['icon-maskable-512x512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
];

const dossier = path.join(process.cwd(), 'public');
for (const [nom, taille, pleinCadre] of cibles) {
  await sharp(Buffer.from(dessin(taille, pleinCadre)))
    .png({ compressionLevel: 9 })
    .toFile(path.join(dossier, nom));
  console.log(`✓ public/${nom}`);
}
