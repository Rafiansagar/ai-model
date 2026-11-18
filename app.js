// Plain (non-module) script so the page also works when opened straight from disk (file://),
// where Chrome blocks <script type="module" src>. The library is pulled in with a dynamic import.
(() => {
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
let Florence2ForConditionalGeneration, AutoProcessor, RawImage;

const MODEL = 'onnx-community/Florence-2-base-ft';
const $ = (id) => document.getElementById(id);

let model = null, processor = null;
let imageSrc = null;
let loadedOn = '';
let busy = false, rerun = false;
const progress = {};

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

function setCaption(text, cls = '') {
  const el = $('caption');
  el.textContent = text;
  el.className = 'caption ' + cls;
}

function onProgress(p) {
  if (p.status !== 'progress' || !p.file) return;
  progress[p.file] = p.progress;
  const vals = Object.values(progress);
  $('rail').hidden = false;
  $('railFill').style.width = (vals.reduce((a, b) => a + b, 0) / vals.length) + '%';
  $('files').innerHTML = '';
  for (const [f, v] of Object.entries(progress)) {
    const li = document.createElement('li');
    li.textContent = `${f.split('/').pop()} ${v.toFixed(0)}%`;
    $('files').appendChild(li);
  }
}

// ---------- saved-model check ----------
// Transformers.js keeps downloaded files in the browser's Cache Storage under this name
// (DevTools > Application > Cache storage), keyed by their Hugging Face URL.
// We look there first and only download what's missing.
//
// Cache Storage (and WebGPU) only exist on secure origins: https://, localhost, 127.0.0.1.
// On a plain-http address such as http://192.168.1.222 the files go into IndexedDB instead
// (DevTools > Application > IndexedDB > caption-model), through the same match/put interface.
const CACHE = 'transformers-cache';
const IDB_NAME = 'caption-model';
const OLD_BUCKET = 'florence-2-model'; // briefly used by an earlier version; moved back on open
const PARTS = ['embed_tokens', 'vision_encoder', 'encoder_model', 'decoder_model_merged'];
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' };
const PREFS = 'caption-test:engine:v2'; // v2: WebGPU became the default, so older saved choices are ignored
const isFile = location.protocol === 'file:';
const useCacheApi = !isFile && window.isSecureContext && 'caches' in window;
const canSave = !isFile && (useCacheApi || 'indexedDB' in window);

// A Cache-like store on IndexedDB: match / put / keys / clear, keyed by the file's URL.
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
    async size() {
      const recs = await tx('readonly', (s) => s.getAll()); // Blob handles only, not their bytes
      return recs.reduce((n, rec) => n + rec.blob.size, 0);
    },
    async clear() { await tx('readwrite', (s) => s.clear()); },
  };
}

let store = null;
async function getStore() {
  if (!canSave) return null;
  return (store ??= useCacheApi ? await caches.open(CACHE) : idbStore());
}

// WebGPU support, checked once on page open.
let gpuOk = false, hasF16 = false;
async function probeGPU() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return;
    gpuOk = true;
    hasF16 = adapter.features.has('shader-f16'); // half-precision shaders; most desktop GPUs have it
  } catch {}
}

// Florence-2 is four ONNX files; keep the image side at full/half precision, quantize the text side.
function dtypeFor(device, precision) {
  if (precision === 'fp32') return 'fp32';
  const half = hasF16 ? 'fp16' : 'fp32';
  return device === 'webgpu'
    ? { embed_tokens: half, vision_encoder: half, encoder_model: 'q4', decoder_model_merged: 'q4' }
    : { embed_tokens: 'fp32', vision_encoder: 'fp32', encoder_model: 'q8', decoder_model_merged: 'q8' };
}

function neededFiles(dtype) {
  return PARTS.map((p) => `${MODEL}/resolve/main/onnx/${p}${SUFFIX[typeof dtype === 'string' ? dtype : dtype[p]]}.onnx`);
}

// If an earlier version of this page put the files in a storage bucket, move them back into
// the default Cache Storage once, then delete the bucket.
async function moveBackFromBucket() {
  if (!useCacheApi) return;
  try {
    if (!navigator.storageBuckets || !(await navigator.storageBuckets.keys()).includes(OLD_BUCKET)) return;
    setStatus('Moving the saved model back into Cache storage…');
    const b = await navigator.storageBuckets.open(OLD_BUCKET);
    const from = await b.caches.open(CACHE), to = await caches.open(CACHE);
    for (const req of await from.keys()) {
      if (await to.match(req)) continue;
      const res = await from.match(req);
      if (res) await to.put(req, res);
    }
    await navigator.storageBuckets.delete(OLD_BUCKET);
  } catch (err) { console.error(err); }
}

async function isSaved(device, precision) {
  if (!canSave) return false;
  try {
    const urls = (await (await getStore()).keys()).map((r) => r.url);
    return neededFiles(dtypeFor(device, precision)).every((f) => urls.some((u) => u.endsWith(f)));
  } catch { return false; }
}

async function keepForever() {
  if (!navigator.storage?.persist) return false;
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); }
  catch { return false; }
}

async function showStorage() {
  if (!canSave) { $('storage').textContent = ''; return; }
  let usage = 0, kept = false;
  try {
    if (useCacheApi && navigator.storage?.estimate) {
      usage = (await navigator.storage.estimate()).usage;
      kept = await navigator.storage.persisted();
    } else {
      usage = await (await getStore()).size(); // plain http: no StorageManager, so add up IndexedDB
    }
  } catch { $('storage').textContent = ''; return; }
  const gb = usage / 1e9;
  $('storage').textContent = usage < 1e6 ? 'Nothing saved in this browser yet.'
    : `Saved in this browser: ${gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(usage / 1e6) + ' MB'}. `
      + (kept ? 'Kept permanently.' : 'The browser may clear it if your disk runs low.');
  $('forget').hidden = usage < 1e6;
}

async function refreshButton() {
  if (model) return;
  const saved = await isSaved($('device').value, $('dtype').value);
  $('load').textContent = saved ? 'Load saved model' : 'Download model';
  return saved;
}

function remember() {
  try { localStorage.setItem(PREFS, JSON.stringify({ device: $('device').value, dtype: $('dtype').value })); } catch {}
}

async function loadModel(fromSaved) {
  $('load').disabled = true;
  const device = $('device').value, precision = $('dtype').value;
  setStatus(fromSaved ? 'Loading the saved model from this browser…' : 'Downloading the model. This happens once…');
  for (const k in progress) delete progress[k];
  const t0 = performance.now();
  try {
    const lib = await import(LIB);
    ({ Florence2ForConditionalGeneration, AutoProcessor, RawImage } = lib);
    lib.env.allowLocalModels = false;
    if (useCacheApi) {
      lib.env.useBrowserCache = true; // read from / write to Cache Storage ("transformers-cache")
    } else {
      lib.env.useBrowserCache = false;
      if (canSave) { // plain http: same thing, through the IndexedDB store
        lib.env.useCustomCache = true;
        lib.env.customCache = await getStore();
      }
    }
    [model, processor] = await Promise.all([
      Florence2ForConditionalGeneration.from_pretrained(MODEL, {
        device, dtype: dtypeFor(device, precision), progress_callback: fromSaved ? undefined : onProgress,
      }),
      AutoProcessor.from_pretrained(MODEL),
    ]);
    remember();
    loadedOn = `${$('device').selectedOptions[0].text}, ${precision}`;
    $('rail').hidden = true;
    $('files').innerHTML = '';
    $('load').textContent = 'Model loaded';
    $('device').disabled = $('dtype').disabled = true;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (!canSave) {
      setStatus(`Model ready in ${secs} s. Opened as a file, so it couldn't be saved; open the page through a local server to keep it.`, 'ok');
    } else {
      await keepForever(); // result shows up in the storage line below
      setStatus(`Model ready in ${secs} s, ${fromSaved ? 'loaded from this browser' : 'downloaded and saved in this browser'}.`, 'ok');
    }
    showStorage();
    if (imageSrc) run();
    else setCaption('Add a photo. Its caption appears here.', 'waiting');
  } catch (err) {
    console.error(err);
    model = processor = null;
    if (device === 'webgpu') {
      // GPU path failed (driver, memory, blocked WebGPU): fall back to the CPU once.
      $('device').value = 'wasm';
      setStatus(`The GPU couldn't run the model (${err.message}). Switching to the CPU…`);
      return loadModel(await isSaved('wasm', precision));
    }
    setStatus(`The model didn't load: ${err.message}.`, 'err');
    $('load').disabled = false;
  }
}

$('engine').onsubmit = async (e) => {
  e.preventDefault();
  loadModel(await isSaved($('device').value, $('dtype').value));
};
$('device').onchange = $('dtype').onchange = refreshButton;

$('forget').onclick = async () => {
  if (!confirm('Remove the saved model from this browser? You will need to download it again.')) return;
  try {
    if (useCacheApi) { await caches.delete(CACHE); store = null; }
    else await (await getStore()).clear();
  } catch (err) { console.error(err); }
  model = null; processor = null;
  $('device').disabled = $('dtype').disabled = false;
  $('load').disabled = false;
  await refreshButton();
  setStatus('Saved model removed. Download it again to caption photos.');
  showStorage();
};

// On page open: check first, then load from storage or offer the download.
(async () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || 'null');
    if (p) { $('device').value = p.device; $('dtype').value = p.dtype; }
  } catch {}
  await probeGPU();
  if (!gpuOk) {
    const opt = $('device').querySelector('option[value="webgpu"]');
    opt.disabled = true;
    // WebGPU only exists on https://, localhost and 127.0.0.1.
    opt.textContent = window.isSecureContext ? 'GPU (not available here)' : 'GPU (needs https)';
    $('device').value = 'wasm';
  }
  if (!canSave) {
    setStatus("Opened as a file, so this browser can't save the model. Open the page through a local server to download it once and keep it.");
    return;
  }
  setStatus('Checking this browser for a saved model…');
  await moveBackFromBucket();
  const saved = await refreshButton();
  showStorage();
  if (saved) loadModel(true);
  else if ($('device').value === 'webgpu' && await isSaved('wasm', $('dtype').value)) {
    setStatus("The GPU version of the model isn't saved yet. Download it once for faster captions, or switch Device to CPU to use the saved CPU version.");
  } else setStatus("The model isn't saved in this browser yet. Download it once and it stays here.");
})();

function setImage(src) {
  imageSrc = src;
  const img = new Image();
  img.alt = 'Photo being captioned';
  img.src = src;
  $('mat').replaceChildren(img);
  $('time').textContent = $('ran').textContent = $('size').textContent = '–';
  if (model) run();
  else setCaption('Photo ready. Load the model to caption it.', 'waiting');
}

function readFile(f) {
  if (!f) return;
  // Some formats (HEIC, some WebP/AVIF from phones) report an empty type; let the browser try.
  if (f.type && !f.type.startsWith('image/')) {
    setCaption(`"${f.name}" isn't an image. Choose a JPG, PNG or WebP photo.`, 'error');
    return;
  }
  setImage(URL.createObjectURL(f));
}

const drop = $('drop');
drop.onclick = () => $('file').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); };

$('file').onchange = (e) => {
  readFile(e.target.files[0]);
  e.target.value = ''; // so picking the same file again still fires change
};
$('file').onclick = (e) => e.stopPropagation(); // don't bubble back into the frame's click handler
$('urlForm').onsubmit = (e) => {
  e.preventDefault();
  const u = $('url').value.trim();
  if (u) setImage(u);
};

const task = () => document.querySelector('input[name="task"]:checked').value;
for (const r of document.querySelectorAll('input[name="task"]')) {
  r.onchange = () => { if (model && imageSrc) run(); };
}

async function run() {
  if (!model || !imageSrc) return;
  if (busy) { rerun = true; return; } // a new photo or detail level arrived mid-run; do it next
  busy = true;
  $('run').disabled = true;
  setCaption('Reading the photo…', 'waiting');
  const t0 = performance.now();
  try {
    const t = task();
    const image = await RawImage.fromURL(imageSrc);
    const inputs = await processor(image, processor.construct_prompts(t));
    const ids = await model.generate({ ...inputs, max_new_tokens: 120 });
    const text = processor.batch_decode(ids, { skip_special_tokens: false })[0];
    const out = processor.post_process_generation(text, t, image.size);
    setCaption(String(out[t]).trim(), 'fresh');
    $('time').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    $('ran').textContent = loadedOn;
    $('size').textContent = `${image.width} × ${image.height} px`;
  } catch (err) {
    console.error(err);
    setCaption(`Couldn't read that photo: ${err.message}. If it's a URL, the site may block other pages from loading it; download it and choose the file instead.`, 'error');
  }
  busy = false;
  $('run').disabled = false;
  if (rerun) { rerun = false; run(); }
}
$('run').onclick = run;
})();
