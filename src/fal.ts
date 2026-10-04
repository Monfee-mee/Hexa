/**
 * Hexa generates images and videos with fal.ai.
 *
 * This file knows nothing about Panal: it takes what to generate and returns
 * the bytes. That keeps it testable without a chain, an escrow or fal credit
 * (the tests pass in a fake client).
 *
 * Models are picked in .env. The defaults had the best quality/price ratio at
 * the time of writing; switching them needs no code change as long as the new
 * model speaks the same schema (prompt + image_size for images, prompt +
 * duration + aspect_ratio for video).
 */

import { createFalClient } from '@fal-ai/client';

export type Kind = 'image' | 'video';
export type Framing = 'square' | 'portrait' | 'landscape';

export interface Models {
  image: string;
  edit: string;
  video: string;
  imageToVideo: string;
}

export const DEFAULT_MODELS: Models = {
  image: 'fal-ai/flux-2',
  edit: 'fal-ai/flux-2/edit',
  video: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
  imageToVideo: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
};

export function modelsFromEnv(env: NodeJS.ProcessEnv): Models {
  return {
    image: env.FAL_IMAGE_MODEL?.trim() || DEFAULT_MODELS.image,
    edit: env.FAL_EDIT_MODEL?.trim() || DEFAULT_MODELS.edit,
    video: env.FAL_VIDEO_MODEL?.trim() || DEFAULT_MODELS.video,
    imageToVideo: env.FAL_I2V_MODEL?.trim() || DEFAULT_MODELS.imageToVideo,
  };
}

/** The bit of the fal client Hexa uses. Tests replace it. */
export interface FalLike {
  subscribe(endpoint: string, opts: { input: Record<string, unknown>; logs?: boolean }): Promise<{ data: unknown; requestId: string }>;
  storage: { upload(file: Blob): Promise<string> };
}

export function falClient(credentials: string): FalLike {
  return createFalClient({ credentials }) as unknown as FalLike;
}

/** A generated file, ready to deliver. */
export interface GeneratedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface Job {
  kind: Kind;
  prompt: string;
  framing: Framing;
  /** How many images (video is always one). */
  count: number;
  /** Video length in seconds: '5' or '10'. */
  duration: '5' | '10';
  /** The client's reference image: edited, or animated for video. */
  reference?: { bytes: Uint8Array; mime: string; name: string } | undefined;
}

export interface Output {
  files: GeneratedFile[];
  model: string;
  /** Images blanked by fal's safety filter. */
  censored: number;
}

/** Largest file Panal accepts per delivery. */
export const MAX_BYTES = 25 * 1024 * 1024;

/** Longest prompt the video models accept (Kling: 2500). */
export const MAX_PROMPT = 2_500;

// ────────────────────────────────────────────────────────────────────────────
//  Reading the brief
// ────────────────────────────────────────────────────────────────────────────

const ASKS_FOR_VIDEO =
  /\b(v[ií]deos?|clips?|animaci[oó]n|anima(r|lo|la)?|animad[oa]s?|animated?|animation|movie|reels?|tiktok|motion|mp4)\b/i;

/** Whether the brief asks for a video, whatever tier was paid for. */
export function asksForVideo(brief: string): boolean {
  return ASKS_FOR_VIDEO.test(brief);
}

/**
 * Image or video?
 *
 * The PAID TIER decides, never the text: the client writes the brief and could
 * ask for a video while paying for an image. The text is only read without
 * tiers, and an x402 call (a fixed, low price) is always an image.
 */
export function pickKind(brief: string, tier: { name: string } | null, isX402: boolean): Kind {
  if (isX402) return 'image';
  if (tier) return /video/i.test(tier.name) ? 'video' : 'image';
  return ASKS_FOR_VIDEO.test(brief) ? 'video' : 'image';
}

/** How many images were bought. The "Pack" is four. */
export function pickCount(tier: { name: string } | null): number {
  return tier && /pack/i.test(tier.name) ? 4 : 1;
}

export function pickFraming(brief: string, kind: Kind): Framing {
  // What the client states outright wins over what a platform suggests: a
  // "square 1:1" logo must not turn vertical because the brief also says
  // "short" or "reel" somewhere else.
  if (/\b1:1\b|\b(cuadrad[oa]s?|square)\b/i.test(brief)) return 'square';
  if (/\b9:16\b|\b(vertical|portrait|retrato)\b/i.test(brief)) return 'portrait';
  if (/\b16:9\b|\b(horizontal|landscape|paisaje)\b/i.test(brief)) return 'landscape';
  // Then the platform. `shorts` only in plural: "a short animated version" is
  // not a YouTube Short.
  if (/\b(reels?|tiktok|stor(y|ies)|historia|shorts|m[oó]vil|phone)\b/i.test(brief)) return 'portrait';
  if (/\b(youtube|banner|portada|cover|header|cabecera|wide|panor[aá]mic)/i.test(brief)) return 'landscape';
  if (/\b(logo|avatar|icon[oa]?|perfil|profile)\b/i.test(brief)) return 'square';
  // No hint: video looks best wide, and a square image works anywhere.
  return kind === 'video' ? 'landscape' : 'square';
}

export function pickDuration(brief: string): '5' | '10' {
  return /\b10\s*(s|sec|secs|seconds|seg|segundos)\b/i.test(brief) ? '10' : '5';
}

/** Trims without cutting words in half. */
export function trimPrompt(text: string, max = MAX_PROMPT): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.8 ? cut.slice(0, space) : cut).trim();
}

// ────────────────────────────────────────────────────────────────────────────
//  Generating
// ────────────────────────────────────────────────────────────────────────────

const IMAGE_SIZE: Record<Framing, string> = {
  square: 'square_hd',
  portrait: 'portrait_16_9',
  landscape: 'landscape_16_9',
};

const VIDEO_ASPECT: Record<Framing, string> = {
  square: '1:1',
  portrait: '9:16',
  landscape: '16:9',
};

/** Which model, with which input. Split out so it can be tested offline. */
export function buildCall(
  job: Job,
  models: Models,
  referenceUrl: string | null,
): { model: string; input: Record<string, unknown> } {
  const prompt = trimPrompt(job.prompt);
  if (job.kind === 'video') {
    if (referenceUrl) {
      return { model: models.imageToVideo, input: { prompt, image_url: referenceUrl, duration: job.duration } };
    }
    return {
      model: models.video,
      input: { prompt, duration: job.duration, aspect_ratio: VIDEO_ASPECT[job.framing] },
    };
  }
  const common = {
    prompt,
    num_images: job.count,
    output_format: 'png',
    enable_safety_checker: true,
  };
  if (referenceUrl) {
    return { model: models.edit, input: { ...common, image_urls: [referenceUrl] } };
  }
  return { model: models.image, input: { ...common, image_size: IMAGE_SIZE[job.framing] } };
}

interface Extracted {
  urls: { url: string; mime?: string | undefined }[];
  censored: number;
}

/**
 * Pulls the URLs out of a fal response, image or video.
 *
 * Each model family answers in its own shape (`images[]`, `image`, `video`),
 * and switching models in .env should not mean touching this.
 */
export function extractOutput(data: unknown): Extracted {
  const d = (data ?? {}) as Record<string, unknown>;
  const urls: Extracted['urls'] = [];
  const add = (f: unknown) => {
    if (f && typeof f === 'object' && typeof (f as { url?: unknown }).url === 'string') {
      const file = f as { url: string; content_type?: string };
      urls.push({ url: file.url, mime: file.content_type });
    }
  };
  if (Array.isArray(d.images)) d.images.forEach(add);
  add(d.image);
  add(d.video);
  const nsfw = Array.isArray(d.has_nsfw_concepts) ? d.has_nsfw_concepts.filter(Boolean).length : 0;
  return { urls, censored: nsfw };
}

function extension(mime: string, kind: Kind): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('mp4')) return 'mp4';
  return kind === 'video' ? 'mp4' : 'png';
}

/** A promise with a deadline: a stuck model must not leave the task stuck. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what}: no response in ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Deps {
  fal: FalLike;
  models: Models;
  download?: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** Timeout per generation. Defaults to 4 min for images and 15 for video. */
  timeoutMs?: number;
}

async function defaultDownload(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the fal result (${res.status})`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error(`the result is ${length} bytes, more than Panal accepts`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mime: res.headers.get('content-type') ?? '' };
}

/**
 * Generates the job and returns the files.
 *
 * The bytes are downloaded instead of handing over the fal link: the hash of
 * what is delivered gets anchored on-chain, and a third-party link can expire
 * or change after payment.
 */
export async function generate(job: Job, deps: Deps): Promise<Output> {
  const download = deps.download ?? defaultDownload;
  const timeout = deps.timeoutMs ?? (job.kind === 'video' ? 15 * 60_000 : 4 * 60_000);

  let referenceUrl: string | null = null;
  if (job.reference) {
    const blob = new Blob([job.reference.bytes], { type: job.reference.mime });
    referenceUrl = await withTimeout(deps.fal.storage.upload(blob), 60_000, 'reference upload');
  }

  const { model, input } = buildCall(job, deps.models, referenceUrl);

  // One retry: fal's queue sometimes returns a passing 5xx. More than one is
  // not worth it, the client is waiting and every attempt costs.
  let data: unknown;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await withTimeout(deps.fal.subscribe(model, { input, logs: false }), timeout, model);
      data = r.data;
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) break;
    }
  }
  if (lastError) throw lastError;

  const { urls, censored } = extractOutput(data);
  if (urls.length === 0) throw new Error(`${model} returned no file`);

  const files: GeneratedFile[] = [];
  for (const [i, u] of urls.entries()) {
    const { bytes, mime: downloadedMime } = await download(u.url);
    if (bytes.byteLength > MAX_BYTES) throw new Error(`file ${i + 1} is larger than Panal accepts`);
    const mime = u.mime || downloadedMime || (job.kind === 'video' ? 'video/mp4' : 'image/png');
    const base = job.kind === 'video' ? 'hexa-video' : urls.length > 1 ? `hexa-${i + 1}` : 'hexa';
    files.push({ name: `${base}.${extension(mime, job.kind)}`, mime, data: bytes });
  }
  return { files, model, censored };
}

/** Errors worth retrying: network, timeout, or a 5xx/429 from fal. */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;
  const msg = err instanceof Error ? err.message : String(err);
  return /no response|timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(msg);
}
