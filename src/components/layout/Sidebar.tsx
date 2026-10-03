'use client';

import { LayoutDashboard, Lock, Settings, ScanBarcode, RefreshCw, LogOut } from 'lucide-react';
import type { NavItem, Tab } from '@/types';

interface SidebarProps {
  tab: Tab;
  items: NavItem[];
  email?: string;
  loadingProducts: boolean;
  onTab: (tab: Tab) => void;
  onScan: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}

export function Sidebar({ tab, items, email, loadingProducts, onTab, onScan, onRefresh, onSignOut }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 h-full z-40 flex flex-col bg-white border-r border-slate-200 w-16 lg:w-56 transition-all">
      {/* Logo */}
      <div className="px-3 lg:px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <LayoutDashboard className="h-4 w-4 text-white" />
          </div>
          <span className="hidden lg:block font-bold text-indigo-600 text-sm leading-tight">GestionLocal</span>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-3 space-y-1 px-2">
        {items.map(({ key, label, icon: Icon, locked }) => (
          <button
            key={key}
            onClick={() => { if (!locked) onTab(key); else onTab('settings'); }}
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
            <span className="hidden lg:flex lg:items-center lg:gap-1.5">
              {label}
              {locked && <Lock className="h-3 w-3 text-slate-300" />}
            </span>
          </button>
        ))}
      </nav>

      {/* Footer sidebar */}
      <div className="border-t border-slate-100 p-2 space-y-1">
        <button
          onClick={() => onTab('settings')}
          title="Paramètres"
          aria-label="Paramètres"
          className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            tab === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Settings className="h-5 w-5 shrink-0" />
          <span className="hidden lg:block">Paramètres</span>
        </button>
        <button
          onClick={onScan}
          title="Scanner"
          aria-label="Scanner"
          className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50"
        >
          <ScanBarcode className="h-5 w-5 shrink-0" />
          <span className="hidden lg:block">Scanner</span>
        </button>
        <button
          onClick={onRefresh}
          disabled={loadingProducts}
          title="Actualiser"
          aria-label="Actualiser"
          className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40"
        >
          <RefreshCw className={`h-5 w-5 shrink-0 ${loadingProducts ? 'animate-spin' : ''}`} />
          <span className="hidden lg:block">Actualiser</span>
        </button>
        {/* Compte : pastille sous lg (rail d'icônes), e-mail complet à partir de lg */}
        {email && (
          <div className="px-2 py-1">
            <div
              role="img"
              aria-label={email}
              title={email}
              className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 lg:hidden"
            >
              {email.charAt(0).toUpperCase()}
            </div>
            <p className="hidden lg:block text-xs text-slate-500 truncate">{email}</p>
          </div>
        )}
        <button
          onClick={onSignOut}
          title="Déconnexion"
          aria-label="Déconnexion"
          className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-red-600 hover:bg-red-50 hover:text-red-700"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span className="hidden lg:block">Déconnexion</span>
        </button>
      </div>
    </aside>
  );
}
