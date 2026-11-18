// Where the model files are saved in the browser. Loaded by the page (<script src>) and by the
// background worker (importScripts), so both read and write the same place.
//
// Transformers.js keeps downloaded files in Cache Storage "transformers-cache"
// (DevTools > Application > Cache storage), keyed by their Hugging Face URL.
// Cache Storage (and WebGPU) only exist on secure origins: https://, localhost, 127.0.0.1.
// On a plain-http address such as http://192.168.1.222 the files go into IndexedDB instead
// (DevTools > Application > IndexedDB > caption-model), through the same match/put interface.

var CACHE = 'transformers-cache';
var IDB_NAME = 'caption-model';
var isFile = self.location.protocol === 'file:';
var useCacheApi = !isFile && self.isSecureContext && 'caches' in self;
var canSave = !isFile && (useCacheApi || 'indexedDB' in self);

// A Cache-like store on IndexedDB: match / put / keys / delete / size / clear, keyed by the file's URL.
function idbStore() {
  let dbp;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
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
    async keys() {
      return (await tx('readonly', (s) => s.getAllKeys())).map((url) => ({ url }));
    },
    async delete(r) { await tx('readwrite', (s) => s.delete(key(r))); return true; },
    async size() {
      const recs = await tx('readonly', (s) => s.getAll()); // Blob handles only, not their bytes
      return recs.reduce((n, rec) => n + rec.blob.size, 0);
    },
    async clear() { await tx('readwrite', (s) => s.clear()); },
  };
}

var store = null;
async function getStore() {
  if (!canSave) return null;
  return (store ??= useCacheApi ? await caches.open(CACHE) : idbStore());
}
