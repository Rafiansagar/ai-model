// Builds every page of the recipe book from kit/pages.js: the menu, recipe pages (demo, result,
// code, notes) and the start-here guides. Demos run the recipe files themselves, through
// recipes/safe-runner.js, so what you copy is exactly what just ran.

import { MENU, PAGES, SAMPLES, pageOrder, RECIPE_VERSION } from './pages.js';

const v = (url) => `${url}?v=${RECIPE_VERSION}`;
import { createSafeRunner, Stopped } from '../recipes/safe-runner.js';

const slug = document.body.dataset.page;
const page = PAGES[slug];
const SVGNS = 'http://www.w3.org/2000/svg';

// ---------- tiny element helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const p = (html) => h('p', { html });

// ---------- shell: menu + content ----------
function shell() {
  const filter = h('input', { type: 'search', placeholder: 'Filter recipes', 'aria-label': 'Filter recipes', class: 'menu-filter' });
  const nav = h('nav', { 'aria-label': 'Recipes' });
  for (const g of MENU) {
    const list = h('ul');
    for (const s of g.pages) {
      const pg = PAGES[s];
      list.append(h('li', {}, h('a', { href: pg.file, 'aria-current': s === slug ? 'page' : null }, pg.menu)));
    }
    nav.append(h('div', { class: 'menu-group' }, h('h2', {}, g.group), list));
  }
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const grp of nav.querySelectorAll('.menu-group')) {
      let any = false;
      for (const li of grp.querySelectorAll('li')) {
        const show = !q || li.textContent.toLowerCase().includes(q) || grp.querySelector('h2').textContent.toLowerCase().includes(q);
        li.hidden = !show;
        any ||= show;
      }
      grp.hidden = !any;
    }
  };
  const toggle = h('button', { type: 'button', class: 'menu-toggle', 'aria-expanded': 'false' }, 'Menu');
  const menu = h('aside', { class: 'menu', id: 'menu' },
    h('a', { class: 'menu-home', href: './' }, 'Local AI recipes'), filter, nav);
  toggle.onclick = () => {
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  };
  const main = h('main', { class: 'doc', id: 'doc' });
  document.body.append(h('div', { class: 'shell' }, toggle, menu, main));
  return main;
}

function prevNext() {
  const i = pageOrder.indexOf(slug);
  const prev = PAGES[pageOrder[i - 1]], next = PAGES[pageOrder[i + 1]];
  return h('nav', { class: 'prevnext', 'aria-label': 'Next and previous' },
    prev ? h('a', { href: prev.file, class: 'prev' }, h('span', {}, 'Previous'), prev.menu) : h('span'),
    next ? h('a', { href: next.file, class: 'next' }, h('span', {}, 'Next'), next.menu) : h('span'));
}

// ---------- code sheet: tabs, copy, download ----------
function copyText(text) {
  if (navigator.clipboard && self.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

// tabs: [{ name, file, note?, text: string | () => Promise<string> }]
function codeSheet(tabs) {
  const bar = h('div', { class: 'sheet-tabs', role: 'tablist' });
  const code = h('code');
  const pre = h('pre', { class: 'code', tabindex: '0' }, code);
  const fileName = h('span', { class: 'sheet-file' });
  const note = h('p', { class: 'sheet-note' });
  const copy = h('button', { type: 'button', class: 'ink' }, 'Copy');
  const save = h('button', { type: 'button', class: 'ink-quiet' }, 'Download');
  let cur = null;
  async function show(i) {
    cur = tabs[i];
    [...bar.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    fileName.textContent = cur.file;
    note.textContent = cur.note ?? '';
    note.hidden = !cur.note;
    if (cur.cached == null) {
      code.textContent = 'Loading…';
      try { cur.cached = typeof cur.text === 'function' ? await cur.text() : cur.text; }
      catch (e) { cur.cached = `// Couldn't load this file: ${e.message}`; }
    }
    if (cur === tabs[i]) code.textContent = cur.cached;
  }
  tabs.forEach((t, i) => bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(i) }, t.name)));
  copy.onclick = async () => {
    await copyText(cur.cached ?? '');
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  };
  save.onclick = () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([cur.cached ?? ''], { type: 'text/plain' })), download: cur.file });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  show(0);
  return h('section', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, bar, h('div', { class: 'sheet-actions' }, fileName, copy, save)),
    note, pre);
}

const fetchText = (url) => async () => {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
};
const fileOf = (url) => url.split('/').pop();

// JS-looking literal for options, e.g. { detail: 'short' }
function lit(v) {
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`;
  return String(v);
}

function callText(f, photo = 'photo') {
  const args = [photo];
  if (f.input) args.push(lit(f.input.value));
  if (f.area) args.push('box');
  if (f.opts) args.push(lit(f.opts));
  return `${f.fn}(${args.join(', ')})`;
}

// A complete, working .html page around a recipe: open it from a web server and it runs.
function completePage(pg, f, src) {
  const input = f.input ? `\n  <input id="text" size="44" value="${f.input.value.replace(/"/g, '&quot;')}" aria-label="${f.input.label}">` : '';
  const needsBox = f.area
    ? `\n  // The area to ask about: here the middle of the photo. In your app, take it from a drag or from Find objects.\n  const bmp = await createImageBitmap(file);\n  const box = [bmp.width * 0.25, bmp.height * 0.25, bmp.width * 0.75, bmp.height * 0.75].map(Math.round);`
    : '';
  const call = callText(f, 'file').replace(lit(f.input?.value ?? '\u0000'), "$('text').value");
  const draws = f.shows !== 'text';
  const drawCode = draws ? `

// Draw the boxes / outlines on top of the photo.
function draw(photo, result) {
  const c = $('canvas'), g = c.getContext('2d');
  c.width = photo.naturalWidth; c.height = photo.naturalHeight;
  g.drawImage(photo, 0, 0);
  g.lineWidth = Math.max(2, c.width / 300); g.strokeStyle = '#d3a961'; g.fillStyle = 'rgba(211,169,97,.3)';
  g.font = \`\${Math.max(12, c.width / 60)}px sans-serif\`;
  for (const r of result) {
    const pts = r.box ? [[r.box[0], r.box[1]], [r.box[2], r.box[1]], [r.box[2], r.box[3]], [r.box[0], r.box[3]]]
      : r.polygon ?? (r.quad && [0, 2, 4, 6].map((i) => [r.quad[i], r.quad[i + 1]]));
    if (!pts) continue;
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    if (r.polygon) g.fill();
    g.stroke();
    const label = r.label ?? r.text;
    if (label) { g.fillStyle = '#d3a961'; g.fillText(label, pts[0][0] + 4, pts[0][1] - 6); g.fillStyle = 'rgba(211,169,97,.3)'; }
  }
}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pg.title}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
  img, canvas { max-width: 100%; display: block; margin: 12px 0; }
  pre { white-space: pre-wrap; background: #f3f3ef; padding: 12px; }
</style>
</head>
<body>
<h1>${pg.title}</h1>
<p>
  <input type="file" id="file" accept="image/*" aria-label="Photo">${input}
  <button id="go">${f.name}</button>
</p>
<p id="status">Choose a photo. The first run downloads the model (${pg.model.download}).</p>
<img id="photo" alt="">${draws ? '\n<canvas id="canvas"></canvas>' : ''}
<pre id="out"></pre>

<script type="module">
${src.trim()}

// ---------- the page ----------
const $ = (id) => document.getElementById(id);
$('go').onclick = async () => {
  const file = $('file').files[0];
  if (!file) { $('status').textContent = 'Choose a photo first.'; return; }
  $('photo').src = URL.createObjectURL(file);${needsBox}
  $('status').textContent = 'Working…';
  try {
    const result = await ${call};
    $('out').textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);${draws ? "\n    await $('photo').decode();\n    draw($('photo'), result);\n    $('photo').hidden = true;" : ''}
    $('status').textContent = 'Done.';
  } catch (err) {
    $('status').textContent = 'Failed: ' + err.message;
  }
};${drawCode}
</script>
</body>
</html>
`;
}

function safeSnippet(pg, f) {
  const file = fileOf(pg.recipe);
  return `import { createSafeRunner, Stopped } from './safe-runner.js';

// Runs ${file} in a background worker. If a call takes too long, freezes the
// computer or crashes, the worker is terminated and the call rejects with Stopped.
const ai = createSafeRunner(new URL('./${file}', import.meta.url), { timeLimitMs: 90_000 });

await ai.call('load');${f.area ? '\nconst box = [120, 80, 460, 390]; // the area, in photo pixels' : ''}
try {
  const result = await ai.call(${[`'${f.fn}'`, 'photoUrl', ...(f.input ? [lit(f.input.value)] : []), ...(f.area ? ['box'] : []), ...(f.opts ? [lit(f.opts)] : [])].join(', ')});
  console.log(result);
} catch (err) {
  if (err instanceof Stopped) console.warn(err.message); // too slow, froze, crashed, or ai.stop()
  else throw err;
}
`;
}

// ---------- the demo bench (recipe pages) ----------
function bench(pg) {
  let f = pg.fns[0];
  let photoUrl = null, area = null, finds = [], busy = false, loaded = false;
  const progress = {};

  const modelLine = h('p', { class: 'model-line' }, `Not loaded yet. The first run downloads ${pg.model.name} (${pg.model.download}).`);
  const runner = createSafeRunner(v(pg.recipe), {
    onProgress: (e) => {
      if (!e || e.status !== 'progress' || !e.file) return;
      progress[e.file] = e.progress;
      const v = Object.values(progress);
      modelLine.textContent = `Downloading ${pg.model.name}: ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}%`;
    },
  });

  // photo + marks
  const img = h('img', { alt: 'Photo for the demo', crossorigin: 'anonymous' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'marks');
  svg.setAttribute('preserveAspectRatio', 'none');
  const tags = h('div', { class: 'tags', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'stage' }, img, svg, tags);
  const frame = h('figure', { class: 'frame' }, h('div', { class: 'mat' }, stage));

  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const url = h('input', { type: 'url', placeholder: 'Or paste an image URL', 'aria-label': 'Image URL' });
  const sources = h('div', { class: 'source' },
    h('button', { type: 'button', class: 'quiet', onclick: () => file.click() }, 'Choose photo'),
    h('button', { type: 'button', class: 'quiet', onclick: () => setPhoto(pg.sample) }, 'Use the sample'),
    h('form', { class: 'url', onsubmit: (e) => { e.preventDefault(); if (url.value.trim()) setPhoto(url.value.trim()); } },
      url, h('button', { type: 'submit', class: 'quiet' }, 'Use URL')));
  file.onchange = () => { if (file.files[0]) setPhoto(URL.createObjectURL(file.files[0])); file.value = ''; };
  frame.ondragover = (e) => e.preventDefault();
  frame.ondrop = (e) => { e.preventDefault(); const fl = e.dataTransfer.files[0]; if (fl) setPhoto(URL.createObjectURL(fl)); };

  // the label card
  const choice = h('div', { class: 'choice', role: 'radiogroup', 'aria-label': 'Function' });
  pg.fns.forEach((fn, i) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(i === 0) }, fn.name);
    b.onclick = () => { f = fn; [...choice.children].forEach((x) => x.setAttribute('aria-checked', String(x === b))); setup(); };
    choice.append(b);
  });
  const inputLabel = h('label', { class: 'field' });
  const input = h('input', { type: 'text', autocomplete: 'off' });
  inputLabel.append(h('span'), input);
  const hint = h('p', { class: 'hint' }, 'Drag on the photo to mark the area.');
  const callLine = h('p', { class: 'call' });
  const result = h('p', { class: 'result waiting' }, 'Pick a photo, then run.');
  const list = h('ul', { class: 'finds', hidden: true });
  const facts = h('dl', { class: 'facts' });
  const runBtn = h('button', { type: 'button', class: 'run' }, 'Run');
  const card = h('aside', { class: 'label', 'aria-label': 'Result' },
    pg.fns.length > 1 ? choice : null, inputLabel, hint, callLine, result, list, facts, runBtn, modelLine);
  const json = h('pre', { class: 'json' }, 'Run the demo to see the result here.');

  function setup() {
    inputLabel.hidden = !f.input;
    if (f.input) { inputLabel.firstChild.textContent = f.input.label; if (!input.value) input.value = f.input.value; }
    hint.hidden = !f.area;
    frame.classList.toggle('drawing', !!f.area);
    if (!f.area) area = null;
    callLine.textContent = `${callText(f).replace(lit(f.input?.value ?? '\u0000'), lit(input.value || f.input?.value || ''))}`;
    runBtn.textContent = f.name === 'Run' ? 'Run' : `Run: ${f.name}`;
    clear();
  }
  input.oninput = () => { callLine.textContent = callText(f).replace(lit(f.input.value), lit(input.value)); };
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };

  function setPhoto(src) {
    photoUrl = src;
    img.src = src;
    area = null;
    clear();
    result.textContent = f.area ? 'Drag on the photo to mark an area, then run.' : 'Ready. Press Run.';
    result.className = 'result waiting';
  }
  img.onload = () => { svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`); draw(); };
  img.onerror = () => { result.textContent = 'That photo didn’t load. The site may block other pages from using it; download it and choose the file instead.'; result.className = 'result error'; };

  // drawing an area
  const toPhoto = (e) => {
    const r = img.getBoundingClientRect();
    return [Math.min(Math.max(e.clientX - r.left, 0), r.width) / r.width * img.naturalWidth,
      Math.min(Math.max(e.clientY - r.top, 0), r.height) / r.height * img.naturalHeight];
  };
  let from = null;
  stage.onpointerdown = (e) => {
    if (!f.area || !photoUrl) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    from = toPhoto(e);
    area = [...from, ...from];
    finds = [];
    draw();
  };
  stage.onpointermove = (e) => {
    if (!from) return;
    const [x, y] = toPhoto(e);
    area = [Math.min(from[0], x), Math.min(from[1], y), Math.max(from[0], x), Math.max(from[1], y)];
    draw();
  };
  stage.onpointerup = () => {
    if (!from) return;
    from = null;
    if (area[2] - area[0] < 8 || area[3] - area[1] < 8) { area = null; draw(); return; }
    callLine.textContent = callText(f).replace('box', lit(area.map(Math.round)));
    result.textContent = 'Area marked. Press Run.';
  };

  function points(r) {
    if (r.box) return [[r.box[0], r.box[1]], [r.box[2], r.box[1]], [r.box[2], r.box[3]], [r.box[0], r.box[3]]];
    if (r.polygon) return r.polygon;
    if (r.quad) return [0, 2, 4, 6].map((i) => [r.quad[i], r.quad[i + 1]]);
    return null;
  }
  function mark(pts, cls, i) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', cls);
    if (i != null) g.dataset.i = i;
    for (const c of ['under', 'top']) {
      const el = document.createElementNS(SVGNS, 'polygon');
      el.setAttribute('points', pts.map((q) => q.join(',')).join(' '));
      el.setAttribute('class', c);
      g.append(el);
    }
    svg.append(g);
  }
  function draw() {
    svg.replaceChildren();
    tags.replaceChildren();
    if (!img.naturalWidth) return;
    if (area) mark(points({ box: area }), 'mark area');
    finds.forEach((r, i) => {
      const pts = points(r);
      if (!pts) return;
      mark(pts, `mark${r.polygon ? ' poly' : ''}`, i);
      const label = f.shows === 'lines' ? null : r.label;
      if (label) {
        const x = Math.min(...pts.map((q) => q[0])), y = Math.min(...pts.map((q) => q[1]));
        tags.append(h('span', { class: `tag${y / img.naturalHeight < 0.06 ? ' inside' : ''}`, 'data-i': i,
          style: `left:${x / img.naturalWidth * 100}%;top:${y / img.naturalHeight * 100}%` }, label));
      }
    });
  }
  function highlight(idx) {
    const set = new Set((idx ?? []).map(String));
    svg.classList.toggle('focus', !!idx);
    tags.classList.toggle('focus', !!idx);
    for (const el of [...svg.querySelectorAll('[data-i]'), ...tags.children]) el.classList.toggle('on', set.has(el.dataset.i));
  }
  function listFinds() {
    list.replaceChildren();
    const rows = new Map();
    finds.forEach((r, i) => {
      const key = (f.shows === 'lines' ? r.text : r.label) || `\u0000${i}`;
      if (!rows.has(key)) rows.set(key, { name: f.shows === 'lines' ? r.text : r.label, idx: [] });
      rows.get(key).idx.push(i);
    });
    let n = 0;
    for (const { name, idx } of rows.values()) {
      n++;
      const li = h('li', { tabindex: '0' }, h('span', {}, name || `Region ${n}`), idx.length > 1 ? h('span', { class: 'count' }, String(idx.length)) : null);
      li.onmouseenter = li.onfocus = () => highlight(idx);
      li.onmouseleave = li.onblur = () => highlight(null);
      list.append(li);
    }
    list.hidden = !finds.length;
  }
  function clear() {
    finds = [];
    list.hidden = true;
    highlight(null);
    draw();
  }

  async function go() {
    if (busy) { runner.stop(); return; }
    if (!photoUrl) { result.textContent = 'Pick a photo first: choose one, or use the sample.'; result.className = 'result waiting'; return; }
    if (f.input && !input.value.trim()) { input.focus(); return; }
    if (f.area && !area) { result.textContent = 'Drag on the photo to mark the area first.'; result.className = 'result waiting'; return; }
    busy = true;
    runBtn.textContent = 'Stop';
    clear();
    const t0 = performance.now();
    try {
      if (!loaded) {
        result.textContent = 'Loading the model…';
        result.className = 'result waiting';
        const { device } = await runner.call('load');
        loaded = true;
        modelLine.textContent = `${pg.model.name} is loaded, on the ${device === 'webgpu' ? 'GPU' : 'CPU'}.`;
      }
      result.textContent = 'Working…';
      const args = [new URL(photoUrl, location.href).href];
      if (f.input) args.push(input.value.trim());
      if (f.area) args.push(area.map(Math.round));
      if (f.opts) args.push(f.opts);
      const t1 = performance.now();
      const out = await runner.call(f.fn, ...args);
      const secs = ((performance.now() - t1) / 1000).toFixed(1);
      if (f.shows === 'text') {
        result.textContent = out || 'No answer for this one.';
      } else {
        finds = out;
        draw();
        listFinds();
        result.textContent = f.shows === 'lines'
          ? (out.length ? `Read ${out.length} line${out.length === 1 ? '' : 's'}.` : 'No text found.')
          : (out.length ? `Found ${out.length}.` : 'Nothing found.');
      }
      result.className = 'result fresh';
      const json = JSON.stringify(out, null, 2);
      jsonBox.textContent = json.length > 6000 ? `${json.slice(0, 6000)}\n… (${json.length - 6000} more characters)` : json;
      facts.replaceChildren(h('dt', {}, 'Time'), h('dd', {}, `${secs} s${t1 - t0 > 500 ? ` (+ ${((t1 - t0) / 1000).toFixed(1)} s loading)` : ''}`),
        h('dt', {}, 'Photo'), h('dd', {}, `${img.naturalWidth} × ${img.naturalHeight} px`));
    } catch (err) {
      console.error(err);
      if (err instanceof Stopped) {
        loaded = false;
        modelLine.textContent = 'The model was unloaded by the stop. The next run loads it again.';
      }
      result.textContent = err instanceof Stopped ? err.message : `Failed: ${err.message}`;
      result.className = 'result error';
    } finally {
      busy = false;
      runBtn.textContent = `Run: ${f.name}`;
    }
  }
  runBtn.onclick = go;
  const jsonBox = json;

  setup();
  setPhoto(pg.sample);
  return { el: h('div', { class: 'bench' }, h('div', { class: 'wall' }, frame, sources, file), card), json };
}

// ---------- recipe page ----------
function recipePage(main) {
  const pg = page;
  main.append(
    h('header', { class: 'doc-head' },
      h('h1', {}, pg.title),
      h('p', { class: 'lead' }, pg.intro),
      h('dl', { class: 'meta' },
        h('div', {}, h('dt', {}, 'Model'), h('dd', {}, h('a', { href: pg.model.url, target: '_blank', rel: 'noopener' }, pg.model.name))),
        h('div', {}, h('dt', {}, 'Download'), h('dd', {}, pg.model.download)),
        h('div', {}, h('dt', {}, 'Licence'), h('dd', {}, pg.model.licence)),
        h('div', {}, h('dt', {}, 'Recipe file'), h('dd', {}, h('a', { href: pg.recipe }, fileOf(pg.recipe)))))),
  );
  const b = bench(pg);
  main.append(h('section', { 'aria-labelledby': 'try' }, h('h2', { id: 'try' }, 'Try it'), b.el));
  main.append(h('section', { 'aria-labelledby': 'back' }, h('h2', { id: 'back' }, 'What comes back'),
    p('Exactly what the function returns for the run above. Positions are in pixels of the original photo.'), b.json));

  const src = fetchText(v(pg.recipe));
  let srcText;
  const recipeText = async () => (srcText ??= await src());
  const f0 = pg.fns[0];
  main.append(h('section', { 'aria-labelledby': 'code' }, h('h2', { id: 'code' }, 'The code'),
    p(`Functions: ${[...new Set(pg.fns.map((f) => f.fn))].map((n) => `<code>${n}()</code>`).join(', ')}. The usage is at the top of the module.`),
    codeSheet([
      { name: 'Module', file: fileOf(pg.recipe), text: recipeText, note: 'One file. Put it in your project and import it.' },
      { name: 'Complete page', file: `${slug}.html`, text: async () => completePage(pg, f0, await recipeText()),
        note: 'A whole working page with the module inside. Open it from a web server (not by double-clicking).' },
      { name: 'Run it safely', file: `${slug}-safe.js`, text: safeSnippet(pg, f0),
        note: 'Needs safe-runner.js, safe-worker.js and http-cache.js (from Run it safely) next to the module.' },
    ])));
  main.append(h('section', { 'aria-labelledby': 'notes' }, h('h2', { id: 'notes' }, 'Notes'),
    h('ul', { class: 'notes' }, pg.notes.map((n) => h('li', {}, n)))));
}

// ---------- start-here pages ----------
const STARTS = {
  index(main) {
    main.append(h('header', { class: 'doc-head' },
      h('h1', {}, 'Local AI recipes'),
      h('p', { class: 'lead' }, 'Working code for AI that runs inside the browser, on this computer: no server, no API key, nothing sent anywhere. Each page does one job. Try it on a photo, then copy the code into a real project.')));
    main.append(h('section', {}, h('h2', {}, 'How a recipe page works'), h('dl', { class: 'terms' },
      h('dt', {}, 'Try it'), h('dd', {}, 'Run the recipe on the sample photo or your own. The demo runs the same file you copy.'),
      h('dt', {}, 'What comes back'), h('dd', {}, 'The exact result your code gets, so you know its shape before you write anything.'),
      h('dt', {}, 'The code'), h('dd', { html: '<b>Module</b>: one file to import. <b>Complete page</b>: a working .html file. <b>Run it safely</b>: the same module in a background worker that is stopped if the computer can’t keep up.' }),
      h('dt', {}, 'Notes'), h('dd', {}, 'Limits and tips found while building it.'))));
    main.append(h('section', {}, h('h2', {}, 'What you need'), h('ul', { class: 'notes' },
      h('li', {}, 'Open pages through a web server (like this one), not by double-clicking the file.'),
      h('li', { html: 'The GPU, and keeping the model between visits, need <b>https</b> or <b>localhost</b>. On a plain http address, add <a href="load.html">http-cache.js</a> to keep the model; it runs on the CPU there.' }),
      h('li', {}, 'The first run downloads the model. After that the browser loads it from its own storage in a few seconds.'))));
    const rows = MENU.filter((g) => !['Start here', 'Everything at once'].includes(g.group));
    main.append(h('section', {}, h('h2', {}, 'Recipes'), h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Recipe'), h('th', {}, 'What it does'))),
      h('tbody', {}, rows.flatMap((g) => g.pages.map((s) => h('tr', {},
        h('td', {}, h('a', { href: PAGES[s].file }, PAGES[s].title)), h('td', {}, PAGES[s].intro))))))));
    main.append(h('section', {}, h('h2', {}, 'Models used'), h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Used for'), h('th', {}, 'Download'), h('th', {}, 'Licence'))),
      h('tbody', {}, h('tr', {}, h('td', {}, h('a', { href: 'https://huggingface.co/onnx-community/Florence-2-base-ft', target: '_blank', rel: 'noopener' }, 'Florence-2 base')),
        h('td', {}, 'Captions, reading text, finding and outlining things'), h('td', {}, '357 MB GPU, 667 MB CPU'), h('td', {}, 'MIT'))))));
  },

  load(main) {
    main.append(h('header', { class: 'doc-head' },
      h('h1', {}, 'Load a model and keep it'),
      h('p', { class: 'lead', html: 'Every recipe has a <code>load()</code> function. Call it once. The first time it downloads the model; after that the browser loads it from its own storage in a few seconds. The recipes call it for you if you forget.' })));
    // Live check of this browser
    const rows = h('tbody');
    const row = (k, v) => rows.append(h('tr', {}, h('th', { scope: 'row' }, k), h('td', { html: v })));
    const loadBtn = h('button', { type: 'button', class: 'run' }, 'Load Florence-2 base now');
    const out = h('p', { class: 'model-line' });
    async function check() {
      rows.replaceChildren();
      const secure = self.isSecureContext;
      row('This address', secure ? 'Secure (https or localhost): the GPU and the browser’s model cache both work.'
        : 'Plain http: no GPU, and no Cache storage. Use <code>http-cache.js</code> to keep models in IndexedDB.');
      const gpu = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
      row('GPU (WebGPU)', gpu ? `Available${gpu.features.has('shader-f16') ? ', with half precision' : ', without half precision (uses full precision)'}.` : 'Not available here; recipes use the CPU.');
      row('Memory', navigator.deviceMemory ? `The browser reports about ${navigator.deviceMemory} GB (it never reports more than 8 or 16).` : 'Not reported by this browser.');
      let files = [];
      try {
        if (secure && 'caches' in self) {
          const c = await caches.open('transformers-cache');
          for (const r of await c.keys()) {
            const res = await c.match(r);
            files.push([r.url, Number(res.headers.get('content-length')) || 0]);
          }
        }
      } catch {}
      const mb = files.reduce((n, [, b]) => n + b, 0) / 1e6;
      const models = [...new Set(files.map(([u]) => u.split('/').slice(3, 5).join('/')))];
      row('Saved models', files.length ? `${models.join(', ')}: ${files.length} files, ${Math.round(mb)} MB, in Cache storage “transformers-cache”.` : 'None saved in this browser yet.');
    }
    const runner = createSafeRunner(v('recipes/florence-caption.js'), {
      onProgress: (e) => { if (e?.status === 'progress' && e.file) out.textContent = `Downloading ${fileOf(e.file)}: ${Math.round(e.progress)}%`; },
    });
    loadBtn.onclick = async () => {
      if (runner.busy) { runner.stop(); return; }
      loadBtn.textContent = 'Stop';
      out.textContent = 'Loading…';
      const t0 = performance.now();
      try {
        const { device } = await runner.call('load');
        out.textContent = `Loaded on the ${device === 'webgpu' ? 'GPU' : 'CPU'} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
        check();
      } catch (err) { out.textContent = err.message; }
      loadBtn.textContent = 'Load Florence-2 base now';
    };
    check();
    main.append(h('section', {}, h('h2', {}, 'This browser'),
      h('table', { class: 'table facts-table' }, rows), h('div', { class: 'actions' }, loadBtn), out));
    main.append(h('section', {}, h('h2', {}, 'Choosing the device'), h('dl', { class: 'terms' },
      h('dt', {}, h('code', {}, "load({ device: 'webgpu' })")), h('dd', {}, 'The GPU. Several times faster. Needs https or localhost and a browser with WebGPU (Chrome, Edge).'),
      h('dt', {}, h('code', {}, "load({ device: 'wasm' })")), h('dd', {}, 'The CPU. Works in every browser and on plain http. Slower, and a bigger download for the same model.'),
      h('dt', {}, h('code', {}, 'load()')), h('dd', {}, 'Picks the GPU when there is one, otherwise the CPU.'))));
    main.append(h('section', {}, h('h2', {}, 'Where the model is kept'),
      p('On https and localhost, Transformers.js saves each file in Cache storage <code>transformers-cache</code> (DevTools, Application, Cache storage) and reads it from there next time. On plain http browsers switch that off, so the model downloads on every visit unless you give it IndexedDB instead:'),
      codeSheet([
        { name: 'http-cache.js', file: 'http-cache.js', text: fetchText('recipes/http-cache.js'), note: 'Call useIndexedDBCacheOnPlainHttp() once, before load().' },
        { name: 'Showing progress', file: 'load-progress.js', text: `import { load } from './florence-caption.js';

// onProgress gets one event per file: 'initiate', then 'progress' (0–100), then 'done'.
const seen = {};
await load({
  onProgress(e) {
    if (e.status !== 'progress') return;
    seen[e.file] = e.progress;
    const pct = Object.values(seen).reduce((a, b) => a + b, 0) / Object.keys(seen).length;
    document.querySelector('#status').textContent = \`Downloading the model: \${Math.round(pct)}%\`;
  },
});
` },
        { name: 'Keep it permanently', file: 'keep.js', text: `// Ask the browser not to clear saved models when the disk runs low.
// Chrome decides by itself (it usually agrees once the site is bookmarked or used often).
const kept = await navigator.storage?.persist?.();
console.log(kept ? 'Saved models are kept permanently.' : 'The browser may clear them if the disk runs low.');
` },
      ])));
  },

  safe(main) {
    main.append(h('header', { class: 'doc-head' },
      h('h1', {}, 'Run it safely'),
      h('p', { class: 'lead', html: 'A heavy model can make a computer struggle, and code running on the page can’t be stopped halfway. <code>safe-runner.js</code> runs any recipe in a background worker and terminates it the moment something goes wrong. That ends the work at once and frees its memory and GPU.' })));
    const log = h('ul', { class: 'log' });
    const add = (text, cls = '') => log.prepend(h('li', { class: cls }, `${new Date().toLocaleTimeString()}  ${text}`));
    const limit = h('select', { 'aria-label': 'Time limit' },
      h('option', { value: '2000' }, '2 seconds (it will be stopped)'),
      h('option', { value: '10000' }, '10 seconds'),
      h('option', { value: '90000', selected: true }, '90 seconds (the default)'));
    const runner = createSafeRunner(v('recipes/florence-caption.js'), { timeLimitMs: 90_000 });
    const runBtn = h('button', { type: 'button', class: 'run' }, 'Caption the sample photo');
    const freezeBtn = h('button', { type: 'button', class: 'quiet' }, 'Freeze this page for 9 seconds');
    const stopBtn = h('button', { type: 'button', class: 'quiet' }, 'Stop');
    runBtn.onclick = async () => {
      runner.setTimeLimit(Number(limit.value));
      try {
        add('Loading the model…');
        await runner.call('load');
        add(`Captioning, with a ${Number(limit.value) / 1000} s limit…`);
        const t0 = performance.now();
        const text = await runner.call('caption', SAMPLES.cat, { detail: 'paragraph' });
        add(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${text}`, 'ok');
      } catch (err) {
        add(err.message, err instanceof Stopped ? 'stop' : 'err');
      }
    };
    freezeBtn.onclick = () => {
      if (!runner.busy) { add('Start a caption first, then freeze the page while it runs.'); return; }
      add('Freezing the page for 9 s…');
      setTimeout(() => { const t = Date.now(); while (Date.now() - t < 9000) {} }, 50);
    };
    stopBtn.onclick = () => runner.stop();
    main.append(h('section', {}, h('h2', {}, 'Try it'),
      p('Caption a photo with a time limit. Pick 2 seconds to see it stopped, or start a caption and freeze the page to see the watchdog notice.'),
      h('div', { class: 'actions' }, limit, runBtn, freezeBtn, stopBtn), log));
    main.append(h('section', {}, h('h2', {}, 'When it stops'), h('dl', { class: 'terms' },
      h('dt', {}, 'Too slow'), h('dd', { html: 'A task runs longer than <code>timeLimitMs</code> (90 s), or a load longer than <code>loadLimitMs</code> (20 min).' }),
      h('dt', {}, 'Stuck download'), h('dd', { html: 'A load makes no progress for <code>stallMs</code> (90 s).' }),
      h('dt', {}, 'Computer struggling'), h('dd', { html: 'The page’s own timer falls more than <code>freezeMs</code> (4 s) behind, twice in a row, or twice that once. Hidden tabs are ignored: browsers slow their timers on purpose.' }),
      h('dt', {}, 'Crash'), h('dd', {}, 'The worker dies, usually out of memory.'),
      h('dt', {}, 'You'), h('dd', { html: '<code>ai.stop()</code>.' }))),
      p('Every stop rejects the call with a <code>Stopped</code> error whose <code>reason</code> says which. The model goes with the worker, so call <code>load()</code> again before the next task.'));
    main.append(h('section', {}, h('h2', {}, 'The code'),
      p('Copy all three files next to your recipe. The worker uses <code>http-cache.js</code> so plain-http addresses keep the model too.'),
      codeSheet([
        { name: 'Using it', file: 'example.js', text: `import { createSafeRunner, Stopped } from './safe-runner.js';

const ai = createSafeRunner(new URL('./florence-caption.js', import.meta.url), {
  timeLimitMs: 90_000,   // one task
  onProgress: (e) => {}, // download progress and one event per generated word
});

await ai.call('load');
try {
  const text = await ai.call('caption', photoUrl, { detail: 'short' });
} catch (err) {
  if (err instanceof Stopped) console.warn(err.reason, err.message);
  else throw err;
}
` },
        { name: 'safe-runner.js', file: 'safe-runner.js', text: fetchText('recipes/safe-runner.js') },
        { name: 'safe-worker.js', file: 'safe-worker.js', text: fetchText('recipes/safe-worker.js') },
        { name: 'http-cache.js', file: 'http-cache.js', text: fetchText('recipes/http-cache.js') },
      ])));
  },

  project(main) {
    main.append(h('header', { class: 'doc-head' },
      h('h1', {}, 'Use a recipe in a real project'),
      h('p', { class: 'lead' }, 'Recipes are plain JavaScript modules. Copy the file, import it, call the function. Three common setups:')));
    main.append(h('section', {}, h('h2', {}, 'A plain page'),
      p('Put the recipe file next to your page and load your script as a module.'),
      codeSheet([{ name: 'index.html', file: 'index.html', text: `<input type="file" id="photo" accept="image/*">
<p id="out"></p>

<script type="module">
  import { caption } from './florence-caption.js';

  document.querySelector('#photo').onchange = async (e) => {
    const file = e.target.files[0];
    document.querySelector('#out').textContent = 'Working…';
    document.querySelector('#out').textContent = await caption(file);
  };
</script>
` }])));
    main.append(h('section', {}, h('h2', {}, 'npm and a bundler (Vite, webpack)'),
      p('Install the library, then change the recipe’s import line from the CDN address to the package name. Everything else stays the same.'),
      codeSheet([
        { name: 'Install', file: 'install.sh', text: 'npm install @huggingface/transformers@3.7.1\n' },
        { name: 'Change in the recipe', file: 'recipe-import.js', text: `// before
import { Florence2ForConditionalGeneration, AutoProcessor, RawImage }
  from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

// after
import { Florence2ForConditionalGeneration, AutoProcessor, RawImage }
  from '@huggingface/transformers';
` },
      ])));
    main.append(h('section', {}, h('h2', {}, 'WordPress'),
      p('Ship the recipe in your plugin or theme and enqueue your script as a module (WordPress 6.5 or later).'),
      codeSheet([
        { name: 'PHP', file: 'enqueue.php', text: `add_action( 'wp_enqueue_scripts', function () {
\twp_enqueue_script_module(
\t\t'my-ai-caption',
\t\tplugins_url( 'js/caption-app.js', __FILE__ ),
\t\tarray(),
\t\t'1.0.0'
\t);
} );
` },
        { name: 'js/caption-app.js', file: 'caption-app.js', text: `import { caption } from './florence-caption.js';

const input = document.querySelector('#my-photo');
input?.addEventListener('change', async () => {
  document.querySelector('#my-caption').textContent = await caption(input.files[0]);
});
` },
      ])));
    main.append(h('section', {}, h('h2', {}, 'Before you ship'), h('ul', { class: 'notes' },
      h('li', {}, 'Serve the site over https, or the GPU and model caching are switched off.'),
      h('li', {}, 'Tell people the first use downloads the model, and show progress (see Load a model).'),
      h('li', {}, 'Photos from other sites only work if that site allows it (CORS). Files people choose always work.'),
      h('li', {}, 'For anything heavy, or on weak machines, wrap the recipe with safe-runner.js.'),
      h('li', {}, 'Check the model’s licence on its Hugging Face page. Florence-2 is MIT.'))));
  },
};

// ---------- go ----------
const main = shell();
if (page?.kind === 'recipe') recipePage(main);
else if (STARTS[slug]) STARTS[slug](main);
main.append(prevNext());
document.title = page ? page.title : 'Local AI recipes';
