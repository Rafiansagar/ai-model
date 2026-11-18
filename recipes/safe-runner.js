// Run any recipe safely: in a background worker, under a watchdog that stops it if the computer
// can't take the load. Stopping terminates the worker, which ends the work at once and frees its
// memory and GPU. Copy this file and safe-worker.js next to each other.
//
// Use it:
//   import { createSafeRunner, Stopped } from './safe-runner.js';
//   const ai = createSafeRunner(new URL('./florence-caption.js', import.meta.url));
//   await ai.call('load');                              // the recipe's load()
//   const text = await ai.call('caption', photoUrl);    // the recipe's caption(photoUrl)
//   ai.stop();                                          // cancel whatever is running
//
// A call is stopped, and rejects with a Stopped error, when:
//   - it runs longer than timeLimitMs (loads get loadLimitMs);
//   - a load makes no progress for stallMs (a stuck download);
//   - the page's own timer falls more than freezeMs behind (the computer is struggling);
//   - the worker crashes (usually out of memory).
// After a stop the model is gone; the next call starts a fresh worker, so call load() again.

export class Stopped extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'Stopped';
    this.reason = reason; // 'user' | 'slow' | 'stall' | 'freeze' | 'crash'
  }
}

const MESSAGES = {
  user: 'Stopped.',
  slow: (s) => `Stopped: it ran longer than ${s} s.`,
  stall: (s) => `Stopped: the download made no progress for ${s} s.`,
  freeze: 'Stopped: the computer stopped responding while it ran.',
  crash: 'Stopped: the model crashed, most likely out of memory.',
};

export function createSafeRunner(recipeUrl, {
  timeLimitMs = 90_000,        // one task
  loadLimitMs = 20 * 60_000,   // one load (a first download can take a while)
  stallMs = 90_000,            // a load with no progress at all
  freezeMs = 4_000,            // how far behind the page's timer may fall
  onProgress,                  // called with the model's progress events (downloads, tokens)
} = {}) {
  const workerUrl = new URL('./safe-worker.js', import.meta.url);
  const recipe = String(new URL(recipeUrl, location.href));
  let worker = null, job = null, seq = 0;

  function start() {
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (!job || data.id !== job.id) return;
      if (data.type === 'beat') { job.beat = performance.now(); onProgress?.(data.p); return; }
      const j = job;
      job = null;
      if (data.type === 'done') j.resolve(data.result);
      else j.reject(new Error(data.message));
    };
    worker.onerror = (e) => { e.preventDefault(); stop('crash'); };
  }

  function stop(reason = 'user') {
    if (worker) worker.terminate();
    worker = null;
    const j = job;
    job = null;
    if (!j) return;
    const m = MESSAGES[reason];
    const s = Math.round((reason === 'stall' ? stallMs : j.limit) / 1000);
    j.reject(new Stopped(reason, typeof m === 'function' ? m(s) : m));
  }

  // The watchdog: checks twice a second while something runs.
  let last = performance.now(), strikes = 0;
  setInterval(() => {
    const now = performance.now();
    const late = now - last - 500;
    last = now;
    if (!job) { strikes = 0; return; }
    // Hidden tabs get slow timers on purpose; that isn't the computer struggling.
    if (document.visibilityState === 'visible') {
      if (late > freezeMs * 2) return stop('freeze');
      if (late > freezeMs) { if (++strikes >= 2) return stop('freeze'); } else strikes = 0;
    }
    if (job.kind === 'load' && now - job.beat > stallMs) return stop('stall');
    if (now - job.start > job.limit) return stop('slow');
  }, 500);
  document.addEventListener('visibilitychange', () => { last = performance.now(); strikes = 0; });

  // Call one of the recipe's exported functions, e.g. call('caption', photoUrl, { detail: 'short' }).
  function call(fn, ...args) {
    if (job) return Promise.reject(new Error('Busy: wait for the current call, or stop() it.'));
    if (!worker) start();
    const id = ++seq;
    const kind = fn === 'load' ? 'load' : 'run';
    return new Promise((resolve, reject) => {
      const now = performance.now();
      job = { id, kind, resolve, reject, start: now, beat: now, limit: kind === 'load' ? loadLimitMs : timeLimitMs };
      worker.postMessage({ id, recipe, fn, args });
    });
  }

  return {
    call,
    stop: () => stop('user'),
    get busy() { return !!job; },
    setTimeLimit(ms) { timeLimitMs = ms; },
  };
}
