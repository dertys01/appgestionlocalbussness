'use client';

import { useState } from 'react';
import { RotateCcw, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';

interface ItemVente {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
}
interface Vente {
  id: string;
  payment_method: string;
  sale_items: ItemVente[];
}

/**
 * Retour d'une vente comptoir (espèces / MoMo).
 *
 * Le montant rendu et la remise en stock sont calculés par return_sale() en
 * base ; ici on ne saisit que les quantités. Un retour réduit le chiffre
 * d'affaires de la vente (amount_received) — voir migration_returns.sql.
 */
export function ReturnSaleModal({ vente, onClose, onDone }: { vente: Vente; onClose: () => void; onDone: () => void }) {
  const { supabase } = useSupabase();
  const [qtes, setQtes] = useState<Record<string, string>>({});
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  const [resultat, setResultat] = useState<number | null>(null);

  const valider = async () => {
    const items = vente.sale_items
      .map((it) => ({ product_id: it.product_id, quantity: lireMontant(qtes[it.id] ?? '') ?? 0 }))
      .filter((x) => x.quantity > 0);
    if (items.length === 0) { setErreur('Indiquez au moins une quantité à retourner.'); return; }
    for (const it of items) {
      const ligne = vente.sale_items.find((s) => s.product_id === it.product_id);
      if (ligne && it.quantity > Number(ligne.quantity)) {
        setErreur(`Trop pour « ${ligne.product_name} » (vendu : ${ligne.quantity}).`);
        return;
      }
    }

    setEnCours(true);
    setErreur('');
    try {
      const { data, error } = await supabase.rpc('return_sale', {
        p_sale_id: vente.id,
        p_items: items,
        p_note: null,
      });
      if (error) throw new Error(error.message);
      setResultat(Number((data as { amount?: number })?.amount ?? 0));
      onDone();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Retour impossible.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Dialog open onOpenChange={(ouvert) => { if (!ouvert) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-red-600" /> Retourner des articles
          </DialogTitle>
        </DialogHeader>

        {resultat !== null ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-slate-700">
              Retour enregistré. Montant rendu : <strong>{formatCFA(resultat)}</strong>.
            </p>
            <p className="text-xs text-slate-500">
              Le stock a été remis. Le chiffre d&apos;affaires de la vente est réduit d&apos;autant.
            </p>
            <Button onClick={onClose} className="w-full bg-indigo-600 hover:bg-indigo-700">Fermer</Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-xs text-slate-500">
              Indiquez la quantité rendue par article (0 pour ne rien rendre).
            </p>
            {vente.sale_items.map((it) => (
              <div key={it.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-700 truncate">{it.product_name}</span>
                <span className="text-xs text-slate-400 shrink-0">vendu {it.quantity}</span>
                <Input
                  value={qtes[it.id] ?? ''}
                  onChange={(e) => setQtes((q) => ({ ...q, [it.id]: e.target.value }))}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Quantité retournée ${it.product_name}`}
                  className="w-20"
                />
              </div>
            ))}
            {erreur && <p className="text-xs text-red-600">{erreur}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Annuler</Button>
              <Button onClick={valider} disabled={enCours} className="gap-2 bg-red-600 hover:bg-red-700 text-white">
                {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Valider le retour
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
