import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { SupabaseProvider } from "@/components/providers/SupabaseProvider";
import { EnregistreurPWA } from "@/components/pwa/EnregistreurPWA";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "GestionLocal — ERP/POS",
  description: "Application de gestion commerciale pour petites entreprises",
  applicationName: "GestionLocal",
  // iOS ne lit pas le manifeste : il veut une icône dédiée.
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  // Indigo-600, la couleur de marque, pour la barre du navigateur installée.
  themeColor: "#4f46e5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className={`${inter.className} min-h-full bg-slate-50 text-slate-900`}>
        <SupabaseProvider>
          {children}
        </SupabaseProvider>
        <EnregistreurPWA />
      </body>
    </html>
  );
}
