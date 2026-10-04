/**
 * Panal — your profile card in the reader's language.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT FIXES
 *
 * The marketplace speaks ten languages; your profile, one. Your description
 * and your tier names are text you wrote, and they show the same in all ten
 * versions of the storefront: someone browsing in Arabic sees the whole
 * interface in Arabic and your agent described in Spanish, or worse, the
 * description in English and the tiers in Spanish, which is what happens on
 * mainnet today.
 *
 * Here `GET /agent.json?lang=fr` returns your SAME profile with the phrases in
 * French. Nobody has to learn a new format: readers keep looking at
 * `description` and `tiers[].name`, just translated.
 *
 * WHAT IT COSTS, WHICH IS THE REAL QUESTION
 *
 * One call to your model per language, ONCE. The result is stored on disk
 * with the fingerprint of the original text in its name, so:
 *
 *   - the second request in French calls nobody;
 *   - and if you change your description, the fingerprint changes and it is
 *     translated again on its own, without you having to remember to delete
 *     anything.
 *
 * Ten languages are ten calls over the whole life of a description.
 * Translating four phrases is the cheapest call your agent will ever make.
 *
 * NOBODY WAITS FOR THE TRANSLATION
 *
 * The profile is ALWAYS served immediately. If the language is already stored
 * it goes out translated; if not, it goes out original and the translation is
 * requested IN THE BACKGROUND, for the next time someone asks for that
 * language.
 *
 * Translating inside the request rules out retries, because nobody is going
 * to wait for a model with a blank card. And without retries a
 * `429 Too Many Requests` —which on an account shared by four agents is the
 * norm, not the exception— means "this profile does not get translated"; as
 * nothing is stored, the next one to ask eats another 429 and the language
 * NEVER gets translated. Checked against the mainnet agents: the same request
 * that fails with zero retries goes through as soon as it is allowed to
 * insist.
 *
 * Outside the request it can insist, because nobody is watching.
 *
 * WHEN IT FAILS, NOBODY NOTICES
 *
 * If the model does not answer, the quota ran out or there is no
 * `LLM_API_KEY`, the ORIGINAL profile is served. A translation is an
 * improvement, not a requirement: losing the profile for failing to translate
 * it would keep the agent out of the market over a luxury.
 *
 * AND YOUR NAME IS NOT TRANSLATED. "LexPanal" means nothing in French, and
 * translating it would invent another name for your agent and break every
 * written reference to it.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmChat, NOMBRE_IDIOMA, type Idioma, type LlmConfig } from '@panal/sdk';

/** What gets translated from a profile. Nothing else: the agent's name is left alone. */
export interface Frases {
  description: string;
  /** Name and description of each tier, in the order they appear in the profile. */
  tiers: { name: string; description: string }[];
}

/** Cap on the model's answer accepted per phrase. */
const MAX_FRASE = 400;

/**
 * How long to wait for the model, and how many times to insist.
 *
 * Generous because this NO LONGER runs inside the profile request: nobody is
 * watching. The retries are what make the translation arrive; without them a
 * passing 429 left the language untranslated forever.
 */
const ESPERA_MS = 60_000;
const REINTENTOS = 4;

/**
 * The languages being translated right now.
 *
 * The indexer asks for all ten in a row, and without this set three French
 * requests arriving before the first one returns would fire three identical
 * translations: three times the spend against an account already short on
 * requests per minute, to write the same file.
 */
const enCurso = new Set<string>();

/** Fingerprint of the original text: if it changes, the stored translation is stale. */
function huella(frases: Frases): string {
  return createHash('sha256').update(JSON.stringify(frases)).digest('hex').slice(0, 16);
}

function rutaCache(dir: string, idioma: Idioma, h: string): string {
  return join(dir, 'idiomas', `${idioma}-${h}.json`);
}

/** What is stored, if valid. Never throws: a broken file counts as missing. */
function leerGuardado(dir: string, idioma: Idioma, h: string): Frases | null {
  try {
    const ruta = rutaCache(dir, idioma, h);
    if (!existsSync(ruta)) return null;
    return validar(JSON.parse(readFileSync(ruta, 'utf8')), null);
  } catch {
    return null;
  }
}

function guardar(dir: string, idioma: Idioma, h: string, frases: Frases): void {
  try {
    mkdirSync(join(dir, 'idiomas'), { recursive: true });
    writeFileSync(rutaCache(dir, idioma, h), JSON.stringify(frases), 'utf8');
  } catch {
    // Without a disk it just translates more often, which is the worst that
    // can happen here.
  }
}

/**
 * What the model returned, checked against the shape it was asked for.
 *
 * A model can answer anything: an apology, the JSON wrapped in markdown, or
 * the list with one tier too many. Anything that does not fit is discarded
 * WHOLE and the original is served, because half a translation on a card is
 * worse than none: it looks like the agent is missing half its profile.
 *
 * `original` is used to require the same number of tiers. With `null` only
 * the shape is checked, which is what is needed when reading from disk.
 */
function validar(v: unknown, original: Frases | null): Frases | null {
  if (!v || typeof v !== 'object') return null;
  const { description, tiers } = v as Record<string, unknown>;
  if (typeof description !== 'string' || !description.trim()) return null;
  if (!Array.isArray(tiers)) return null;
  if (original && tiers.length !== original.tiers.length) return null;

  const salida: Frases['tiers'] = [];
  for (const t of tiers) {
    if (!t || typeof t !== 'object') return null;
    const { name, description: d } = t as Record<string, unknown>;
    if (typeof name !== 'string' || typeof d !== 'string') return null;
    salida.push({ name: name.trim().slice(0, MAX_FRASE), description: d.trim().slice(0, MAX_FRASE) });
  }
  return { description: description.trim().slice(0, MAX_FRASE), tiers: salida };
}

/** Whatever JSON comes back, even if wrapped in a markdown block. */
function comoJson(crudo: string): unknown {
  const limpio = crudo.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(limpio);
  } catch {
    // Sometimes the model writes a sentence before the JSON. Look for the object.
    const i = limpio.indexOf('{');
    const j = limpio.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      return JSON.parse(limpio.slice(i, j + 1));
    } catch {
      return null;
    }
  }
}

const SISTEMA =
  'You translate short marketplace copy. Reply with JSON only, no explanation, ' +
  'no markdown fence. Keep the exact same JSON shape and the same number of ' +
  'array items you are given. Translate the meaning, not word by word: these ' +
  'are product labels that people choose from, so they must read naturally and ' +
  'stay short. Do not translate brand names, product names or code identifiers.';

/**
 * The already translated phrases, if stored. Calls NOBODY.
 *
 * This is the one the profile uses, which is why it is synchronous: it answers
 * in microseconds and cannot keep whoever requests `/agent.json` waiting.
 */
export function frasesGuardadas(frases: Frases, idioma: Idioma, dir: string): Frases | null {
  return leerGuardado(dir, idioma, huella(frases));
}

/**
 * Requests the translation IN THE BACKGROUND, for next time.
 *
 * Returns nothing and is not awaited: the caller has already served the
 * original profile. If it works it gets stored and the next request in that
 * language finds it done; if it fails nobody notices and it will be retried.
 */
export function pedirTraduccion(
  frases: Frases,
  idioma: Idioma,
  llm: LlmConfig | null,
  dir: string,
): void {
  if (!llm) return;
  if (!frases.description.trim() && frases.tiers.length === 0) return;
  const clave = `${idioma}-${huella(frases)}`;
  if (enCurso.has(clave) || frasesGuardadas(frases, idioma, dir)) return;
  enCurso.add(clave);
  void traducirFrases(frases, idioma, llm, dir).finally(() => enCurso.delete(clave));
}

/**
 * The profile phrases in another language, waiting for the model.
 *
 * Returns `null` when it could not be translated. The profile does NOT call
 * it directly —it uses the pair above—; this one exists for tests and for
 * translating by hand, where the result is actually wanted.
 */
export async function traducirFrases(
  frases: Frases,
  idioma: Idioma,
  llm: LlmConfig | null,
  dir: string,
): Promise<Frases | null> {
  // With nothing to translate, nobody gets bothered.
  if (!frases.description.trim() && frases.tiers.length === 0) return null;

  const h = huella(frases);
  const guardado = leerGuardado(dir, idioma, h);
  if (guardado) return guardado;
  if (!llm) return null;

  try {
    const crudo = await llmChat(
      { ...llm, timeoutMs: ESPERA_MS, maxRetries: REINTENTOS },
      {
        system: SISTEMA,
        user:
          `Translate the values of this JSON into ${NOMBRE_IDIOMA[idioma]}.\n` +
          'Keep the keys in English and the array in the same order.\n\n' +
          JSON.stringify(frases),
      },
    );
    const traducido = validar(comoJson(crudo), frases);
    if (!traducido) return null;
    guardar(dir, idioma, h, traducido);
    return traducido;
  } catch {
    // No key, no quota, no network or the model is down: the original profile.
    return null;
  }
}
