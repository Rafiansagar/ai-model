// Background worker: loads and runs Florence-2 away from the page. The page's watchdog (app.js)
// can terminate this worker at any moment, which stops the work at once and frees its memory and
// GPU, so a task that's too heavy for the computer can be cut instead of freezing it.
//
// In:  { id, type: 'load', repo, device, dtype }   { id, type: 'run', image, prompt, maxTokens }
// Out: { id, type: 'beat', p? }  (progress / one per generated word: proof of life for the watchdog)
//      { id, type: 'done', result }   { id, type: 'error', message }

importScripts('storage.js?v=1');

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
let lib = null, model = null, processor = null;
let photo = { url: null, img: null };

async function library() {
  if (lib) return lib;
  lib = await import(LIB);
  lib.env.allowLocalModels = false;
  if (useCacheApi) {
    lib.env.useBrowserCache = true; // Cache Storage "transformers-cache"
  } else {
    lib.env.useBrowserCache = false;
    if (canSave) { // plain http: same thing, through the IndexedDB store
      lib.env.useCustomCache = true;
      lib.env.customCache = await getStore();
    }
  }
  return lib;
}

async function load({ id, repo, device, dtype }) {
  const L = await library();
  if (model) { try { await model.dispose(); } catch {} model = processor = null; }
  const beat = (p) => postMessage({ id, type: 'beat', p });
  [model, processor] = await Promise.all([
    L.Florence2ForConditionalGeneration.from_pretrained(repo, { device, dtype, progress_callback: beat }),
    L.AutoProcessor.from_pretrained(repo),
  ]);
  return {};
}

async function run({ id, image, prompt, maxTokens }) {
  if (!model) throw new Error('No model is loaded. Load it first.');
  const L = await library();
  if (photo.url !== image) photo = { url: image, img: await L.RawImage.fromURL(image) };
  const inputs = await processor(photo.img, prompt);
  const ids = await model.generate({
    ...inputs,
    max_new_tokens: maxTokens ?? 256,
    streamer: { put() { postMessage({ id, type: 'beat' }); }, end() {} },
  });
  const raw = processor.batch_decode(ids, { skip_special_tokens: false })[0];
  return { raw, width: photo.img.width, height: photo.img.height };
}

const handlers = { load, run };

onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.type](data);
    postMessage({ id: data.id, type: 'done', result });
  } catch (err) {
    postMessage({ id: data.id, type: 'error', message: err?.message ?? String(err) });
  }
};
