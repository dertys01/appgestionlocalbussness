'use client';

import { useEffect, useState } from 'react';
import { Calendar } from 'lucide-react';
import {
  MAX_PERIOD_DAYS, PERIOD_PRESETS, addDays, clampRange, daysBetween,
  isValidRange, rangeFromDays, todayISO, type DateRange, type PeriodPreset,
} from '@/lib/utils/period';

interface PeriodPickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /**
   * Plafond imposé par le plan (`salesHistoryDays`). `Infinity` pour les plans
   * sans limite. Passé ici plutôt que lu dans le composant : le sélecteur ne
   * doit rien savoir des abonnements.
   */
  maxDays?: number;
  className?: string;
}

/**
 * Sélecteur de période : cinq raccourcis plus un choix libre, borné à un an.
 *
 * Un commerçant compare rarement « les 30 derniers jours » à « les 30 derniers
 * jours » : il veut comparer deux mois, ou l'année dernière au même moment.
 * D'où les raccourcis 6 mois et 1 an, et un sélecteur de dates.
 */
export function PeriodPicker({
  value,
  onChange,
  maxDays = MAX_PERIOD_DAYS,
  className = '',
}: PeriodPickerProps) {
  const [custom, setCustom] = useState(false);
  const today = todayISO();
  const ceiling = Math.min(maxDays, MAX_PERIOD_DAYS);

  // bornes des champs date : jamais dans le futur, jamais au-delà du plafond
  const minDate = addDays(today, -(ceiling - 1));
  const tooLong = daysBetween(value.from, value.to) > ceiling;

  // Le raccourci correspondant est mis en avant quand la période correspond
  // exactement ; sinon on retombe sur « Dates ».
  const matched = PERIOD_PRESETS.find((p) => {
    const r = rangeFromDays(p.value, today);
    return r.from === value.from && r.to === value.to;
  });

  const pickPreset = (days: PeriodPreset) => {
    setCustom(false);
    onChange(clampRange(rangeFromDays(days, today), ceiling));
  };

  // Si le plafond change alors qu'une période hors plafond est active, on la
  // ramène dans les limites plutôt que d'afficher un avertissement permanent.
  useEffect(() => {
    if (!isValidRange(value) || tooLong) onChange(clampRange(value, ceiling));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceiling]);

  const setField = (field: 'from' | 'to', raw: string) => {
    if (!raw) return;
    const next = clampRange({ ...value, [field]: raw }, ceiling);
    if (next.from > next.to) onChange({ from: next.to, to: next.from });
    else onChange(next);
  };

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex flex-wrap gap-1.5">
        {PERIOD_PRESETS.filter((p) => p.value <= ceiling).map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => pickPreset(p.value)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              matched?.value === p.value && !custom
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {p.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setCustom((v) => !v)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1 ${
            custom
              ? 'bg-white text-indigo-600 shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Calendar className="w-3 h-3" /> Dates
        </button>
      </div>

      {custom && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={value.from}
            min={minDate}
            max={value.to > today ? today : value.to}
            onChange={(e) => setField('from', e.target.value)}
            aria-label="Date de début"
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <span className="text-xs text-slate-500" aria-hidden="true">&rarr;</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            max={today}
            onChange={(e) => setField('to', e.target.value)}
            aria-label="Date de fin"
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <span className="text-xs text-slate-500">
            {daysBetween(value.from, value.to)} jours
            {tooLong ? `, ramené à ${ceiling}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
