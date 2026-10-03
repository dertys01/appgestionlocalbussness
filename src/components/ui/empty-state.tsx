import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Pictogramme : donne le sujet en un coup d'œil. Décoratif, jamais lu. */
  icon: LucideIcon;
  /** Ce qu'on attendrait de trouver ici — une phrase, au présent. */
  title: string;
  /**
   * Pourquoi c'est vide **et** quoi faire ensuite. C'est la seule partie qui
   * transforme un cul-de-sac en suite : « Aucun produit » arrête l'utilisateur,
   * « Aucun produit — ajoutez-en d'abord depuis Stock » le remet en marche.
   */
  hint?: ReactNode;
  /** Réservé au cas où l'action est évidente ; sinon le hint suffit. */
  action?: { label: string; onClick: () => void };
  /** Compresse le bloc quand il vit dans une carte déjà entourée. */
  className?: string;
}

/**
 * État vide homogène.
 *
 * Avant, chaque écran réinventait le sien : du `text-slate-500` nu, parfois une
 * icône, parfois une bouton, jamais la même densité. Conséquence pour une
 * boutique neuve — le cas réel du programme bêta — les premiers écrans se
 * ressemblaient tous sans jamais dire quoi faire.
 *
 * Ne sert que lorsque la liste est réellement vide : un simple « aucune
 * correspondance » pour une recherche reste à part, parce que l'utilisateur a
 * déjà compris ce qu'il cherche.
 */
export function EmptyState({ icon: Icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center',
        className
      )}
    >
      <span
        aria-hidden="true"
        className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100"
      >
        <Icon className="h-5 w-5 text-slate-500" aria-hidden="true" />
      </span>

      <p className="text-sm font-medium text-slate-700">{title}</p>

      {hint != null && (
        <p className="max-w-sm text-xs leading-relaxed text-slate-500">{hint}</p>
      )}

      {action && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={action.onClick}
          className="mt-2 border-slate-200"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
