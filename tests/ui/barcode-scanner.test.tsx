import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Scanner de code-barres (html5-qrcode).
 *
 * On verrouille : la fermeture rend la main, un code scanné est transmis, le
 * MÊME code n'est pas répété en rafale (html5-qrcode notifie ~10 fois/s), et une
 * caméra inaccessible affiche un message au lieu d'un écran noir.
 */

const h = vi.hoisted(() => {
  const state = {
    scanned: null as ((code: string) => void) | null,
    startReject: false,
    stop: vi.fn(async () => {}),
    clear: vi.fn(),
  };
  class Html5Qrcode {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_id: string) { /* id DOM unique */ }
    start(_camera: unknown, _config: unknown, cb: (code: string) => void) {
      state.scanned = cb;
      return state.startReject ? Promise.reject(new Error('camera refusée')) : Promise.resolve();
    }
    stop() { return state.stop(); }
    clear() { return state.clear(); }
  }
  return { state, Html5Qrcode };
});

vi.mock('html5-qrcode', () => ({ Html5Qrcode: h.Html5Qrcode }));

import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';

beforeEach(() => {
  h.state.scanned = null;
  h.state.startReject = false;
  h.state.stop.mockClear();
  h.state.clear.mockClear();
});

describe('BarcodeScanner', () => {
  it('ferme le scanner', async () => {
    const onClose = vi.fn();
    render(<BarcodeScanner onScan={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('transmet un code scanné', async () => {
    const onScan = vi.fn();
    render(<BarcodeScanner onScan={onScan} onClose={() => {}} />);
    await waitFor(() => expect(h.state.scanned).not.toBeNull());

    act(() => { h.state.scanned?.('123456'); });
    expect(onScan).toHaveBeenCalledWith('123456');
  });

  it('ignore la répétition du même code (rafale ~10 fps)', async () => {
    const onScan = vi.fn();
    render(<BarcodeScanner onScan={onScan} onClose={() => {}} />);
    await waitFor(() => expect(h.state.scanned).not.toBeNull());

    act(() => {
      h.state.scanned?.('AAA');
      h.state.scanned?.('AAA');
      h.state.scanned?.('AAA');
    });
    expect(onScan).toHaveBeenCalledTimes(1);

    // Un code DIFFÉRENT n'est pas filtré.
    act(() => { h.state.scanned?.('BBB'); });
    expect(onScan).toHaveBeenCalledTimes(2);
  });

  it('affiche un message si la caméra est inaccessible', async () => {
    h.state.startReject = true;
    render(<BarcodeScanner onScan={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Impossible d'accéder à la caméra/)).toBeInTheDocument());
  });

  it('affiche le message d’erreur du parent', async () => {
    render(<BarcodeScanner onScan={() => {}} onClose={() => {}} errorMessage="Aucun produit pour ce code" />);

    expect(screen.getByText('Aucun produit pour ce code')).toBeInTheDocument();
  });
});
