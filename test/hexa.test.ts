/**
 * Hexa tests, offline: fal and downloads are fakes.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJob, NIVELES, type TaskContext } from '../src/agent.js';
import {
  buildCall,
  pickFraming,
  pickKind,
  isTransient,
  extractOutput,
  DEFAULT_MODELS,
  trimPrompt,
  type FalLike,
} from '../src/fal.js';

// No LLM: the prompt is the brief as is, so the test is deterministic.
delete process.env.LLM_API_KEY;
process.env.LLM_PROVIDER = '';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

function fakeFal(respuesta: unknown, failures = 0) {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const uploads: Blob[] = [];
  let remaining = failures;
  const fal: FalLike = {
    async subscribe(endpoint, { input }) {
      calls.push({ endpoint, input });
      if (remaining-- > 0) throw Object.assign(new Error('Bad Gateway'), { status: 502 });
      return { data: respuesta, requestId: 'req-1' };
    },
    storage: {
      async upload(file) {
        uploads.push(file);
        return 'https://fal.media/ref.png';
      },
    },
  };
  return { fal, calls, uploads };
}

const download = async (url: string) =>
  url.endsWith('.mp4') ? { bytes: MP4, mime: 'video/mp4' } : { bytes: PNG, mime: 'image/png' };

function ctx(over: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: 7n,
    client: '0x0000000000000000000000000000000000000001',
    amount: NIVELES[0]!.wei,
    deadline: 0n,
    nivel: NIVELES[0]!,
    adjuntos: [],
    consultar: async () => '',
    presupuesto: 0n,
    envelope: null,
    historial: [],
    ...over,
  };
}

test('the first tier is the image and prices go up', () => {
  assert.equal(NIVELES[0]!.name, 'Image');
  assert.ok(NIVELES[0]!.wei < NIVELES[1]!.wei && NIVELES[1]!.wei < NIVELES[2]!.wei);
});

test('the paid tier rules, not the text', () => {
  assert.equal(pickKind('hazme un vídeo de un gato', { name: 'Image' }, false), 'image');
  assert.equal(pickKind('un gato', { name: 'Video 5 s' }, false), 'video');
  assert.equal(pickKind('un vídeo de un gato', null, false), 'video');
  assert.equal(pickKind('un vídeo de un gato', null, true), 'image');
});

test('framing from the brief', () => {
  assert.equal(pickFraming('un reel vertical', 'video'), 'portrait');
  assert.equal(pickFraming('YouTube cover', 'image'), 'landscape');
  assert.equal(pickFraming('a logo for my cafe', 'image'), 'square');
  assert.equal(pickFraming('a dog running', 'video'), 'landscape');
  // What the client states outright wins over platform words.
  assert.equal(pickFraming('square 1:1 cover for my YouTube channel', 'image'), 'square');
  assert.equal(pickFraming('a clip for YouTube Shorts', 'video'), 'portrait');
  // "short" as an adjective is not a YouTube Short.
  assert.equal(pickFraming('a short animated version of the logo', 'image'), 'square');
});

test('builds the call for each model', () => {
  const base = { prompt: 'a cat', framing: 'square' as const, count: 4, duration: '5' as const };
  const img = buildCall({ ...base, kind: 'image' }, DEFAULT_MODELS, null);
  assert.equal(img.model, 'fal-ai/flux-2');
  assert.equal(img.input.num_images, 4);
  assert.equal(img.input.image_size, 'square_hd');

  const edit = buildCall({ ...base, kind: 'image' }, DEFAULT_MODELS, 'https://x/r.png');
  assert.equal(edit.model, 'fal-ai/flux-2/edit');
  assert.deepEqual(edit.input.image_urls, ['https://x/r.png']);

  const vid = buildCall({ ...base, kind: 'video', framing: 'portrait' }, DEFAULT_MODELS, null);
  assert.equal(vid.model, DEFAULT_MODELS.video);
  assert.equal(vid.input.aspect_ratio, '9:16');
  assert.equal(vid.input.duration, '5');
  assert.equal(vid.input.num_images, undefined);

  const i2v = buildCall({ ...base, kind: 'video' }, DEFAULT_MODELS, 'https://x/r.png');
  assert.equal(i2v.model, DEFAULT_MODELS.imageToVideo);
  assert.equal(i2v.input.image_url, 'https://x/r.png');
});

test('extracts image and video URLs', () => {
  const a = extractOutput({ images: [{ url: 'u1', content_type: 'image/png' }, { url: 'u2' }], has_nsfw_concepts: [false, true] });
  assert.deepEqual(a.urls.map((u) => u.url), ['u1', 'u2']);
  assert.equal(a.censored, 1);
  assert.deepEqual(extractOutput({ video: { url: 'v.mp4' } }).urls.map((u) => u.url), ['v.mp4']);
  assert.equal(extractOutput(null).urls.length, 0);
});

test('trims long prompts without cutting words', () => {
  const largo = 'word '.repeat(1000);
  const r = trimPrompt(largo, 100);
  assert.ok(r.length <= 100);
  assert.ok(r.endsWith('word'));
});

test('image job: delivers a PNG and always answers in English', async () => {
  const { fal, calls } = fakeFal({ images: [{ url: 'https://fal.media/a.png', content_type: 'image/png' }] });
  const r = await runJob('Un logo minimalista de una abeja hexagonal', ctx(), { fal, models: DEFAULT_MODELS, download });
  assert.equal(typeof r, 'object');
  if (typeof r === 'string') return;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.endpoint, 'fal-ai/flux-2');
  assert.equal(r.files?.length, 1);
  assert.equal(r.files?.[0]?.name, 'hexa.png');
  assert.match(r.text, /^Here is your image: hexa\.png\./);
  assert.doesNotMatch(r.text, /\*\*|^#/m);
});

test('image tier with a brief that also wants a video: square PNG and says how to get the video', async () => {
  // The brief of task #102, word for word.
  const brief =
    'I need a retro synthwave logo for my new podcast called "Neon Nights". It should feature a glowing sun and a palm tree ' +
    'silhouette in purple and pink tones, square 1:1 format. Please deliver it as a PNG. Also create a short animated version ' +
    'of the logo for a 5-second intro, delivered as an MP4.';
  const { fal, calls } = fakeFal({ images: [{ url: 'https://fal.media/a.png', content_type: 'image/png' }] });
  const r = await runJob(brief, ctx(), { fal, models: DEFAULT_MODELS, download });
  if (typeof r === 'string') return assert.fail('expected files');
  assert.equal(calls[0]!.endpoint, 'fal-ai/flux-2');
  assert.equal(calls[0]!.input.image_size, 'square_hd');
  assert.equal(r.files?.length, 1);
  assert.match(r.text, /also asks for a video/);
  assert.match(r.text, /"Video 5 s" tier/);
});

test('a plain image brief carries no video note', async () => {
  const { fal } = fakeFal({ images: [{ url: 'https://fal.media/a.png', content_type: 'image/png' }] });
  const r = await runJob('A neon city at night', ctx(), { fal, models: DEFAULT_MODELS, download });
  if (typeof r === 'string') return assert.fail('expected files');
  assert.doesNotMatch(r.text, /asks for a video/);
});

test('pack: asks for four images', async () => {
  const urls = [1, 2, 3, 4].map((i) => ({ url: `https://fal.media/${i}.png`, content_type: 'image/png' }));
  const { fal, calls } = fakeFal({ images: urls });
  const r = await runJob('A neon city at night', ctx({ nivel: NIVELES[1]!, amount: NIVELES[1]!.wei }), {
    fal,
    models: DEFAULT_MODELS,
    download,
  });
  assert.equal(calls[0]!.input.num_images, 4);
  if (typeof r === 'string') assert.fail(r);
  assert.deepEqual(r.files?.map((f) => f.name), ['hexa-1.png', 'hexa-2.png', 'hexa-3.png', 'hexa-4.png']);
  assert.match(r.text, /Here are your 4 images/);
});

test('video with attached photo: uploads the reference and animates it', async () => {
  const { fal, calls, uploads } = fakeFal({ video: { url: 'https://fal.media/v.mp4', content_type: 'video/mp4' } }, 1);
  const r = await runJob(
    'Anima esta foto: que las alas se muevan, 10 segundos',
    ctx({ nivel: NIVELES[2]!, amount: NIVELES[2]!.wei, adjuntos: [{ name: 'abeja.png', mime: 'image/png', bytes: PNG }] }),
    { fal, models: DEFAULT_MODELS, download },
  );
  assert.equal(uploads.length, 1);
  assert.equal(calls.length, 2, 'retries once after a 502');
  assert.equal(calls[1]!.endpoint, DEFAULT_MODELS.imageToVideo);
  assert.equal(calls[1]!.input.duration, '10');
  if (typeof r === 'string') assert.fail(r);
  assert.equal(r.files?.[0]?.name, 'hexa-video.mp4');
  assert.match(r.text, /Here is your 10-second video, animated from your image/);
});

test('if fal fails, delivers an explanation instead of crashing', async () => {
  const fal: FalLike = {
    async subscribe() {
      throw Object.assign(new Error('Unprocessable Entity'), { status: 422 });
    },
    storage: { upload: async () => '' },
  };
  const r = await runJob('un gato con sombrero', ctx(), { fal, models: DEFAULT_MODELS, download });
  assert.equal(typeof r, 'string');
  assert.match(String(r), /I could not complete this job/);
  assert.match(String(r), /dispute/);
});

test('transient errors', () => {
  assert.ok(isTransient(Object.assign(new Error('x'), { status: 503 })));
  assert.ok(!isTransient(Object.assign(new Error('x'), { status: 422 })));
  assert.ok(isTransient(new Error('fetch failed')));
});
