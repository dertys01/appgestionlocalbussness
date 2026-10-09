'use client';

import { useEffect, useState } from 'react';
import { LayoutDashboard, Lock, Settings, ScanBarcode, RefreshCw, LogOut, X } from 'lucide-react';
import type { NavItem, Tab } from '@/types';

interface SidebarProps {
  tab: Tab;
  items: NavItem[];
  email?: string;
  loadingProducts: boolean;
  /** Tiroir déployé sur mobile. Sans importance à partir de lg, où le rail est permanent. */
  open: boolean;
  onClose: () => void;
  onTab: (tab: Tab) => void;
  onScan: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}

export function Sidebar({
  tab, items, email, loadingProducts, open, onClose,
  onTab, onScan, onRefresh, onSignOut,
}: SidebarProps) {
  // Échap referme le tiroir : sur mobile il occupe la moitié de l'écran, sans
  // moyen de s'en sortir au doigt s'il n'a pas été ouvert volontairement.
  useEffect(() => {
    if (!open) return;
    const surEchap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', surEchap);
    return () => window.removeEventListener('keydown', surEchap);
  }, [open, onClose]);

  // Le tiroir fermé reste dans le DOM : il est hors écran, pas absent. Sans
  // inert, la tabulation et les lecteurs d'écran parcouraient un menu
  // invisible. On suppose le grand écran au premier rendu, pour que le rendu
  // serveur et le premier rendu restent corrects.
  const [grandEcran, setGrandEcran] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const suivre = () => setGrandEcran(mq.matches);
    suivre();
    mq.addEventListener('change', suivre);
    return () => mq.removeEventListener('change', suivre);
  }, []);

  const inerte = !grandEcran && !open;

  // Le tiroir déployé montre ses libellés, le rail réduit non. À partir de lg
  // le libellé s'affiche de nouveau quoi qu'il arrive.
  const libelles = open ? 'flex items-center gap-1.5' : 'hidden lg:flex lg:items-center lg:gap-1.5';
  const libelleSimple = open ? 'block' : 'hidden lg:block';

  const naviguer = (cible: Tab) => {
    onTab(cible);
    onClose();
  };

  return (
    <>
      {/* Voile : ferme le tiroir. z-40, sous le tiroir (z-50) et sous la barre
          du bas du POS (z-30) — donc au-dessus d'elle, ce qui est correct :
          quand le menu est ouvert, il doit pouvoir le recouvrir. */}
      {open && (
        <button
          className="lg:hidden fixed inset-0 z-40 bg-black/50"
          onClick={onClose}
          aria-label="Fermer le menu"
        />
      )}

      <aside
        className={`fixed left-0 top-0 h-full z-50 lg:z-40 flex flex-col bg-white border-r border-slate-200 transition-all lg:w-56 ${
          open ? 'translate-x-0 w-64 shadow-xl' : '-translate-x-full lg:translate-x-0 w-16'
        }`}
        inert={inerte}
      >
        {/* Logo + fermeture (mobile seulement) */}
        <div className="px-3 lg:px-5 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <LayoutDashboard className="h-4 w-4 text-white" />
          </div>
          <span className={libelleSimple + ' font-bold text-indigo-600 text-sm leading-tight'}>
            GestionLocal
          </span>
          {/* Le bouton de fermeture n'existe que tiroir ouvert : laissé en place, il
              restait atteignable au clavier alors que le tiroir était fermé. */}
          {open && (
            <button
              onClick={onClose}
              className="ml-auto p-1 text-slate-500 hover:text-slate-700 lg:hidden"
              aria-label="Fermer le menu"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-3 space-y-1 px-2 overflow-y-auto">
          {items.map(({ key, label, icon: Icon, locked, badge }) => (
            <button
              key={key}
              onClick={() => naviguer(locked ? 'settings' : key)}
              title={locked ? `${label} — Plan supérieur requis` : label}
              aria-label={label}
              className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                tab === key
                  ? 'bg-indigo-50 text-indigo-600'
                  : locked
                    ? 'text-slate-300 cursor-pointer'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className={libelles}>
                {label}
                {locked && <Lock className="w-3 h-3 text-slate-300" />}
                {/* P6 : pastille « à relancer », Dettes uniquement. Le zéro
                    ne s'affiche jamais — une pastille à zéro punirait
                    l'ouverture du menu pour rien. */}
                {badge !== undefined && badge > 0 && (
                  <span
                    aria-label={`${badge} dette${badge > 1 ? 's' : ''} à relancer`}
                    className="ml-auto mr-1 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-amber-500 text-white text-[11px] font-bold tabular-nums"
                  >
                    {badge}
                  </span>
                )}
              </span>
            </button>
          ))}
        </nav>

        {/* Footer sidebar */}
        <div className="border-t border-slate-100 p-2 space-y-1">
          <button
            onClick={() => naviguer('settings')}
            title="Paramètres"
            aria-label="Paramètres"
            className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Settings className="h-5 w-5 shrink-0" />
            <span className={libelleSimple}>Paramètres</span>
          </button>
          <button
            onClick={onScan}
            title="Scanner"
            aria-label="Scanner"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50"
          >
            <ScanBarcode className="h-5 w-5 shrink-0" />
            <span className={libelleSimple}>Scanner</span>
          </button>
          <button
            onClick={onRefresh}
            disabled={loadingProducts}
            title="Actualiser"
            aria-label="Actualiser"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            <RefreshCw className={`h-5 w-5 shrink-0 ${loadingProducts ? 'animate-spin' : ''}`} />
            <span className={libelleSimple}>Actualiser</span>
          </button>
          {email && (
            <div className="px-2 py-1">
              <div
                role="img"
                aria-label={email}
                title={email}
                className={`mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 ${
                  open ? 'hidden' : 'lg:hidden'
                }`}
              >
                {email.charAt(0).toUpperCase()}
              </div>
              <p className={libelleSimple + ' text-xs text-slate-500 truncate'}>{email}</p>
            </div>
          )}
          <button
            onClick={onSignOut}
            title="Déconnexion"
            aria-label="Déconnexion"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className={libelleSimple}>Déconnexion</span>
          </button>
        </div>
      </aside>
    </>
  );
}
