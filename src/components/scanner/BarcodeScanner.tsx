'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BarcodeScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

export function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scannerRef = useRef<any>(null);
  const containerId = 'qr-reader-container';
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scanner: any = null;
    let started = false;

    async function init() {
      try {
        // Import dynamique pour éviter le SSR
        const { Html5Qrcode } = await import('html5-qrcode');
        scanner = new Html5Qrcode(containerId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },  // caméra arrière
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText: string) => {
            onScan(decodedText);
            scanner?.stop().catch(() => {}).finally(() => scanner?.clear().catch(() => {}));
            onClose();
          },
          () => { /* scan en cours, ignorer */ }
        );
        started = true;
      } catch (err) {
        setError("Impossible d'accéder à la caméra. Vérifiez les permissions.");
        console.error(err);
      }
    }

    init();

    return () => {
      if (scanner && started) {
        scanner.stop().catch(() => {}).finally(() => {
          scanner.clear().catch(() => {});
        });
      } else if (scanner) {
        scanner.clear().catch(() => {});
      }
    };
  }, [onScan, onClose]);

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

        {error ? (
          <div className="text-red-500 text-sm text-center py-6">{error}</div>
        ) : (
          <div id={containerId} className="rounded-lg overflow-hidden" />
        )}

        <Button variant="outline" onClick={onClose} className="w-full">
          Annuler
        </Button>
      </div>
    </div>
  );
}
