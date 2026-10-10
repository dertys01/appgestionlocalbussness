import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Téléchargement CSV : le BOM, le nom de fichier, le rattachement au DOM, et
 * surtout la révocation DIFFÉRÉE de l'URL — révoquée trop tôt, elle annule le
 * téléchargement avant que le navigateur ait lu le blob.
 */
import { downloadCSV } from '@/lib/utils/export';

afterEach(() => { vi.restoreAllMocks(); });

describe('downloadCSV', () => {
  it('crée un lien nommé, le clique, puis révoque l’URL de façon différée', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const clique = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCSV('a;b\n1;2', 'export.csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clique).toHaveBeenCalledTimes(1);
    // Pas encore révoquée : le navigateur doit pouvoir lire le blob.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:url');
    // Le lien est retiré du DOM après le clic.
    expect(document.querySelector('a[download="export.csv"]')).toBeNull();

    vi.useRealTimers();
  });
});
