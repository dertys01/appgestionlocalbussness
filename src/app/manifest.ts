import type { MetadataRoute } from "next";

/**
 * Manifeste PWA (P2) — c'est lui qui rend l'application installable sur
 * Android (Chrome) et qui donne son nom à l'icône sur l'écran d'accueil
 * iOS. Le lien vers ce manifeste est posé automatiquement par Next.
 *
 * Les couleurs suivent l'identité visuelle : indigo-600 pour la marque,
 * slate-50 pour le fond de l'application (le même que le `body`).
 * Les textes restent sans chiffre : c'est un manifeste d'application,
 * pas un document commercial.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GestionLocal - caisse, dettes et stock",
    short_name: "GestionLocal",
    description: "Caisse, carnet de dettes et stock pour les commerces de proximité",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#4f46e5",
    lang: "fr",
    icons: [
      { src: "/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
