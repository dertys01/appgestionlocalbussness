'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BarcodeScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
  errorMessage?: string;
}

/** html5-qrcode à 10 fps notifie ~10 fois par seconde le même code. */
const SCAN_DEBOUNCE_MS = 2500;

export function BarcodeScanner({ onScan, onClose, errorMessage }: BarcodeScannerProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scannerRef = useRef<any>(null);
  // Promise de démarrage : permet d'attendre la résolution avant de tenter un
  // stop, sinon on appelle clear() sur un scanner encore en cours d'init et le
  // flux caméra n'est jamais relâché (la caméra reste allumée après fermeture).
  const startPromiseRef = useRef<Promise<void> | null>(null);
  // onScan change à chaque rendu du parent ; le conserver dans une ref évite
  // une closure figée sur la première liste de produits.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // html5-qrcode exige un id DOM unique : deux scanners montés (POS +
  // inventaire) entraient en collision sur 'qr-reader-container'.
  const reactId = useId();
  const containerId = `qr-reader-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const [cameraError, setCameraError] = useState<string | null>(null);
  const lastScanRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scanner: any = null;
    let disposed = false;

    async function init() {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (disposed) return;

        scanner = new Html5Qrcode(containerId);
        scannerRef.current = scanner;

        const start = scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText: string) => {
            // Un même code est redécodé à chaque frame. Sans garde, le parent
            // recevait ~10 setState par seconde (re-render en boucle).
            const now = Date.now();
            const last = lastScanRef.current;
            if (last.value === decodedText && now - last.at < SCAN_DEBOUNCE_MS) return;
            lastScanRef.current = { value: decodedText, at: now };
            onScanRef.current(decodedText);
          },
          () => { /* frame sans code, ignorer */ }
        );

        startPromiseRef.current = start.then(() => { /* démarré */ });

        await start;
        if (disposed) {
          // Démarré après le démontage : on arrête immédiatement.
          await scanner.stop().catch(() => {});
          return;
        }
      } catch (err) {
        if (!disposed) {
          setCameraError("Impossible d'accéder à la caméra. Vérifiez les permissions du navigateur.");
          console.error(err);
        }
      }
    }

    startPromiseRef.current = init();

    return () => {
      disposed = true;
      const pending = startPromiseRef.current;

      if (!scanner) return;

      // On attend la résolution du start() avant de stopper : stopper un
      // scanner en cours d'initialisation laisse le flux caméra ouvert.
      Promise.resolve(pending)
        .catch(() => {})
        .then(() => scanner.stop())
        .catch(() => {})
        .then(() => scanner.clear())
        .catch(() => {});
    };
  }, [containerId]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <Camera className="h-5 w-5 text-indigo-600" />
            Scanner un code-barres
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600" aria-label="Fermer">
            <X className="h-5 w-5" />
          </button>
        </div>

        {cameraError ? (
          <div className="text-red-600 text-sm text-center py-6">{cameraError}</div>
        ) : (
          <div id={containerId} className="rounded-lg overflow-hidden" />
        )}

        {errorMessage && (
          <p className="text-amber-700 text-xs rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            {errorMessage}
          </p>
        )}

        <Button variant="outline" onClick={onClose} className="w-full">
          Annuler
        </Button>
      </div>
    </div>
  );
}
