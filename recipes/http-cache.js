// Keep downloaded models on plain-http addresses (like http://192.168.1.222/…), where browsers
// switch off Cache Storage and Transformers.js would download the model on every visit.
// This gives Transformers.js an IndexedDB store instead (DevTools > Application > IndexedDB >
// caption-model). On https and localhost it does nothing: the normal cache already works.
//
// Use it once, before loading any model:
//   import { useIndexedDBCacheOnPlainHttp } from './http-cache.js';
//   await useIndexedDBCacheOnPlainHttp();

import { env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

const DB_NAME = 'caption-model';

export async function useIndexedDBCacheOnPlainHttp() {
  if (self.isSecureContext && 'caches' in self) return false; // Cache Storage works; nothing to do
  if (!('indexedDB' in self)) return false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = indexedDBCache();
  return true;
}

// A Cache-like object (match / put / keys / delete) on IndexedDB, keyed by the file's URL.
export function indexedDBCache() {
  let dbp;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  const key = (r) => (typeof r === 'string' ? r : r.url);
  return {
    async match(r) {
      const rec = await tx('readonly', (s) => s.get(key(r)));
      if (!rec) return undefined;
      return new Response(rec.blob, { headers: {
        'content-type': rec.type || 'application/octet-stream',
        'content-length': String(rec.blob.size),
      } });
    },
    async put(r, res) {
      const blob = await res.blob();
      await tx('readwrite', (s) => s.put({ blob, type: res.headers.get('content-type') }, key(r)));
    },
    async keys() { return (await tx('readonly', (s) => s.getAllKeys())).map((url) => ({ url })); },
    async delete(r) { await tx('readwrite', (s) => s.delete(key(r))); return true; },
  };
}
