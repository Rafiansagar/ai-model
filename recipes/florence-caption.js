// Caption a photo, with Florence-2, in the browser. No server: the photo never leaves the computer.
//
// Use it:
//   import { caption } from './florence-caption.js';
//   const text = await caption(photoUrl);                        // 'A cat walking through the snow.'
//   const more = await caption(photoUrl, { detail: 'paragraph' });
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

const DETAIL = { short: '<CAPTION>', detailed: '<DETAILED_CAPTION>', paragraph: '<MORE_DETAILED_CAPTION>' };

// detail: 'short' (one sentence), 'detailed' (a few), or 'paragraph'.
export async function caption(image, { detail = 'short', onProgress } = {}) {
  const task = DETAIL[detail] ?? DETAIL.short;
  const { raw, img } = await ask(task, image, { maxTokens: 256, onProgress });
  return processor.post_process_generation(raw, task, img.size)[task].trim();
}
