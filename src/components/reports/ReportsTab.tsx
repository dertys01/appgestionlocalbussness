'use client';

import dynamic from 'next/dynamic';
import { ProfitabilityModule } from '@/components/reports/ProfitabilityModule';
import { ExpensesModule } from '@/components/reports/ExpensesModule';
import type { ReportView } from '@/types';

// Chargé à la demande : recharts ne doit pas entrer dans le bundle initial,
// qui est téléchargé à chaque ouverture de la caisse. L'onglet Rapports n'est
// jamais rendu au premier affichage (onglet par défaut : dashboard), donc
// personne n'attend ce chargement.
const ReportsModule = dynamic(
  () => import('@/components/reports/ReportsModule').then((mod) => mod.ReportsModule),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin h-8 w-8 rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    ),
  }
);

interface ReportsTabProps {
  view: ReportView;
  onView: (view: ReportView) => void;
}

export function ReportsTab({ view, onView }: ReportsTabProps) {
  return (
    <div className="space-y-4">
      {/* flex-wrap : à 320 px, les trois onglets (« Ventes », « Rentabilité »,
          « Charges ») tenant sur une rangée non-wrap débordaient de 44 px et
          « Charges » sortait de l'écran. Le titre descend d'une ligne plutôt
          que de couper le sélecteur de vue. */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold text-slate-800">Rapports &amp; Analyses</h2>
        <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5 text-sm">
          <button
            onClick={() => onView('sales')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              view === 'sales' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
            }`}
          >
            Ventes
          </button>
          <button
            onClick={() => onView('profit')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              view === 'profit' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
            }`}
          >
            Rentabilité
          </button>
          <button
            onClick={() => onView('expenses')}
            className={`px-3 py-1 rounded-md font-medium transition-colors ${
              view === 'expenses' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600'
            }`}
          >
            Charges
          </button>
        </div>
      </div>
      {view === 'sales' && <ReportsModule />}
      {view === 'profit' && <ProfitabilityModule />}
      {view === 'expenses' && <ExpensesModule />}
    </div>
  );
}
