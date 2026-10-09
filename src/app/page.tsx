import type { Metadata } from 'next';

import HomePage from './home-client';

/**
 * La racine du site — serveur, pour pouvoir porter `metadata` (P8).
 *
 * Le composant 'use client' juste à côté ne peut pas en exporter : c'était
 * le prix, jusqu'ici, de ne pas avoir de page d'accueil publique — l'adresse
 * du site ouvrait le formulaire de connexion, sans titre ni aperçu partageable.
 * Le corps de la page reste intégralement client (session Supabase) ; ce que
 * le serveur rend ici, c'est le `head` — titre, description, image de partage
 * — qui est exactement ce que WhatsApp et les moteurs lisent en premier.
 */
export const metadata: Metadata = {
  title: 'GestionLocal - la caisse, les stocks et les dettes de votre boutique',
  description:
    "Vendez, suivez vos stocks et relevez ce que les clients vous doivent, depuis votre téléphone. Gratuit pour commencer, sans carte bancaire.",
  openGraph: {
    title: 'GestionLocal - la caisse, les stocks et les dettes',
    description:
      "L'application des commerçants : caisse, stocks, dettes clients et relances WhatsApp.",
    images: [{ url: '/icon-512x512.png', width: 512, height: 512 }],
  },
};

export default function Page() {
  return <HomePage />;
}
