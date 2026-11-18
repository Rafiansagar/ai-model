// Find anything you name, with Florence-2, in the browser. No server: the photo never leaves the computer.
//
// Use it:
//   import { findAnything } from './florence-find-anything.js';
//   const found = await findAnything(photoUrl, 'lighthouse');
//   // [{ label: 'lighthouse', box: [x1, y1, x2, y2] }, …]   one per match (rarely a polygon instead)
//
// Needs: a page served over http(s) (not opened as a file). The GPU path needs https or localhost.
// The first load downloads the model (about 357 MB on the GPU, 667 MB on the CPU); after that the
// browser loads it from its cache. Source: https://huggingface.co/onnx-community/Florence-2-base-ft

import { Florence2ForConditionalGeneration, AutoProcessor, RawImage }
  from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

// 'onnx-community/Florence-2-large-ft' is more accurate, about three times the download, and slower.
const MODEL = 'onnx-community/Florence-2-base-ft';
let model, processor, loadedOn;

// Load the model once. device: 'webgpu' (fast) or 'wasm' (CPU, works everywhere); picked for you if left out.
export async function load({ device, onProgress } = {}) {
  if (model) return { device: loadedOn };
  const gpu = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  device ??= gpu ? 'webgpu' : 'wasm';
  const half = gpu?.features.has('shader-f16') ? 'fp16' : 'fp32';
  const dtype = device === 'webgpu'
    ? { embed_tokens: half, vision_encoder: half, encoder_model: 'q4', decoder_model_merged: 'q4' }
    : { embed_tokens: 'fp32', vision_encoder: 'fp32', encoder_model: 'q8', decoder_model_merged: 'q8' };
  [model, processor] = await Promise.all([
    Florence2ForConditionalGeneration.from_pretrained(MODEL, { device, dtype, progress_callback: onProgress }),
    AutoProcessor.from_pretrained(MODEL),
  ]);
  loadedOn = device;
  return { device };
}

// A photo can be a URL (including a blob: URL from a file input), a File/Blob, or a RawImage.
async function toImage(image) {
  if (image instanceof RawImage) return image;
  if (image instanceof Blob) return RawImage.fromBlob(image);
  return RawImage.fromURL(String(image));
}

// Ask Florence-2 one task. Returns its raw answer and the decoded photo.
async function ask(task, image, { input = '', maxTokens = 256, onProgress } = {}) {
  await load({ onProgress });
  const img = await toImage(image);
  const inputs = await processor(img, task + input);
  const ids = await model.generate({
    ...inputs,
    max_new_tokens: maxTokens,
    streamer: onProgress && { put: () => onProgress({ status: 'token' }), end() {} },
  });
  return { raw: processor.batch_decode(ids, { skip_special_tokens: false })[0], img };
}

// Turn Florence-2's "label<loc_..><loc_..>…" answer into shapes in photo pixels.
// kind 'boxes':    every 4 numbers are one box -> { label, box: [x1, y1, x2, y2] }. Several things
//                  with the same name come back in a row ("car" + 4 numbers + 4 numbers), so a run
//                  of 8 numbers is two boxes, not one shape. Parts marked <poly> are outlines.
// kind 'polygons': each run is one outline -> { label, polygon: [[x, y], …] }
function shapes(raw, width, height, kind) {
  const out = [];
  let last = '';
  const text = raw.replace(/<\/?s>|<pad>/g, '');
  for (const [, words, locs] of text.matchAll(/([^<]*)((?:<(?:loc_\d+|poly|\/poly|sep)>)+)/g)) {
    const label = words.trim() || last;
    last = label;
    const marked = /<poly>/.test(locs);
    for (const part of locs.split(/<sep>|<poly>|<\/poly>/)) {
      const n = [...part.matchAll(/<loc_(\d+)>/g)]
        .map((m, i) => Math.round((Number(m[1]) + 0.5) / 1000 * (i % 2 ? height : width)));
      if (kind === 'boxes' && !marked) {
        for (let i = 0; i + 3 < n.length; i += 4) out.push({ label, box: n.slice(i, i + 4) });
      } else if (n.length >= 6) {
        const polygon = [];
        for (let i = 0; i + 1 < n.length; i += 2) polygon.push([n[i], n[i + 1]]);
        out.push({ label, polygon });
      }
    }
  }
  return out;
}

// Name a thing; get where it is. Works for things Florence-2 has no fixed label for.
export async function findAnything(image, name, { onProgress } = {}) {
  const { raw, img } = await ask('<OPEN_VOCABULARY_DETECTION>', image, { input: name, maxTokens: 1024, onProgress });
  return shapes(raw, img.width, img.height, 'boxes');
}
