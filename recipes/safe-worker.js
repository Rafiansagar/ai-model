// The worker side of safe-runner.js: imports one recipe and calls its exported functions.
// It reports "beats" (download progress, one per generated word) so the watchdog can tell a
// slow task from a stuck one. Keep this file next to safe-runner.js.

import { useIndexedDBCacheOnPlainHttp } from './http-cache.js';

let recipe = null;

self.onmessage = async ({ data: { id, recipe: url, fn, args = [] } }) => {
  const beat = (p) => self.postMessage({ id, type: 'beat', p: p && { status: p.status, file: p.file, progress: p.progress } });
  try {
    if (!recipe) {
      await useIndexedDBCacheOnPlainHttp(); // so plain-http addresses keep the model too
      recipe = await import(url);
    }
    if (typeof recipe[fn] !== 'function') throw new Error(`The recipe has no function called ${fn}.`);
    // Hand the recipe a progress callback: merged into its options object, or added as one.
    const last = args.at(-1);
    const plain = last && typeof last === 'object' && !Array.isArray(last) && !(last instanceof Blob);
    const a = plain ? [...args.slice(0, -1), { ...last, onProgress: beat }] : [...args, { onProgress: beat }];
    const result = await recipe[fn](...a);
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
};
