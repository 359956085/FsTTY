import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { applyTheme, readCachedThemePreference, THEME_STORAGE_KEY } from '../src/shared/theme.ts';

const script = readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
afterEach(() => vi.unstubAllGlobals());
it.each([null, 'invalid', 'system', 'light', 'dark', 'terracotta', 'mint', 'lavender', 'iridescentGlass', 'iceGlass'])(
  'first-paint cache %s agrees with runtime, for either system appearance', (cached) => {
    for (const systemDark of [false, true]) {
      const data = new Map(cached === null ? [] : [[THEME_STORAGE_KEY, cached]]);
      const localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
      const document = { documentElement: { dataset: {}, style: {} } };
      runInNewContext(script, { document, localStorage, matchMedia: () => ({ matches: systemDark }) });
      const initial = structuredClone(document.documentElement);
      vi.stubGlobal('window', { localStorage });
      vi.stubGlobal('document', document);
      applyTheme(readCachedThemePreference(), systemDark);
      expect(document.documentElement).toEqual(initial);
    }
  },
);
