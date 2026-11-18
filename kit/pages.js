// Every page of the recipe book: the menu, and what each page shows.
// Adding a recipe page: write its file in recipes/, add an entry to PAGES and a line to MENU,
// and create the page file (a copy of caption.html with its data-page changed).

// Bump after changing a recipe file, so browsers (and the demo workers) fetch the new one.
export const RECIPE_VERSION = 2;

const HFD = 'https://huggingface.co/datasets';
export const SAMPLES = {
  cat: `${HFD}/huggingface/documentation-images/resolve/main/pipeline-cat-chonk.jpeg`,
  cats: `${HFD}/Xenova/transformers.js-docs/resolve/main/cats.jpg`,
  street: `${HFD}/Xenova/transformers.js-docs/resolve/main/city-streets.jpg`,
  football: `${HFD}/Xenova/transformers.js-docs/resolve/main/football-match.jpg`,
  receipt: `${HFD}/Xenova/transformers.js-docs/resolve/main/receipt.png`,
  advert: `${HFD}/Xenova/transformers.js-docs/resolve/main/coca_cola_advertisement.png`,
};

const FLORENCE = {
  name: 'Florence-2 base',
  url: 'https://huggingface.co/onnx-community/Florence-2-base-ft',
  download: '357 MB on the GPU, 667 MB on the CPU (once)',
  licence: 'MIT',
};

export const MENU = [
  { group: 'Start here', pages: ['index', 'load', 'safe', 'project'] },
  { group: 'Describe', pages: ['caption'] },
  { group: 'Read text', pages: ['read-text'] },
  { group: 'Find', pages: ['objects', 'phrases', 'find'] },
  { group: 'Outline', pages: ['outline'] },
  { group: 'Ask about an area', pages: ['area'] },
  { group: 'Everything at once', pages: ['playground'] },
];

// kind: 'start' (a guide page) or 'recipe' (a feature page with a demo).
// Recipe pages: fns are the recipe's functions shown in the demo.
//   shows: 'text' | 'lines' (OCR lines) | 'shapes' (boxes and outlines)
//   input: a text field the function takes after the photo; area: a box drawn on the photo
//   opts:  the options object passed last
export const PAGES = {
  index: { kind: 'start', file: './', menu: 'What this is', title: 'Local AI recipes' },
  load: { kind: 'start', file: 'load.html', menu: 'Load a model', title: 'Load a model and keep it' },
  safe: { kind: 'start', file: 'safe.html', menu: 'Run it safely', title: 'Run it safely' },
  project: { kind: 'start', file: 'project.html', menu: 'Use it in a project', title: 'Use a recipe in a real project' },
  playground: { kind: 'link', file: 'playground.html', menu: 'Playground', title: 'Playground' },

  caption: {
    kind: 'recipe', file: 'caption.html', menu: 'Caption a photo', title: 'Caption a photo',
    intro: 'Describe a photo in one sentence, a few sentences, or a paragraph.',
    recipe: 'recipes/florence-caption.js', model: FLORENCE, sample: SAMPLES.cats,
    fns: [
      { fn: 'caption', name: 'Short', shows: 'text', opts: { detail: 'short' } },
      { fn: 'caption', name: 'Detailed', shows: 'text', opts: { detail: 'detailed' } },
      { fn: 'caption', name: 'A paragraph', shows: 'text', opts: { detail: 'paragraph' } },
    ],
    notes: [
      'Short captions are the most reliable. Longer ones add detail, and with it more mistakes: a paragraph can call the same cat a dog later on.',
      'It describes what it sees; it can’t answer questions about the photo.',
      'Large photos are fine: the model shrinks them to 768 px for itself.',
      'For better wording, change MODEL to Florence-2 large in the recipe (about three times the download, and slower).',
    ],
  },

  'read-text': {
    kind: 'recipe', file: 'read-text.html', menu: 'Read text (OCR)', title: 'Read the text in a photo',
    intro: 'Read printed text: signs, labels, receipts, screenshots. Get it as one string, or line by line with positions.',
    recipe: 'recipes/florence-read-text.js', model: FLORENCE, sample: SAMPLES.receipt,
    fns: [
      { fn: 'readText', name: 'All the text', shows: 'text' },
      { fn: 'readTextLines', name: 'Line by line', shows: 'lines' },
    ],
    notes: [
      'Printed text only; handwriting comes out poorly.',
      'Line by line returns each line’s four corners (quad), so slanted text is boxed correctly.',
      'Small text in a big photo may be missed: crop to the part with text first.',
      'Long documents are cut off: the recipe stops after 1,024 tokens of output (roughly 700 words).',
    ],
  },

  objects: {
    kind: 'recipe', file: 'objects.html', menu: 'Find objects', title: 'Find the objects in a photo',
    intro: 'Box every everyday object it recognises, with a name. Or box anything that looks like a separate thing, without names.',
    recipe: 'recipes/florence-find-objects.js', model: FLORENCE, sample: SAMPLES.street,
    fns: [
      { fn: 'findObjects', name: 'Objects', shows: 'shapes' },
      { fn: 'findRegions', name: 'Possible regions', shows: 'shapes' },
    ],
    notes: [
      'Boxes are [x1, y1, x2, y2] in pixels of the original photo: top-left and bottom-right corners.',
      'Crowded photos list the same name many times (one per object); count them by label.',
      'Names come from a fixed everyday vocabulary. To find something specific, use Find anything you name.',
    ],
  },

  phrases: {
    kind: 'recipe', file: 'phrases.html', menu: 'Find what a sentence mentions', title: 'Find the things a sentence mentions',
    intro: 'Give a sentence about the photo; get a box for each thing it mentions.',
    recipe: 'recipes/florence-find-phrases.js', model: FLORENCE, sample: SAMPLES.football,
    fns: [
      { fn: 'findPhrases', name: 'Find phrases', shows: 'shapes',
        input: { label: 'A sentence about the photo', value: 'Football players on a green field with a ball' } },
    ],
    notes: [
      'Each label is the phrase from your sentence that the box belongs to.',
      'Plain, concrete words work best ("a man in a red shirt"), not abstract ones ("happiness").',
      'Use it to check whether a caption matches the photo: phrases that find nothing probably aren’t there.',
    ],
  },

  find: {
    kind: 'recipe', file: 'find.html', menu: 'Find anything you name', title: 'Find anything you name',
    intro: 'Name a thing in plain words; get where it is, even for things with no fixed label.',
    recipe: 'recipes/florence-find-anything.js', model: FLORENCE, sample: SAMPLES.street,
    fns: [
      { fn: 'findAnything', name: 'Find it', shows: 'shapes', input: { label: 'What to find', value: 'traffic light' } },
    ],
    notes: [
      'Usually returns a box; sometimes an outline (polygon) instead. Handle both.',
      'If the thing isn’t there it may still box something close to it; check the result before trusting it.',
      'One name at a time. For several, call it once per name.',
    ],
  },

  outline: {
    kind: 'recipe', file: 'outline.html', menu: 'Outline what you describe', title: 'Outline what you describe',
    intro: 'Describe a thing in words; get its outline as a polygon you can draw, cut out or measure.',
    recipe: 'recipes/florence-outline.js', model: FLORENCE, sample: SAMPLES.cat,
    fns: [
      { fn: 'outline', name: 'Outline it', shows: 'shapes', input: { label: 'What to outline', value: 'the cat' } },
    ],
    notes: [
      'Polygons are lists of [x, y] points in pixels of the original photo.',
      'Outlines are rough, made of a few dozen points. For pixel-exact cut-outs a dedicated segmentation model does better.',
      'Returns an empty list when it can’t find what you described.',
    ],
  },

  area: {
    kind: 'recipe', file: 'area.html', menu: 'Ask about an area', title: 'Ask about an area of a photo',
    intro: 'Mark an area of the photo, then ask what it is, describe it, read its text, or outline what’s inside.',
    recipe: 'recipes/florence-ask-area.js', model: FLORENCE, sample: SAMPLES.advert,
    fns: [
      { fn: 'nameArea', name: 'Name it', shows: 'text', area: true },
      { fn: 'describeArea', name: 'Describe it', shows: 'text', area: true },
      { fn: 'readArea', name: 'Read its text', shows: 'text', area: true },
      { fn: 'outlineArea', name: 'Outline it', shows: 'shapes', area: true },
    ],
    notes: [
      'The area is a box in pixels of the original photo: [x1, y1, x2, y2].',
      'Tight boxes work best; a box covering half the photo gets a vague answer.',
      'In your own app the box can come from anywhere: a drag on the photo, or a box from Find objects.',
    ],
  },
};

export const pageOrder = MENU.flatMap((g) => g.pages).filter((s) => PAGES[s].kind !== 'link');
