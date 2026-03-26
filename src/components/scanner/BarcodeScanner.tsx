'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BarcodeScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
  errorMessage?: string;
}

export function BarcodeScanner({ onScan, onClose, errorMessage }: BarcodeScannerProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scannerRef = useRef<any>(null);
  const startedRef = useRef(false);
  const containerId = 'qr-reader-container';
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scanner: any = null;

    async function init() {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        scanner = new Html5Qrcode(containerId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText: string) => {
            // On notifie le parent — c'est lui qui décide de fermer ou non
            onScan(decodedText);
          },
          () => { /* scan en cours, ignorer */ }
        );
        startedRef.current = true;
      } catch (err) {
        setCameraError("Impossible d'accéder à la caméra. Vérifiez les permissions.");
        console.error(err);
      }
    }

    init();

    return () => {
      if (scanner && startedRef.current) {
        scanner.stop().catch(() => {}).finally(() => scanner.clear().catch(() => {}));
      } else if (scanner) {
        scanner.clear().catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <Camera className="h-5 w-5 text-indigo-600" />
            Scanner un code-barres
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {cameraError ? (
          <div className="text-red-500 text-sm text-center py-6">{cameraError}</div>
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
