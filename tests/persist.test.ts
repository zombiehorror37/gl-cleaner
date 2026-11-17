import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanLedger } from '../lib/engine/clean';
import { readWorkbook } from '../lib/parse/read';
import { buildSampleXlsx } from './fixtures/sample-ledger';

/** Minimal in-memory localStorage so the store can persist under Node. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('saved decisions and settings', async () => {
  const xlsx = await buildSampleXlsx();
  const storage = memoryStorage();

  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: storage });
    vi.resetModules();
  });

  const fresh = async () => (await import('../lib/store')).useStore;

  it('re-applies approvals after a re-run with different settings, and after a reload', async () => {
    storage.clear();
    let store = await fresh();
    store.getState().loadWorkbook(readWorkbook(xlsx, 'sample.xlsx'));
    store.getState().setValidationOptions({ fillDown: true });
    const run = () => store.getState().setResult(cleanLedger(store.getState().validation!.rows, store.getState().settings));
    run();
    const first = store.getState().result!;
    const pick = first.groups.filter((g) => g.suggested).slice(0, 3);
    store.getState().approve(pick.map((g) => g.id));
    store.getState().dismiss(first.groups.find((g) => !g.suggested)!.id);

    // Change a setting: results are recomputed, decisions come back.
    store.getState().setSettings({ toleranceAmount: 2000 });
    expect(store.getState().approved.size).toBe(0);
    run();
    expect(store.getState().approved.size).toBe(3);
    expect(store.getState().dismissed.size).toBe(1);
    expect(store.getState().restored).toMatchObject({ approved: 3, dismissed: 1, missing: 0 });

    // "Reload": a brand-new store; the same file restores the same decisions and the remembered setting.
    vi.resetModules();
    store = await fresh();
    expect(store.getState().settings.toleranceAmount).toBe(2000);
    store.getState().loadWorkbook(readWorkbook(xlsx, 'renamed copy.xlsx'));
    store.getState().setValidationOptions({ fillDown: true });
    run();
    expect(store.getState().approved.size).toBe(3);

    // Start fresh clears the saved decisions too.
    store.getState().clearDecisions();
    run();
    expect(store.getState().approved.size).toBe(0);
    expect(store.getState().restored).toBeNull();
  });
});
