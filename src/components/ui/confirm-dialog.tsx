'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Confirmation d'une action destructive, dans le style de l'application.
 *
 * Il existait trois manières de demander « êtes-vous sûr ? » : `window.confirm`
 * (natif, moche, non stylable, et bloquant), un `Dialog` maison dans la caisse,
 * et des confirmations en ligne dans l'équipe. Un seul composant, désormais :
 * même apparence, mêmes libellés, même comportement clavier.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirmation rouge : l'action détruit ou retire quelque chose. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(ouvert) => { if (!ouvert) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="py-2 text-sm text-slate-600 space-y-2">{message}</div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
          <Button
            onClick={onConfirm}
            className={destructive ? 'bg-red-600 hover:bg-red-700 text-white' : ''}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
