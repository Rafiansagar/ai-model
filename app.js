// The page: tools, photo, results, and the safety watchdog. The model itself loads and runs in
// worker.js, so a task can be cut off at any moment; storage.js is shared with the worker.
(() => {

// Two sizes of the same model; both know the same 15 tasks. Large is ~3x the download and slower,
// but more accurate. Sizes (MB) per page setting, from the files on Hugging Face:
//   mb      the whole download
//   biggest the largest single file, which the GPU must hold in one piece
const MODELS = {
  base: { id: 'onnx-community/Florence-2-base-ft', name: 'Base',
    mb: { webgpu: 357, wasm: 667, fp32: 1086 }, biggest: { webgpu: 184, wasm: 367, fp32: 388 } },
  large: { id: 'onnx-community/Florence-2-large-ft', name: 'Large',
    mb: { webgpu: 1096, wasm: 2075, fp32: 3295 }, biggest: { webgpu: 727, wasm: 1454, fp32: 1454 } },
};
const $ = (id) => document.getElementById(id);
const which = () => MODELS[$('model').value] || MODELS.base;
const engineKey = () => `${$('model').value}|${$('device').value}|${$('dtype').value}`;
function sizeLabel(m = which(), device = $('device').value, precision = $('dtype').value) {
  const mb = m.mb[precision === 'fp32' ? 'fp32' : device];
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

let loadedKey = null, loading = false; // what the worker has loaded, as "model|device|precision"
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
  if (!p || p.status !== 'progress' || !p.file) return;
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
// Where files are saved, and the store itself, live in storage.js (shared with worker.js).
const OLD_BUCKET = 'florence-2-model'; // briefly used by an earlier version; moved back on open
const PARTS = ['embed_tokens', 'vision_encoder', 'encoder_model', 'decoder_model_merged'];
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' };
// v3: choices saved by a since-dropped version used other model names ("florence2-base"),
// which left the Model menu blank, so older saved choices are ignored.
const PREFS = 'caption-test:engine:v3';

// WebGPU support, checked once on page open.
let gpuOk = false, hasF16 = false, gpuMaxBuffer = 0;
async function probeGPU() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return;
    gpuOk = true;
    hasF16 = adapter.features.has('shader-f16'); // half-precision shaders; most desktop GPUs have it
    gpuMaxBuffer = adapter.limits.maxBufferSize;  // largest single piece the GPU accepts
  } catch {}
}

// ---------- safety: the watchdog ----------
// Every load and every task runs in the background worker. The watchdog terminates the worker,
// which stops the work at once and frees its memory and GPU, when:
//   - a task runs longer than its time limit;
//   - a download or load makes no progress for a while;
//   - the computer stops responding (this page's own timer falls seconds behind);
//   - the worker crashes (usually out of memory).
// Pressing Stop does the same. Change the limits here.
const GUARD = {
  runMs: { gpu: 90_000, cpu: 240_000 }, // one task; doubled for the large model
  loadStallMs: 90_000,                  // download or load with no progress at all
  loadMaxMs: 20 * 60_000,               // one download or load, start to finish
  lateMs: 4_000,                        // the page's timer this late = the computer is struggling
  lateStrikes: 2,                       // ...this many times in a row (or once by twice as much)
};

class Stopped extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

let worker = null, job = null, seq = 0;

function startWorker() {
  try { worker = new Worker('worker.js?v=1'); } catch { worker = null; return; }
  worker.onmessage = ({ data }) => {
    if (!job || data.id !== job.id) return;
    if (data.type === 'beat') { job.beat = performance.now(); job.onBeat?.(data.p); return; }
    const j = job;
    job = null;
    if (data.type === 'done') j.resolve(data.result);
    else j.reject(new Error(data.message));
  };
  worker.onerror = (e) => { e.preventDefault?.(); cut('crash'); };
}

// Send one job to the worker. kind: 'load' or 'run'; what: words for messages.
function call(type, payload, { kind, what, onBeat, limitMs } = {}) {
  if (!worker) startWorker();
  if (!worker) return Promise.reject(new Error('This browser couldn’t start the background worker. Open the page through the web server.'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const now = performance.now();
    job = { id, kind, what, onBeat, limitMs, resolve, reject, start: now, beat: now };
    worker.postMessage({ id, type, ...payload });
  });
}

function explain(reason, j) {
  const what = j?.what ?? 'The task';
  switch (reason) {
    case 'user': return `Stopped. ${what} was cancelled.`;
    case 'slow': return `Stopped: ${what} ran longer than ${Math.round(j.limitMs / 1000)} s, so it was cut to protect the computer. Try the base model, Mixed precision, or a simpler task.`;
    case 'stall': return `Stopped: ${what} made no progress for ${GUARD.loadStallMs / 1000} s. Check the connection and try again; finished files stay saved.`;
    case 'freeze': return `Stopped: the computer stopped responding while ${what.toLowerCase()} ran, so it was cut. Try the base model or Mixed precision, or close other heavy apps.`;
    case 'crash': return `Stopped: the model crashed, most likely out of memory, and was unloaded. Try the base model or Mixed precision.`;
    default: return 'Stopped.';
  }
}

// Cut whatever is running: terminate the worker (the model goes with it) and say why.
function cut(reason) {
  if (worker) worker.terminate();
  worker = null;
  loadedKey = null;
  loading = false;
  const j = job;
  job = null;
  if (j) j.reject(new Stopped(reason, explain(reason, j)));
  else if (reason === 'crash') setStatus(explain('crash'), 'err');
  refreshButton();
}

// The watchdog itself: checks twice a second.
let lastTick = performance.now(), strikes = 0;
setInterval(() => {
  const now = performance.now();
  const late = now - lastTick - 500;
  lastTick = now;
  if (!job) { strikes = 0; return; }
  // Background tabs get their timers slowed on purpose; that isn't the computer struggling.
  if (document.visibilityState === 'visible') {
    if (late > GUARD.lateMs * 2) return cut('freeze');
    if (late > GUARD.lateMs) { if (++strikes >= GUARD.lateStrikes) return cut('freeze'); } else strikes = 0;
  }
  const ran = now - job.start, quiet = now - job.beat;
  if (job.kind === 'load' && quiet > GUARD.loadStallMs) return cut('stall');
  if (job.limitMs && ran > job.limitMs) return cut('slow');
}, 500);
document.addEventListener('visibilitychange', () => { lastTick = performance.now(); strikes = 0; });

function runLimit() {
  const ms = $('device').value === 'wasm' ? GUARD.runMs.cpu : GUARD.runMs.gpu;
  return loadedKey?.startsWith('large') ? ms * 2 : ms;
}

// Before loading: can this computer take it? Returns { block } (won't work), { warn } (might
// struggle; ask first) or {}.
function preflight(m, device, precision) {
  const key = precision === 'fp32' ? 'fp32' : device;
  if (device === 'webgpu' && gpuMaxBuffer && m.biggest[key] * 1e6 > gpuMaxBuffer) {
    return { block: `Your GPU can't hold Florence-2 ${m.name.toLowerCase()}'s largest part (${m.biggest[key]} MB; its limit is ${Math.round(gpuMaxBuffer / 1e6)} MB). Switch Device to CPU, or Model to Base.` };
  }
  const ram = navigator.deviceMemory; // approximate GB; browsers report at most 8
  const needGB = m.mb[key] * 1.5 / 1000;
  if (ram && needGB > ram * 0.6) {
    return { warn: `This computer reports about ${ram} GB of memory, and Florence-2 ${m.name.toLowerCase()} with these settings may use around ${needGB.toFixed(1)} GB. If the computer can't keep up, the task is stopped automatically. Load it anyway?` };
  }
  return {};
}

// Florence-2 is four ONNX files; keep the image side at full/half precision, quantize the text side.
function dtypeFor(device, precision) {
  if (precision === 'fp32') return 'fp32';
  const half = hasF16 ? 'fp16' : 'fp32';
  return device === 'webgpu'
    ? { embed_tokens: half, vision_encoder: half, encoder_model: 'q4', decoder_model_merged: 'q4' }
    : { embed_tokens: 'fp32', vision_encoder: 'fp32', encoder_model: 'q8', decoder_model_merged: 'q8' };
}

function neededFiles(id, dtype) {
  return PARTS.map((p) => `${id}/resolve/main/onnx/${p}${SUFFIX[typeof dtype === 'string' ? dtype : dtype[p]]}.onnx`);
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

// A later, since-dropped version of this page filed the model under its pinned commit
// (".../resolve/<40-hex commit>/...") instead of ".../resolve/main/...". Move those copies back
// under "main" so this version finds them instead of downloading again.
async function moveBackFromPinned() {
  try {
    const s = await getStore();
    if (!s) return;
    const pinned = /^(.*\/onnx-community\/Florence-2-(?:base|large)-ft\/resolve\/)[0-9a-f]{40}(\/.*)$/;
    const reqs = (await s.keys()).filter((r) => pinned.test(r.url));
    if (!reqs.length) return;
    setStatus('Moving the saved model back where this page looks for it (one time)…');
    for (const req of reqs) {
      const [, head, tail] = req.url.match(pinned);
      const main = `${head}main${tail}`;
      if (!(await s.match(main))) {
        const res = await s.match(req.url);
        if (res) await s.put(main, res);
      }
      await s.delete(req.url);
    }
  } catch (err) { console.error(err); }
}

// This page only uses Florence-2. Remove anything else a since-dropped version saved in the same
// store (for example the background remover's files), so it stops counting toward storage.
async function removeOtherModels() {
  try {
    const s = await getStore();
    if (!s) return;
    const ours = /\/onnx-community\/Florence-2-(?:base|large)-ft\//;
    for (const req of await s.keys()) if (!ours.test(req.url)) await s.delete(req.url);
  } catch (err) { console.error(err); }
}

async function isSaved(device, precision, m = which()) {
  if (!canSave) return false;
  try {
    const urls = (await (await getStore()).keys()).map((r) => r.url);
    return neededFiles(m.id, dtypeFor(device, precision)).every((f) => urls.some((u) => u.endsWith(f)));
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

// The button always matches the menus: "Model loaded" when they match what's running,
// otherwise "Load saved model" or "Download model (size)" for the new choice.
async function refreshButton() {
  if (loading) return false;
  if (loadedKey && engineKey() === loadedKey) {
    $('load').textContent = 'Model loaded';
    $('load').disabled = true;
    return true;
  }
  const saved = await isSaved($('device').value, $('dtype').value);
  $('load').textContent = saved ? 'Load saved model' : `Download model (${sizeLabel()})`;
  $('load').disabled = false;
  return saved;
}

function remember() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ model: $('model').value, device: $('device').value, dtype: $('dtype').value }));
  } catch {}
}

async function loadModel(fromSaved, { auto = false } = {}) {
  const m = which(), device = $('device').value, precision = $('dtype').value;
  // Safety check first: refuse what can't work, ask about what might struggle.
  const pf = preflight(m, device, precision);
  if (pf.block) { setStatus(pf.block, 'err'); return; }
  if (pf.warn) {
    if (auto) { setStatus(`${pf.warn.replace(/ Load it anyway\?$/, '')} Press the button to load it.`); return; }
    if (!confirm(pf.warn)) { setStatus('Not loaded. Pick a lighter setting, or press the button again to load anyway.'); return; }
  }
  loading = true;
  $('load').textContent = 'Stop';
  $('load').disabled = false;
  setStatus(fromSaved ? `Loading Florence-2 ${m.name.toLowerCase()} from this browser…`
    : `Downloading Florence-2 ${m.name.toLowerCase()} (${sizeLabel(m, device, precision)}). This happens once…`);
  // Let any task in progress finish first; the worker swaps the old model out itself.
  while (busy) await new Promise((r) => setTimeout(r, 100));
  loadedKey = null;
  for (const k in progress) delete progress[k];
  const t0 = performance.now();
  try {
    await call('load', { repo: m.id, device, dtype: dtypeFor(device, precision) }, {
      kind: 'load', what: fromSaved ? 'Loading the model' : 'Downloading the model',
      onBeat: fromSaved ? null : onProgress, limitMs: GUARD.loadMaxMs,
    });
    remember();
    loadedKey = `${$('model').value}|${device}|${precision}`;
    loadedOn = `${m.name}, ${$('device').selectedOptions[0].text}, ${precision}`;
    loading = false;
    $('rail').hidden = true;
    $('files').innerHTML = '';
    await refreshButton();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (!canSave) {
      setStatus(`Model ready in ${secs} s. Opened as a file, so it couldn't be saved; open the page through a local server to keep it.`, 'ok');
    } else {
      await keepForever(); // result shows up in the storage line below
      setStatus(`Florence-2 ${m.name.toLowerCase()} ready in ${secs} s, ${fromSaved ? 'loaded from this browser' : 'downloaded and saved in this browser'}.`, 'ok');
    }
    showStorage();
    if (imageSrc) run();
    else setCaption('Add a photo to start.', 'waiting');
  } catch (err) {
    console.error(err);
    loadedKey = null;
    loading = false;
    $('rail').hidden = true;
    $('files').innerHTML = '';
    if (err instanceof Stopped) { // the watchdog or Stop cut it; don't retry on our own
      setStatus(err.message, err.reason === 'user' ? '' : 'err');
      await refreshButton();
      return;
    }
    // GPU path failed (driver, out of GPU memory, blocked WebGPU). Fall back to the CPU only when
    // that version is already saved; never start a surprise multi-GB download.
    if (device === 'webgpu' && await isSaved('wasm', precision, m)) {
      $('device').value = 'wasm';
      setStatus(`The GPU couldn't run Florence-2 ${m.name.toLowerCase()} (${err.message}). Switching to the saved CPU version…`);
      return loadModel(true);
    }
    setStatus(device === 'webgpu'
      ? `The GPU couldn't run Florence-2 ${m.name.toLowerCase()}: ${err.message}. Try the base model, or switch Device to CPU (${sizeLabel(m, 'wasm', precision)} download).`
      : `The model didn't load: ${err.message}.`, 'err');
    await refreshButton();
  }
}

$('engine').onsubmit = async (e) => {
  e.preventDefault();
  if (loading) { cut('user'); return; } // the button reads "Stop" while loading
  loadModel(await isSaved($('device').value, $('dtype').value));
};
// Changing a menu doesn't drop the running model; the button offers to load the new choice.
$('model').onchange = $('device').onchange = $('dtype').onchange = refreshButton;

$('forget').onclick = async () => {
  if (!confirm('Remove the saved model from this browser? You will need to download it again.')) return;
  try {
    if (useCacheApi) { await caches.delete(CACHE); store = null; }
    else await (await getStore()).clear();
  } catch (err) { console.error(err); }
  if (worker) { worker.terminate(); worker = null; } // free the memory too
  loadedKey = null;
  await refreshButton();
  setStatus('Saved model removed. Download it again to use the tools.');
  showStorage();
};

// On page open: check first, then load from storage or offer the download.
(async () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || 'null');
    if (p) {
      // Only accept values the menus actually offer, so a menu is never left blank.
      const ok = (sel, v) => [...$(sel).options].some((o) => o.value === v);
      if (ok('model', p.model)) $('model').value = p.model;
      if (ok('device', p.device)) $('device').value = p.device;
      if (ok('dtype', p.dtype)) $('dtype').value = p.dtype;
    }
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
  await moveBackFromPinned();
  await removeOtherModels();
  const saved = await refreshButton();
  showStorage();
  $('guard').textContent = `Safety on: a task stops by itself if it runs over ${GUARD.runMs.gpu / 1000} s on the GPU `
    + `(${GUARD.runMs.cpu / 60000} min on the CPU), stalls, or the computer stops responding. Press Stop to end it yourself.`;
  if (saved) loadModel(true, { auto: true });
  else if ($('device').value === 'webgpu' && await isSaved('wasm', $('dtype').value)) {
    setStatus(`The GPU version isn't saved yet. Download it once (${sizeLabel()}) for faster results, or switch Device to CPU to use the saved CPU version.`);
  } else setStatus(`Florence-2 ${which().name.toLowerCase()} isn't saved in this browser yet. Download it once (${sizeLabel()}) and it stays here.`);
})();


// ---------- the tools ----------
// Every Florence-2 task, grouped by what you give the model besides the photo.
//   kind: how to read the answer. text = words; box = rectangles; quad = 4-corner text boxes;
//         poly = outlines; auto = rectangles or outlines, whichever comes back.
//   ask:  needs typed text.  area: needs an area drawn on the photo.
const TOOLS = [
  { group: 'Describe the photo', items: [
    { id: '<CAPTION>', name: 'Short caption', verb: 'Caption photo', kind: 'text', tokens: 80 },
    { id: '<DETAILED_CAPTION>', name: 'Detailed caption', verb: 'Caption photo', kind: 'text', tokens: 160 },
    { id: '<MORE_DETAILED_CAPTION>', name: 'A paragraph', verb: 'Caption photo', kind: 'text', tokens: 256 },
  ] },
  { group: 'Read text', items: [
    { id: '<OCR>', name: 'All the text', verb: 'Read text', kind: 'text', tokens: 512 },
    { id: '<OCR_WITH_REGION>', name: 'Text, line by line', verb: 'Read text', kind: 'quad', noun: ['line', 'lines'] },
  ] },
  { group: 'Find things', items: [
    { id: '<OD>', name: 'Objects', verb: 'Find objects', kind: 'box', noun: ['object', 'objects'] },
    { id: '<REGION_PROPOSAL>', name: 'Possible regions', verb: 'Find regions', kind: 'box', noun: ['region', 'regions'] },
  ] },
  { group: 'Find what you type', items: [
    { id: '<CAPTION_TO_PHRASE_GROUNDING>', name: 'Phrases in a sentence', verb: 'Find phrases', kind: 'box',
      noun: ['match', 'matches'], ask: 'A sentence about the photo', placeholder: 'A woman sits on a fence next to a dog' },
    { id: '<OPEN_VOCABULARY_DETECTION>', name: 'Anything you name', verb: 'Find it', kind: 'auto',
      noun: ['match', 'matches'], ask: 'What to find', placeholder: 'lighthouse' },
    { id: '<REFERRING_EXPRESSION_SEGMENTATION>', name: 'Outline what you describe', verb: 'Outline it', kind: 'poly',
      noun: ['outline', 'outlines'], ask: 'What to outline', placeholder: 'the dog' },
  ] },
  { group: 'Ask about an area you draw', items: [
    { id: '<REGION_TO_CATEGORY>', name: 'Name it', verb: 'Name the area', kind: 'text', area: true, tokens: 40 },
    { id: '<REGION_TO_DESCRIPTION>', name: 'Describe it', verb: 'Describe the area', kind: 'text', area: true, tokens: 120 },
    { id: '<REGION_TO_OCR>', name: 'Read its text', verb: 'Read the area', kind: 'text', area: true, tokens: 256 },
    { id: '<REGION_TO_SEGMENTATION>', name: 'Outline what’s inside', verb: 'Outline the area', kind: 'poly',
      area: true, noun: ['outline', 'outlines'] },
  ] },
];
const ALL = TOOLS.flatMap((g) => g.items);
const TOOL_PREF = 'caption-test:tool';
const SVGNS = 'http://www.w3.org/2000/svg';

let tool = ALL[0];

let area = null;                    // [x1, y1, x2, y2] in photo pixels
let finds = [];                     // shapes from the last run

// Build the guide rail.
for (const [gi, g] of TOOLS.entries()) {
  const box = document.createElement('div');
  box.className = 'group';
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-labelledby', `g${gi}`);
  const h = document.createElement('h2');
  h.id = `g${gi}`;
  h.textContent = g.group;
  box.appendChild(h);
  for (const t of g.items) {
    const l = document.createElement('label');
    l.className = 'tool';
    l.innerHTML = '<input type="radio" name="tool"><span></span>';
    l.querySelector('input').value = t.id;
    l.querySelector('span').textContent = t.name;
    box.appendChild(l);
  }
  $('guide').appendChild(box);
}

function pickTool(id, { silent = false } = {}) {
  tool = ALL.find((t) => t.id === id) || ALL[0];
  document.querySelector(`input[name="tool"][value="${CSS.escape(tool.id)}"]`).checked = true;
  try { localStorage.setItem(TOOL_PREF, tool.id); } catch {}
  $('toolName').textContent = tool.name;
  $('run').textContent = tool.verb;
  $('ask').hidden = !tool.ask;
  if (tool.ask) {
    $('askLabel').textContent = tool.ask;
    $('askInput').placeholder = tool.placeholder;
  }
  $('hint').hidden = !tool.area;
  $('drop').classList.toggle('drawing', !!tool.area && !!imageSrc);
  if (!tool.area) area = null;
  clearResult();
  if (silent) return;
  if (tool.ask && !$('askInput').value.trim()) {
    setCaption(`Type ${tool.ask.toLowerCase()}, then press Enter.`, 'waiting');
    $('askInput').focus();
  } else if (tool.area && !area) {
    setCaption(imageSrc ? 'Drag on the photo to mark an area.' : 'Add a photo, then drag on it to mark an area.', 'waiting');
  } else run();
}

$('guide').addEventListener('change', (e) => { if (e.target.name === 'tool') pickTool(e.target.value); });
$('ask').onsubmit = (e) => { e.preventDefault(); run(); };

// ---------- photo ----------
function setImage(src) {
  imageSrc = src;

  area = null;
  $('photo').src = src;
  $('stage').hidden = false;
  $('empty').hidden = true;
  $('drop').classList.add('has-photo');
  $('drop').classList.toggle('drawing', !!tool.area);
  $('time').textContent = $('ran').textContent = $('size').textContent = '–';
  clearResult();
  if (!loadedKey) setCaption('Photo ready. Load the model to start.', 'waiting');
  else if (tool.area) setCaption('Drag on the photo to mark an area.', 'waiting');
  else run();
}

$('photo').onload = () => {
  const img = $('photo');
  $('marks').setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
  drawMarks();
};

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
// The empty frame opens the file chooser; once a photo hangs there, clicks belong to the photo.
drop.onclick = () => { if (!imageSrc) $('file').click(); };
drop.onkeydown = (e) => {
  if (!imageSrc && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('file').click(); }
};
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); };

$('file').onchange = (e) => {
  readFile(e.target.files[0]);
  e.target.value = ''; // so picking the same file again still fires change
};
$('file').onclick = (e) => e.stopPropagation();
$('urlForm').onsubmit = (e) => {
  e.preventDefault();
  const u = $('url').value.trim();
  if (u) setImage(u);
};

// ---------- drawing an area ----------
function toPhoto(e) {
  const img = $('photo'), r = img.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
  const y = Math.min(Math.max(e.clientY - r.top, 0), r.height);
  return [x / r.width * img.naturalWidth, y / r.height * img.naturalHeight];
}
let dragFrom = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (!tool.area || !imageSrc) return;
  e.preventDefault();
  $('stage').setPointerCapture(e.pointerId);
  dragFrom = toPhoto(e);
  area = [...dragFrom, ...dragFrom];
  finds = [];
  drawMarks();
});
$('stage').addEventListener('pointermove', (e) => {
  if (!dragFrom) return;
  const [x, y] = toPhoto(e);
  area = [Math.min(dragFrom[0], x), Math.min(dragFrom[1], y), Math.max(dragFrom[0], x), Math.max(dragFrom[1], y)];
  drawMarks();
});
$('stage').addEventListener('pointerup', () => {
  if (!dragFrom) return;
  dragFrom = null;
  const img = $('photo');
  const minSide = Math.min(img.naturalWidth, img.naturalHeight) * 0.02;
  if (area[2] - area[0] < minSide || area[3] - area[1] < minSide) {
    area = null;
    drawMarks();
    setCaption('That area is too small. Drag a bigger box on the photo.', 'waiting');
    return;
  }
  run();
});

// Florence-2 takes an area as four location tokens, each 0–999 across the photo.
function areaTokens(w, h) {
  const q = (v, d) => Math.min(999, Math.max(0, Math.floor(v / d * 1000)));
  const [x1, y1, x2, y2] = area;
  return `<loc_${q(x1, w)}><loc_${q(y1, h)}><loc_${q(x2, w)}><loc_${q(y2, h)}>`;
}

// ---------- reading the answer ----------
const clean = (s) => s.replace(/<\/?s>|<pad>/g, '');

// Turn "label<loc_..>…" runs into shapes in photo pixels. (Transformers.js only parses boxes
// and OCR quads; outline tasks throw "not yet implemented", so every shape is parsed here.)
function parseShapes(raw, kind, w, h) {
  const out = [];
  let last = '';
  for (const m of clean(raw).matchAll(/([^<]*)((?:<(?:loc_\d+|poly|\/poly|sep)>)+)/g)) {
    const label = m[1].trim() || last;
    last = label;
    const polyMarked = /<poly>|<sep>/.test(m[2]);
    for (const part of m[2].split(/<sep>|<poly>|<\/poly>/)) {
      const n = [...part.matchAll(/<loc_(\d+)>/g)].map((x) => (Number(x[1]) + 0.5) / 1000);
      const pts = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i] * w, n[i + 1] * h]);
      // "auto" (find anything you name): unmarked runs of 2 or 4 points are one or two boxes; longer runs are outlines.
      const asBoxes = kind === 'box' || (kind === 'auto' && !polyMarked && (pts.length === 2 || pts.length === 4));
      if (asBoxes) {
        for (let i = 0; i + 1 < pts.length; i += 2) out.push({ label, box: [...pts[i], ...pts[i + 1]] });
      } else if (kind === 'quad') {
        for (let i = 0; i + 3 < pts.length; i += 4) out.push({ label, poly: pts.slice(i, i + 4) });
      } else if (pts.length >= 3) {
        out.push({ label, poly: pts });
      }
    }
  }
  return out;
}

function topLeft(f) {
  if (f.box) return [f.box[0], f.box[1]];
  return [Math.min(...f.poly.map((p) => p[0])), Math.min(...f.poly.map((p) => p[1]))];
}

// ---------- drawing the marks ----------
function shape(f) {
  const g = document.createElementNS(SVGNS, 'g');
  for (const cls of ['under', 'top']) {
    let el;
    if (f.box) {
      el = document.createElementNS(SVGNS, 'rect');
      const [x1, y1, x2, y2] = f.box;
      el.setAttribute('x', x1); el.setAttribute('y', y1);
      el.setAttribute('width', Math.max(1, x2 - x1)); el.setAttribute('height', Math.max(1, y2 - y1));
    } else {
      el = document.createElementNS(SVGNS, 'polygon');
      el.setAttribute('points', f.poly.map((p) => p.join(',')).join(' '));
    }
    el.setAttribute('class', cls);
    g.appendChild(el);
  }
  return g;
}

function drawMarks() {
  const svg = $('marks'), tags = $('tags');
  const img = $('photo');
  svg.replaceChildren();
  tags.replaceChildren();
  if (!img.naturalWidth) return;
  if (area) {
    const g = shape({ box: area });
    g.setAttribute('class', 'mark area');
    svg.appendChild(g);
  }
  finds.forEach((f, i) => {
    const g = shape(f);
    g.setAttribute('class', `mark ${f.box ? 'box' : 'poly'}`);
    g.dataset.i = i;
    svg.appendChild(g);
    // Paper tags name each find, except OCR lines (too many, and the text is listed anyway).
    if (f.label && tool.kind !== 'quad') {
      const [x, y] = topLeft(f);
      const t = document.createElement('span');
      t.className = 'tag';
      t.dataset.i = i;
      t.textContent = f.label;
      t.style.left = `${x / img.naturalWidth * 100}%`;
      t.style.top = `${y / img.naturalHeight * 100}%`;
      if (y / img.naturalHeight < 0.06) t.classList.add('inside');
      tags.appendChild(t);
    }
  });
}

// Light up one or more finds (by index); null clears.
function highlight(idx) {
  const on = idx !== null;
  const set = new Set((on ? [].concat(idx) : []).map(String));
  $('marks').classList.toggle('focus', on);
  $('tags').classList.toggle('focus', on);
  for (const el of document.querySelectorAll('.mark[data-i], .tag')) el.classList.toggle('on', set.has(el.dataset.i));
}

// One row per label ("car  15"), so repeated finds don't fill the list; pointing at a row
// lights every mark with that label. Unlabelled finds (possible regions) keep a row each.
function listFinds() {
  const ul = $('finds');
  ul.replaceChildren();
  ul.hidden = !finds.length;
  const rows = new Map();
  finds.forEach((f, i) => {
    const key = f.label || `\u0000${i}`;
    if (!rows.has(key)) rows.set(key, { label: f.label, idx: [] });
    rows.get(key).idx.push(i);
  });
  let n = 0;
  for (const { label, idx } of rows.values()) {
    n++;
    const li = document.createElement('li');
    li.tabIndex = 0;
    const name = document.createElement('span');
    name.textContent = label || `${tool.noun?.[0] ? tool.noun[0][0].toUpperCase() + tool.noun[0].slice(1) : 'Area'} ${n}`;
    li.appendChild(name);
    if (idx.length > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = idx.length;
      count.setAttribute('aria-label', `${idx.length} found`);
      li.appendChild(count);
    }
    li.onmouseenter = li.onfocus = () => { highlight(idx); li.classList.add('on'); };
    li.onmouseleave = li.onblur = () => { highlight(null); li.classList.remove('on'); };
    ul.appendChild(li);
  }
}

function clearResult() {
  finds = [];
  $('finds').replaceChildren();
  $('finds').hidden = true;
  highlight(null);
  drawMarks();
}

function summary(n) {
  const [one, many] = tool.noun || ['thing', 'things'];
  if (tool.kind === 'poly') {
    if (!n) return tool.area ? "Couldn't outline anything in that area. Try a tighter box." : `Couldn't find “${$('askInput').value.trim()}” to outline. Try other words.`;
    return tool.area ? 'Outlined what’s inside the area.' : `Outlined “${$('askInput').value.trim()}”.`;
  }
  if (!n) return tool.ask ? 'Nothing matched. Try other words.' : 'Nothing found in this photo.';
  return `Found ${n} ${n === 1 ? one : many}.`;
}

// ---------- running a tool ----------
async function run() {
  if (!loadedKey || !imageSrc) return;
  if (tool.ask && !$('askInput').value.trim()) {
    setCaption(`Type ${tool.ask.toLowerCase()}, then press Enter.`, 'waiting');
    $('askInput').focus();
    return;
  }
  if (tool.area && !area) { setCaption('Drag on the photo to mark an area.', 'waiting'); return; }
  if (busy) { rerun = true; return; } // a new photo or tool arrived mid-run; do it next
  busy = true;
  $('run').textContent = 'Stop'; // pressing it cuts the task
  const t = tool;
  finds = [];
  listFinds();
  highlight(null);
  drawMarks();
  setCaption('Looking at the photo…', 'waiting');
  const t0 = performance.now();
  try {
    const photo = $('photo');
    let prompt = t.id;
    if (t.ask) prompt += $('askInput').value.trim();
    if (t.area) prompt += areaTokens(photo.naturalWidth, photo.naturalHeight);
    // Runs in the background worker, under the watchdog's time limit.
    const { raw, width: w, height: h } = await call('run', {
      image: new URL(imageSrc, location.href).href, prompt, maxTokens: t.tokens ?? 1024,
    }, { kind: 'run', what: t.verb.replace(/^\w/, (c) => c.toUpperCase()), limitMs: runLimit() });
    if (t !== tool) return; // tool changed mid-run; the queued run takes over

    if (t.kind === 'text') {
      const text = clean(raw).replace(/<loc_\d+>/g, '').trim() || 'No answer for this one.';
      setCaption(text, 'fresh' + (text.length > 220 ? ' long' : ''));
    } else {
      finds = parseShapes(raw, t.kind, w, h);
      if (t.kind === 'quad') {
        // OCR: show the text itself; the marks show where each line sits.
        setCaption(finds.length ? finds.map((f) => f.label).join('\n') : 'No text found in this photo.',
          'fresh' + (finds.length > 3 ? ' long' : ''));
      } else {
        setCaption(summary(finds.length), 'fresh');
      }
      drawMarks();
      if (t.kind !== 'poly' || finds.length > 1) listFinds();
    }
    $('time').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    $('ran').textContent = loadedOn;
    $('size').textContent = `${w} × ${h} px`;
  } catch (err) {
    console.error(err);
    if (err instanceof Stopped) { setCaption(err.message, err.reason === 'user' ? 'waiting' : 'error'); return; }
    setCaption(`Couldn't read that photo: ${err.message}. If it's a URL, the site may block other pages from loading it; download it and choose the file instead.`, 'error');
  } finally {
    busy = false;
    $('run').textContent = tool.verb;
    if (rerun) { rerun = false; run(); }
  }
}
$('run').onclick = () => (busy ? cut('user') : run());

// Start on the last tool used (short caption the first time).
let startTool = ALL[0].id;
try { startTool = localStorage.getItem(TOOL_PREF) || startTool; } catch {}
pickTool(startTool, { silent: true });
})();
