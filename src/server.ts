/**
 * Your agent's engine. You do NOT need to touch this file.
 *
 * It takes care of the three things a Panal agent has to do well and that are
 * easy to get wrong:
 *
 *   1. RECEIVE the brief. The brief does not travel on-chain —only its hash—,
 *      so the client sends it to you signed at `POST /brief`. It checks that
 *      the signature really is theirs and that the task exists and is yours.
 *   2. WORK and DELIVER. It calls your `handleTask()` and anchors the
 *      keccak256 of the result with `deliverResult`. From then on the payment
 *      is yours barring a dispute, and it releases itself after 72 h.
 *   3. SERVE the result. The client downloads it from `GET /result/:id` by
 *      signing, without spending gas.
 *
 * It is reactive on purpose: it does not watch the chain in a loop, it reacts
 * to what comes in. That way it works the same on a regular server as in a
 * container that starts and stops, and uses no RPC when there is no work.
 */

// Load .env BEFORE anything else: without this, the server does not see the
// key the generator left there and dies saying it is missing, with the file
// right in front of it.
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FILE_BYTES,
  appendFilesManifest,
  assertCanServe,
  buildQuote,
  createPanalClient,
  leerNiveles,
  leerNivelesDeMetadata,
  normalizarIdioma,
  resolverLlm,
  LoopDetected,
  MAINNET_ADDRESSES,
  monad,
  matchAttachment,
  nivelPara,
  parseAttachmentsManifest,
  parseEnvelope,
  parsePaymentHeader,
  permitNonce,
  readPermitDomain,
  sanitizeFileName,
  TaskStatus,
  verifyAndSettle,
  type AttachedFile,
  type CallEnvelope,
  type DeliveredFile,
  type FichaNivel,
  type LlmConfig,
  type Nivel,
  type PermitDomain,
} from '@panal/sdk';
import { comoAdjunto } from './salida.js';
import { privateKeyToAccount } from 'viem/accounts';
import { isAddress, keccak256, parseEther, toBytes, verifyMessage } from 'viem';
import type { Address } from 'viem';
import { handleTask, NIVELES, SUBCONTRATA_SKILLS } from './agent.js';
import { frasesGuardadas, pedirTraduccion } from './traduccion.js';
import type { AdjuntoRecibido, NivelPropio, TaskContext, TaskFile, TaskResult } from './agent.js';
import { arrancarVigilante } from './vigilante.js';
import { arrancarRetirada, opcionesDelEntorno } from './retirada.js';
import { arrancarTablon, opcionesDelEntorno as opcionesTablon } from './tablon.js';
import { historialParaElModelo, recordarTurno, type Turno } from './memoria.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? './data';

/**
 * Brief cap, in CHARACTERS, announced in `/agent.json`.
 *
 * It is in characters and not bytes because that is what the client can
 * count before paying: the body cap protects the process, but nobody knows
 * how many kilobytes their text takes. Without a published number, a brief
 * that is too long is discovered BY PAYING —the payment is locked, the agent
 * answers 400, and the client waits for the deadline to get it back.
 *
 * The real limit is set by MAX_BODY; this number sits comfortably below it
 * (32k characters are about 128 KB even in the worst UTF-8 case) so that what
 * is promised always holds, and not only with Latin text.
 */
const MAX_BRIEF_CHARS = 32_000;

// ---------------------------------------------------------------------------
// Tiers: the same job in several sizes.
//
// The agent declares them in `agent.ts` and they are OPTIONAL. With none,
// everything below keeps the usual values and this block does nothing.
//
// They go through `leerNiveles`, which is THE SAME reader the web and the app
// will use when reading the profile. That way an agent cannot publish a tier
// its own clients will discard: if it does not survive here, it is not
// announced.
// ---------------------------------------------------------------------------

let NIVELES_OK = leerNiveles({
  tiers: NIVELES.map((n) => ({ ...n, amountWei: n.wei.toString() })),
});

if (NIVELES.length > 0 && NIVELES_OK.length !== NIVELES.length) {
  console.error(
    `[panal] ${NIVELES.length - NIVELES_OK.length} tier(s) in agent.ts are malformed and will not be announced. ` +
      'Each one needs a positive `wei`.',
  );
}

/** The cheapest tier: below it, an agent with tiers does not work. */
let NIVEL_MINIMO = NIVELES_OK[0] ?? null;

// Printed at startup. They used to show only inside the delegation block
// —which is not printed without a budget—, so an agent with tiers and no
// delegation started without saying a word about what it sells, and the only
// way to know whether they were loaded was to ask for its card.
if (NIVELES_OK.length > 0) {
  console.log(`Tiers (${NIVELES_OK.length}):`);
  for (const n of NIVELES_OK) {
    const topes = [
      n.maxBriefChars === null ? null : `brief ${n.maxBriefChars}`,
      n.maxAttachCharsTotal === null ? null : `attachments ${n.maxAttachCharsTotal}`,
    ].filter(Boolean);
    console.log(`  ${n.name ?? '(no name)'} · ${n.wei} · ${topes.length ? topes.join(', ') : 'default caps'}`);
  }
}

// A tier that spends on delegation as much as it charges works for free, and
// if it spends more, it pays to work. It is not corrected automatically —it is
// the author's decision— but it cannot stay silent.
for (const n of NIVELES) {
  if (n.subcontrata !== undefined && n.subcontrata >= n.wei) {
    console.error(
      `[panal] tier "${n.name}" charges ${n.wei} and may spend ${n.subcontrata} delegating: ` +
        'nothing is left for the work.',
    );
  }
}


/** The brief cap of the largest tier, or the usual one without tiers. */
let TOPE_BRIEF_MAYOR = Math.max(MAX_BRIEF_CHARS, ...NIVELES_OK.map((n) => n.maxBriefChars ?? 0));

/**
 * Request body cap: without it, anyone can take your process down.
 *
 * It comes from the LARGEST tier and not a round number, because promising
 * 320,000 characters and cutting the body at 256 KB is promising something
 * that does not hold. The ×4 is the worst UTF-8 case —a character can take
 * four bytes— and the extra 32 KB cover the rest of the JSON: the signature,
 * the address and the attachments manifest that travels inside the brief.
 */
let MAX_BODY = Math.max(256 * 1024, TOPE_BRIEF_MAYOR * 4 + 32 * 1024);

/**
 * The three numbers above are recomputed when the tiers change.
 *
 * They change because they can now be edited from the web without touching
 * this code: they live in the on-chain `metadataURI` and the agent's owner
 * moves them by signing a transaction. If these numbers kept their startup
 * values, a new 320,000-character tier would be announced and then rejected
 * for exceeding the cap, which is the worst of both: charged and not done.
 */
function recalcularTopes(): void {
  NIVEL_MINIMO = NIVELES_OK[0] ?? null;
  TOPE_BRIEF_MAYOR = Math.max(MAX_BRIEF_CHARS, ...NIVELES_OK.map((n) => n.maxBriefChars ?? 0));
  MAX_BODY = Math.max(256 * 1024, TOPE_BRIEF_MAYOR * 4 + 32 * 1024);
}

/** An already validated tier, in the shape it is announced and returned in. */
function comoFicha(n: Nivel): FichaNivel {
  return {
    ...(n.name === null ? {} : { name: n.name }),
    ...(n.description === null ? {} : { description: n.description }),
    amountWei: n.wei.toString(),
    ...(n.maxBriefChars === null ? {} : { maxBriefChars: n.maxBriefChars }),
    ...(n.maxAttachChars === null ? {} : { maxAttachChars: n.maxAttachChars }),
    ...(n.maxAttachCharsTotal === null ? {} : { maxAttachCharsTotal: n.maxAttachCharsTotal }),
  };
}

/** Which tier whoever locked this bought. `null` if the agent sells no tiers. */
function nivelDe(pagado: bigint): NivelPropio | null {
  if (NIVELES_OK.length === 0) return null;
  const leido = nivelPara(NIVELES_OK, pagado);
  if (!leido) return null;
  // The one declared in `agent.ts` is preferred: it has the types the agent's
  // author expects in `ctx.nivel`, and it is the only one that can carry
  // `subcontrata`, which does not fit in the on-chain profile.
  const propio = NIVELES.find((n) => n.wei === leido.wei);
  if (propio) return propio;
  // And if it comes from the CHAIN, one is built. Returning null here would be
  // the worst possible outcome: the client paid for the big tier, saw it
  // announced, and the agent would work believing they bought none.
  return {
    name: leido.name ?? '',
    ...(leido.description === null ? {} : { description: leido.description }),
    wei: leido.wei,
    ...(leido.maxBriefChars === null ? {} : { maxBriefChars: leido.maxBriefChars }),
    ...(leido.maxAttachChars === null ? {} : { maxAttachChars: leido.maxAttachChars }),
    ...(leido.maxAttachCharsTotal === null ? {} : { maxAttachCharsTotal: leido.maxAttachCharsTotal }),
  };
}

const key = process.env.AGENT_PRIVATE_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('AGENT_PRIVATE_KEY (0x + 64 hex) is missing from .env. Copy .env.example and fill it in.');
  process.exit(1);
}
const account = privateKeyToAccount(key as `0x${string}`);
const panal = createPanalClient({ account, rpcUrl: process.env.RPC_URL });

console.log(`Agent ${account.address} listening on :${PORT}`);

// ---------------------------------------------------------------------------
// The tiers on the CHAIN override those in `agent.ts`.
//
// They can be edited from the web dashboard without touching a line of code:
// they live inside the `metadataURI`, and changing them is a transaction. This
// block reads them and puts them in charge, because they are WHAT THE CLIENT
// SAW: the client picked a size and locked the money against the on-chain
// profile, so working with different ones would mean charging for one thing
// and doing another.
//
// They are re-read periodically, and not only at startup, because the whole
// point of moving them out of the code is not having to restart anything to
// change them. If the read fails, whatever was there stays: a slow RPC cannot
// leave an agent that has tiers without them.
// ---------------------------------------------------------------------------

/** How often the profile is checked again. */
const REFRESCO_NIVELES = 5 * 60 * 1000;

/**
 * The model this agent uses to translate ITS OWN profile for `?lang=`.
 *
 * Resolved once, falling back to `null` instead of crashing startup: an agent
 * without `LLM_API_KEY` is a perfectly valid agent —some agents use no model
 * at all— and being unable to serve the profile for lack of a translation
 * would keep it out of the market over a luxury. No model, original profile.
 */
const LLM_FICHA: LlmConfig | null = (() => {
  try {
    return resolverLlm(process.env);
  } catch {
    return null;
  }
})();

/** Those from `agent.ts`, to fall back on if the profile ends up with no tiers. */
const NIVELES_DEL_CODIGO = NIVELES_OK;

/**
 * The name and description this agent has ON-CHAIN.
 *
 * The template did not have them: its `/agent.json` published endpoints and
 * prices, and the text came only from the registry. They are needed here to
 * serve them TRANSLATED, which is what `?lang=` asks for.
 */
let FICHA_TEXTO: { name: string; description: string } = { name: '', description: '' };

async function refrescarNiveles(): Promise<void> {
  try {
    const ficha = await panal.getAgent(account.address);
    FICHA_TEXTO = {
      name: ficha.metadata.name,
      description: ficha.metadata.description,
    };
    const enCadena = leerNivelesDeMetadata(ficha.metadataURI);
    const antes = NIVELES_OK.map((n) => `${n.wei}:${n.name ?? ''}`).join('|');
    NIVELES_OK = enCadena.length > 0 ? enCadena : NIVELES_DEL_CODIGO;
    const ahora = NIVELES_OK.map((n) => `${n.wei}:${n.name ?? ''}`).join('|');
    if (antes !== ahora) {
      recalcularTopes();
      console.log(
        NIVELES_OK.length > 0
          ? `[panal] tiers updated from the chain (${NIVELES_OK.length}): ` +
              NIVELES_OK.map((n) => `${n.name ?? '?'} ${n.wei}`).join(', ')
          : '[panal] this agent no longer publishes tiers',
      );
    }
  } catch {
    // No RPC, an unreadable profile or the agent not registered yet: whatever
    // was there stays. Silently, because this runs every five minutes and a
    // warning per failure would flood the log of an agent that works.
  }
}

// The first one runs BEFORE listening: `MAX_BODY` comes from the largest
// tier's cap, and starting with the old number would mean announcing a
// 320,000-character brief and cutting it on arrival.
await refrescarNiveles();
setInterval(() => void refrescarNiveles(), REFRESCO_NIVELES).unref();

// ---------------------------------------------------------------------------
// x402: charging per call, without escrow.
//
// The escrow is for jobs worth something: it locks the payment, there is a
// deadline and there are disputes. For a query worth two thousandths all that
// is overkill —the paperwork costs more than the service—, and that is where
// x402 comes in: the client signs a payment authorization (free, no gas), you
// get paid and answer in the same call.
//
// It is OPTIONAL: without X402_PRICE in .env, this route does not exist and
// your agent works the same with escrow jobs only.
//
// It can only charge in an ERC-20 with EIP-2612, not in MON: the whole scheme
// relies on `permit`, and the native currency does not have it.
// ---------------------------------------------------------------------------

const X402_PRICE = (() => {
  const raw = process.env.X402_PRICE?.trim();
  if (!raw) return null;
  try {
    const wei = parseEther(raw);
    return wei > 0n ? wei : null;
  } catch {
    console.error(`X402_PRICE="${raw}" is not a valid number: pay-per-call is disabled.`);
    return null;
  }
})();
const X402_TOKEN: Address = (() => {
  const raw = process.env.X402_TOKEN?.trim();
  return raw && isAddress(raw) ? (raw as Address) : MAINNET_ADDRESSES.panalToken;
})();
const X402_SYMBOL = process.env.X402_SYMBOL?.trim() || '$PANAL';
// In English because it travels in the 402 and is read by a stranger from
// anywhere. Replace it with yours via X402_DESCRIPTION in .env.
const X402_DESCRIPTION = process.env.X402_DESCRIPTION?.trim() || 'One question to the agent, answered on the spot.';

if (X402_PRICE !== null) {
  console.log(`Pay-per-call active: ${process.env.X402_PRICE} ${X402_SYMBOL} at POST /x402/ask`);
}

// ---------------------------------------------------------------------------
// DELEGATION: what your agent may spend asking others
// ---------------------------------------------------------------------------
//
// Your agent can pay another one for what it cannot do (see `ctx.consultar` in
// agent.ts). That is its own money going out, so it needs a cap, and the cap
// is set HERE and not in the prompt: a prompt can be negotiated, a number
// cannot.
//
// It is in the x402 currency —$PANAL by default— and is NOT deducted from
// what you charge for the task. It is tempting to say "spend at most 30% of
// what it gets paid", but a task is paid in MON and a query in $PANAL: they
// are different currencies with no exchange rate, and converting one into the
// other by eye would be making up the budget. If you set nothing, your agent
// does not delegate.
//
//   SUBCONTRATA_MAX=0.5     # at most 0.5 $PANAL per job
//   SUBCONTRATA_SALTOS=2    # how many agents it can chain (hard cap: 8)
//
const SUBCONTRATA_MAX = (() => {
  const raw = process.env.SUBCONTRATA_MAX?.trim();
  if (!raw) return 0n;
  try {
    const wei = parseEther(raw);
    return wei > 0n ? wei : 0n;
  } catch {
    console.error(`SUBCONTRATA_MAX="${raw}" is not a valid number: your agent will not delegate.`);
    return 0n;
  }
})();
const SUBCONTRATA_SALTOS = (() => {
  const n = Number(process.env.SUBCONTRATA_SALTOS?.trim() || '2');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
})();

if (SUBCONTRATA_MAX > 0n) {
  // The REAL state is reported, not just the money. Having a budget used to be
  // enough; now both are needed, and a log saying "active" with an empty list
  // would cost an afternoon to whoever wonders why their agent never
  // delegates.
  if (SUBCONTRATA_SKILLS.length > 0) {
    console.log(
      `Delegation active: up to ${process.env.SUBCONTRATA_MAX} ${X402_SYMBOL} per job, ` +
        `and only for: ${SUBCONTRATA_SKILLS.join(', ')}`,
    );
  } else {
    console.log(
      `Delegation has a budget (${process.env.SUBCONTRATA_MAX} ${X402_SYMBOL}) but NO allowed ` +
        'skills: it will not delegate. Fill in SUBCONTRATA_SKILLS in agent.ts.',
    );
  }

  // What you get paid for a query is the ceiling of what you can spend on it.
  // With SUBCONTRATA_MAX equal to or above X402_PRICE, a job you delegate
  // leaves you at zero or at a loss, and you pay the gas on top. The bad part
  // of that setting is that it punishes exactly what you want it to do: the
  // better your agent recognizes what it does not know, the more often it
  // works for free.
  //
  // It is not corrected automatically —it is your price and your decision—
  // but it is said, because the symptom is a balance that does not grow and
  // that looks nothing like the cause.
  if (X402_PRICE !== null && SUBCONTRATA_MAX >= X402_PRICE) {
    console.warn(
      `[panal] SUBCONTRATA_MAX (${process.env.SUBCONTRATA_MAX}) is not lower than X402_PRICE ` +
        `(${process.env.X402_PRICE}) ${X402_SYMBOL}: every query you delegate leaves you with no ` +
        `margin, or at a loss counting gas. Set it to a fraction of what you charge.`,
    );
  }
}

/**
 * The token's EIP-712 domain, read from the chain only once.
 *
 * Cached because it never changes and reading it on every request adds an RPC
 * call to the path of an answer you charge for on the spot. If the RPC fails,
 * it is retried on the next one: the error is not cached.
 */
let dominioCache: PermitDomain | null = null;
async function dominioPermit(): Promise<PermitDomain> {
  if (!dominioCache) dominioCache = await readPermitDomain(panal.publicClient, X402_TOKEN);
  return dominioCache;
}

// ---------------------------------------------------------------------------
// Storage: results on disk, so they can be served later.
// ---------------------------------------------------------------------------

mkdirSync(DATA_DIR, { recursive: true });
const resultPath = (taskId: bigint) => join(DATA_DIR, `result-${taskId}.txt`);
/** Folder for a task's files. One per task, so they do not mix. */
const filesDir = (taskId: bigint) => join(DATA_DIR, 'files', taskId.toString());
/**
 * Folder for what the client SENDS, kept apart from what the agent delivers.
 *
 * Mixing them would mean serving via `/files/:id/:name` a file the client
 * uploaded as if it were part of the delivery, hash anchored and all. It is
 * not: they are the two directions of the same mechanism and never touch.
 */
const inboxDir = (taskId: bigint) => join(DATA_DIR, 'inbox', taskId.toString());

function saveResult(taskId: bigint, text: string): void {
  writeFileSync(resultPath(taskId), text, 'utf8');
}
function loadResult(taskId: bigint): string | null {
  try {
    return readFileSync(resultPath(taskId), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The received brief, saved as soon as it arrives and before working.
 *
 * It is not a cache: it is the only thing that allows resuming a task if the
 * process dies halfway. The escrow stores `keccak256(brief)`, not the brief,
 * so if you do not save it here, a restart loses it forever and the task stays
 * open with the client's money inside until the deadline expires.
 */
const briefPath = (taskId: bigint) => join(DATA_DIR, `brief-${taskId}.txt`);
function saveBrief(taskId: bigint, text: string): void {
  try {
    writeFileSync(briefPath(taskId), text, 'utf8');
  } catch (err) {
    // Not aborted: losing the copy only costs being unable to resume. Working
    // right now is still possible, and it is what the client is waiting for.
    console.error(`[panal] #${taskId} could not save the brief: ${err instanceof Error ? err.message : err}`);
  }
}
function loadBrief(taskId: bigint): string | null {
  try {
    return readFileSync(briefPath(taskId), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Saves a delivery's files to disk and returns their manifest.
 *
 * The name is cleaned with `sanitizeFileName` BEFORE touching the disk: it
 * comes in what `handleTask` returns, and an agent that builds the name from
 * the client's brief would be letting a stranger choose where to write. A
 * `../../.env` would end up at the project root.
 */
function saveFiles(taskId: bigint, files: TaskFile[]): DeliveredFile[] {
  const dir = filesDir(taskId);
  mkdirSync(dir, { recursive: true });

  return files.map((f) => {
    const name = sanitizeFileName(f.name);
    const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : new Uint8Array(f.data);
    writeFileSync(join(dir, name), bytes);
    return {
      name,
      size: bytes.byteLength,
      ...(f.mime ? { mime: f.mime } : {}),
      // The hash of the BYTES, not the link: it is the only thing that survives
      // someone changing the file after getting paid.
      hash: keccak256(bytes),
      path: `/files/${taskId}/${encodeURIComponent(name)}`,
    };
  });
}

/**
 * Normalizes what `handleTask` returned into a single shape.
 *
 * A bare string is accepted because that is what 95% of agents return, and
 * forcing them to wrap it in an object would charge them the complexity of a
 * feature they do not use.
 */
function normalizarSalida(salida: TaskResult): { text: string; files: TaskFile[] } {
  if (typeof salida === 'string') return { text: salida, files: [] };
  return { text: salida.text, files: salida.files ?? [] };
}

// ---------------------------------------------------------------------------
// Attachments: what the client sends WITH the brief
// ---------------------------------------------------------------------------
//
// The brief is sealed when hiring —the escrow anchors its keccak256 and below
// any text that does not hash to it is rejected—, so a photo cannot travel
// inside it. What travels inside is its HASH, announced in a
// `[panal-attach/1]` block. The bytes are uploaded later, via
// `POST /upload/:taskId`.
//
// Hence the only rule to remember here: ONLY WHAT THE BRIEF ANNOUNCED IS
// WRITTEN. Any other byte is rejected before reaching the disk. A task number
// is public, and without that guard your agent would be free storage for
// anyone who can count.

const adjuntoPath = (taskId: bigint, nombre: string) => join(inboxDir(taskId), nombre);

/**
 * Checks which announced attachments are already on disk and which are missing.
 *
 * The hash is checked WHEN READING and not only when writing. Between the two
 * there is a disk, sometimes a restart and sometimes a remounted volume; and a
 * job done from a corrupt file is worse than a job not done, because it gets
 * delivered and anchored.
 */
function repasarAdjuntos(
  taskId: bigint,
  brief: string,
): { recibidos: AdjuntoRecibido[]; faltan: AttachedFile[] } {
  const recibidos: AdjuntoRecibido[] = [];
  const faltan: AttachedFile[] = [];

  for (const anunciado of parseAttachmentsManifest(brief)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(adjuntoPath(taskId, anunciado.name));
    } catch {
      faltan.push(anunciado);
      continue;
    }
    if (!matchAttachment([anunciado], bytes, anunciado.name)) {
      console.error(`[panal] #${taskId} attachment "${anunciado.name}" on disk does not match its hash: requesting it again`);
      faltan.push(anunciado);
      continue;
    }
    recibidos.push({
      name: anunciado.name,
      ...(anunciado.mime ? { mime: anunciado.mime } : {}),
      bytes: new Uint8Array(bytes),
    });
  }
  return { recibidos, faltan };
}

/** Writes an already verified attachment. */
function guardarAdjunto(taskId: bigint, nombre: string, bytes: Uint8Array): void {
  mkdirSync(inboxDir(taskId), { recursive: true });
  writeFileSync(adjuntoPath(taskId, nombre), bytes);
}

/**
 * The envelope of a task waiting for attachments.
 *
 * When the brief comes from another agent and carries attachments, there is a
 * stretch between the brief and the last upload when no work can be done. The
 * envelope carries the budget and the call-chain path, and losing it would
 * mean resuming without them. In memory on purpose: if the process dies, the
 * chain that brought it died with it, and resuming without an envelope is
 * exactly what the watchdog does.
 */
const sobrePendiente = new Map<string, CallEnvelope>();

/** Tasks being processed right now: prevents working twice. */
const inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Signatures: the client proves who they are without spending gas (EIP-191).
// The messages must match the dashboard's EXACTLY, so they stay in Spanish:
// they are part of the Panal protocol.
// ---------------------------------------------------------------------------

const briefSignMessage = (taskId: bigint) => `Panal brief #${taskId}`;
/** OLD format, no expiry. Still accepted; see `credencialValida`. */
const resultSignMessageLegacy = (taskId: bigint) => `Panal resultado #${taskId}`;
/** Current format: the signature states until when it is valid. */
const resultSignMessage = (taskId: bigint, expira: number) => `Panal resultado #${taskId} · ${expira}`;

/**
 * The longest a download signature can last.
 *
 * The client picks when theirs expires and this cap bounds what is accepted:
 * without it, signing one valid until the year 2100 would be the same as not
 * expiring.
 */
const MAX_VENTANA_S = 15 * 60;

/** Rejects the old format (no expiry). Set it to 1 when you can. */
const AUTH_ESTRICTA = process.env.AUTH_ESTRICTA === '1';

async function signedBy(message: string, signature: string, expected: Address): Promise<boolean> {
  try {
    return await verifyMessage({ address: expected, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

/**
 * A download's credentials: where they are read from and whether they are valid.
 *
 * THEY ARE READ FROM THE HEADERS, not the query. The signature unlocks the
 * result and ALL of a task's files, so it is an access pass — and in the query
 * it ended up written in the proxy's access log, in the browser history and in
 * any intermediary along the way. 23 were found in plain text in a production
 * log. A pass that gets logged to a text file is not a pass.
 *
 * The query is still read because clients published before this use it, and
 * breaking their downloads fixes nothing. But it warns.
 */
function credencialesDe(
  req: IncomingMessage,
  url: URL,
): { address: string | null; signature: string | null; expira: string | null; porQuery: boolean } {
  const cabecera = (n: string): string | null => {
    const v = req.headers[n];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const address = cabecera('x-panal-address');
  const signature = cabecera('x-panal-signature');
  if (address && signature) {
    return { address, signature, expira: cabecera('x-panal-expira'), porQuery: false };
  }
  return {
    address: url.searchParams.get('address'),
    signature: url.searchParams.get('signature'),
    expira: url.searchParams.get('expira'),
    porQuery: true,
  };
}

/**
 * Does the signature unlock this task?
 *
 * The expiry is SENT by the client and is part of what is signed, so it cannot
 * be stretched: changing the number invalidates the signature. Sending it in
 * the clear gives nothing away and avoids what would be a problem — guessing
 * it by trying second by second means hundreds of signature verifications per
 * request, i.e. a self-inflicted denial of service.
 */
/** One warning per task: repeating it for every file would flood the log. */
const avisadasPorQuery = new Set<string>();
function avisaQuery(taskId: bigint): void {
  const k = taskId.toString();
  if (avisadasPorQuery.has(k)) return;
  avisadasPorQuery.add(k);
  console.error(
    `[panal] #${taskId} credentials via QUERY STRING. They end up in the proxy access log ` +
      'and in the browser history. Update the client: they belong in headers.',
  );
}

async function credencialValida(
  taskId: bigint,
  signature: string,
  expiraCrudo: string | null,
  cliente: Address,
): Promise<boolean> {
  const ahora = Math.floor(Date.now() / 1000);

  if (expiraCrudo !== null) {
    const expira = Number(expiraCrudo);
    if (!Number.isInteger(expira)) return false;
    // Neither expired nor valid for a year: the cap is what stops a leaked
    // signature from being valid forever, which is the point of all this.
    if (expira <= ahora || expira > ahora + MAX_VENTANA_S) return false;
    return signedBy(resultSignMessage(taskId, expira), signature, cliente);
  }

  // No expiry: old format. Accepted so as not to break already published
  // clients, with a warning on every use.
  if (AUTH_ESTRICTA) return false;
  if (await signedBy(resultSignMessageLegacy(taskId), signature, cliente)) {
    console.error(
      `[panal] #${taskId} download with a NON-EXPIRING signature (old format). ` +
        'Update the client; with AUTH_ESTRICTA=1 this is rejected.',
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

/**
 * Builds the context your `handleTask` receives, including the ability to
 * delegate.
 *
 * `consultar` is what turns your agent into another agent's client: it
 * searches the market for who can do that, asks the candidates for a price
 * —free, via the 402—, keeps the cheapest that fits the budget, pays it and
 * returns its answer.
 *
 * The three limits apply before signing any payment:
 *
 *   - BUDGET. Never more than SUBCONTRATA_MAX, and if this call comes from
 *     another agent, never more than what is left in the envelope. Inheriting a
 *     chain cannot WIDEN what whoever started it authorized.
 *   - DEPTH. Each hop uses one. At zero it has to solve it alone.
 *   - CYCLES. If your agent already appears on the path, it stops: A→B→C→A
 *     would go round charging on every lap.
 *
 * If any of that is missing, `consultar` throws. Do not swallow it silently:
 * your agent delivering something worse because it could not delegate is
 * information the author needs to see in the logs.
 */
function contexto(
  base: {
    taskId: bigint | null;
    client: string;
    amount: bigint;
    deadline: bigint;
    adjuntos: AdjuntoRecibido[];
    historial: Turno[];
  },
  sobre: CallEnvelope | null,
): TaskContext {
  // Resolved here and not in each caller so there are not two ways of deciding
  // it. In x402 it is ALWAYS null: there is no escrow, and the amount of a
  // one-off call does not buy a job tier.
  const nivel = base.taskId === null ? null : nivelDe(base.amount);

  // The purchased tier's budget, and if the tier says nothing, the one from
  // .env. That way the expensive tier can buy help and the cheap one cannot,
  // without an agent with no tiers noticing any change.
  const presupuesto = nivel?.subcontrata ?? SUBCONTRATA_MAX;

  return {
    ...base,
    nivel,
    envelope: sobre,
    presupuesto,
    consultar: async (skill: string, pregunta: string) => {
      if (presupuesto <= 0n) {
        throw new Error(
          nivel
            ? `Tier "${nivel.name}" has no delegation budget: give it \`subcontrata\` in agent.ts.`
            : 'This agent has no delegation budget: set SUBCONTRATA_MAX in .env if you want it to delegate.',
        );
      }
      // Money AND permission. Without a list nothing is bought, even with
      // money: the search generalizes when it finds nobody, and without a list
      // that generalization has nowhere to stop.
      if (SUBCONTRATA_SKILLS.length === 0) {
        throw new Error(
          'This agent has no allowed skills: fill in SUBCONTRATA_SKILLS in agent.ts if you want it to delegate.',
        );
      }
      const res = await panal.ask(skill, pregunta, {
        maxSpend: presupuesto,
        skillsPermitidas: SUBCONTRATA_SKILLS,
        depth: SUBCONTRATA_SALTOS,
        // The received envelope, if any. Without it a new chain is opened.
        envelope: sobre,
        // Without this an agent looking for its own skill would hire itself,
        // pay itself and sit waiting for its own answer.
        exclude: [account.address],
      });
      console.log(
        `[panal] query to ${res.agent} for ${res.paid} (${skill}) · trace ${sobre?.trace ?? 'new'}`,
      );
      return res.answer;
    },
  };
}

/**
 * How an attempt to work a task ended.
 *
 * It exists because `work()` cannot throw —an HTTP route calls it too, and a
 * broken task must not take down the watchdog's round— and yet the watchdog
 * NEEDS to tell the difference. It used to be unable to: a model returning
 * 429 twice in a row and a perfect delivery looked the same from outside, so
 * the task was taken as resolved and no longer watched. It happened with #55.
 *
 * `esperando` (waiting) is neither a failure nor a success, which is why
 * rethrowing the error was not enough: a task missing attachments leaves here
 * with no error and without having been delivered.
 */
export type ResultadoTrabajo = 'entregada' | 'esperando' | 'fallo' | 'en-curso';

async function work(
  taskId: bigint,
  brief: string,
  sobre: CallEnvelope | null,
): Promise<ResultadoTrabajo> {
  const key = taskId.toString();
  if (inFlight.has(key)) return 'en-curso';
  inFlight.add(key);
  try {
    // FIRST, before working: if the process dies halfway, this is the only
    // thing that allows resuming. Saving it afterwards would mean never.
    saveBrief(taskId, brief);

    // If the brief announces attachments, nothing starts until all are here.
    //
    // The guard goes HERE and not in the HTTP route because the watchdog also
    // calls `work` —when resuming a task after a restart— and there is no
    // request to look at there. Without this, an agent restarting between the
    // brief and the upload would start working without the photo, deliver
    // what it could and anchor that half-done result on-chain.
    const { recibidos, faltan } = repasarAdjuntos(taskId, brief);
    if (faltan.length > 0) {
      console.log(
        `[panal] #${taskId} waiting for ${faltan.length} attachment(s): ${faltan.map((f) => f.name).join(', ')}`,
      );
      // Clean exit, not delivered. The watchdog has to see it exactly so:
      // treating it as resolved, a task whose attachment arrives after a
      // restart stayed waiting forever with nobody looking at it again.
      return 'esperando';
    }
    if (recibidos.length > 0) console.log(`[panal] #${taskId} with ${recibidos.length} attachment(s) from the client`);

    const task = await leerTarea(taskId);
    const salida = await handleTask(
      brief,
      contexto(
        {
          taskId,
          client: task.client,
          amount: task.amount,
          deadline: task.deadline,
          adjuntos: recibidos,
          // An escrow job carries no conversation: it is paid, delivered once
          // and approved. Memory is for chats.
          historial: [],
        },
        sobre,
      ),
    );

    // Your handleTask can return a bare text —the usual— or a text with
    // files. The files are written to disk and their hash slips into the
    // text: what gets anchored on-chain then covers them too.
    const { text: cuerpo, files } = normalizarSalida(salida);
    const text = files.length ? appendFilesManifest(cuerpo, saveFiles(taskId, files)) : cuerpo;

    // Save first, then deliver: if the order were reversed and the process
    // died in between, the hash would be anchored on-chain and the text lost,
    // i.e. a delivery impossible to fulfil.
    saveResult(taskId, text);
    const { txHash } = await panal.deliverResult(taskId, text);
    console.log(`[panal] #${taskId} delivered · tx ${txHash}`);
    return 'entregada';
  } catch (err) {
    console.error(`[panal] #${taskId} failed: ${err instanceof Error ? err.message : err}`);
    return 'fallo';
  } finally {
    inFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Manual resend page (GET /reenviar?task=<id>).
 *
 * Everything is inline: no CDN, no fonts, no libraries. Inside a wallet's
 * browser, every external resource is one more thing that may fail to load,
 * and this page exists precisely for when something has already failed.
 */
const PAGINA_REENVIO = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resend brief · Panal</title>
<style>
:root{color-scheme:dark light}
body{margin:0;padding:24px 18px;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#0f0f11;color:#e8e8ea;max-width:34rem;margin-inline:auto}
h1{font-size:1.25rem;margin:0 0 .25rem}
p.sub{margin:0 0 1.5rem;color:#9a9aa2;font-size:.9rem}
label{display:block;margin:1rem 0 .35rem;font-size:.85rem;color:#b8b8c0}
input,textarea{width:100%;box-sizing:border-box;padding:.7rem .8rem;border-radius:10px;border:1px solid #33333a;background:#17171b;color:inherit;font:inherit}
textarea{min-height:9rem;resize:vertical}
button{width:100%;margin-top:1rem;padding:.85rem;border:0;border-radius:10px;background:#f5c518;color:#1a1a1a;font:600 1rem system-ui;cursor:pointer}
button.sec{background:#26262c;color:#e8e8ea}
#estado{margin-top:1.1rem;padding:.8rem;border-radius:10px;font-size:.9rem;white-space:pre-wrap;word-break:break-word}
#estado.bien{background:#12301c;color:#7ee2a8}
#estado.mal{background:#33161a;color:#ff9d9d}
#estado:empty{display:none}
</style></head><body>
<h1>Resend the brief</h1>
<p class="sub">For when the automatic send did not arrive. Copy the exact order text from panal.lat (the "Copy order brief" button) and paste it here.</p>
<label for="id">Task number</label>
<input id="id" inputmode="numeric" placeholder="24">
<label for="brief">Order text</label>
<textarea id="brief" placeholder="Paste the brief here, exactly as is"></textarea>
<button id="conectar" class="sec">Connect wallet</button>
<button id="enviar">Sign and send</button>
<div id="estado"></div>
<script>
var q = new URLSearchParams(location.search);
function $(s){ return document.querySelector(s); }
// Digits only, always. A phone keyboard slips in a dot without you seeing it
// and the request goes to /brief/25. → 404, with the user looking at a number
// that seems right.
function soloDigitos(v){ return String(v || '').replace(/[^0-9]/g, ''); }
$('#id').value = soloDigitos(q.get('task'));
$('#id').addEventListener('input', function(){ this.value = soloDigitos(this.value); });
var cuenta = null;
function estado(msg, mal){ var e = $('#estado'); e.textContent = msg; e.className = mal ? 'mal' : 'bien'; }
$('#conectar').onclick = async function(){
  if (!window.ethereum) { estado('No wallet here. Open this page from the MetaMask browser, not from Chrome.', true); return; }
  try {
    var r = await ethereum.request({ method: 'eth_requestAccounts' });
    cuenta = r[0];
    $('#conectar').textContent = cuenta.slice(0,6) + '…' + cuenta.slice(-4);
    estado('Wallet connected.');
  } catch (e) { estado('Connection rejected.', true); }
};
$('#enviar').onclick = async function(){
  var id = soloDigitos($('#id').value);
  var brief = $('#brief').value;
  if (!id || !brief.trim()) { estado('The task number or the text is missing.', true); return; }
  if (!cuenta) { estado('Connect the wallet first: you must sign with the same one that paid.', true); return; }
  try {
    estado('Sign the message in your wallet. It costs no gas.');
    var firma = await ethereum.request({ method: 'personal_sign', params: ['Panal brief #' + id, cuenta] });
    estado('Sending…');
    var res = await fetch('/brief/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: brief, address: cuenta, signature: firma })
    });
    var txt = await res.text();
    if (res.ok) estado('Accepted. The agent is already working on your order.');
    else estado('Rejected (' + res.status + '):\\n' + txt, true);
  } catch (e) { estado('Failed: ' + (e && e.message ? e.message : e), true); }
};
</script></body></html>`;

/**
 * The routes your logo is requested by and the files it is looked for in.
 *
 * Order matters: if you have both a `logo.png` and a `logo.svg`, the SVG wins,
 * since it is the one the generator writes and it scales to any size.
 */
const RUTA_LOGO = /^\/logo(\.(svg|png|webp|jpe?g|gif))?$/;

const LOGOS: [string, string][] = [
  ['logo.svg', 'image/svg+xml; charset=utf-8'],
  ['logo.png', 'image/png'],
  ['logo.webp', 'image/webp'],
  ['logo.jpg', 'image/jpeg'],
  ['logo.jpeg', 'image/jpeg'],
  ['logo.gif', 'image/gif'],
];

/**
 * Your project folder: this file lives in `src/`, so it goes up one level.
 *
 * Computed from the module and not the working directory because they are not
 * the same when someone starts the agent without `npm start`: a `systemd` unit
 * without `WorkingDirectory=`, or a Docker image with another `WORKDIR`. And
 * that case does NOT fail loudly —the key may come from a real environment
 * variable instead of `.env`— so the agent works anyway and the only effect is
 * that its logo returns 404 and never gets published. Silently.
 */
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The first logo that exists, or null if you publish none.
 *
 * It looks first next to the project and then in the working directory. The
 * fallback stays on purpose: if someone puts their logo there —which is what
 * used to be needed— it keeps working the same.
 *
 * It is read on every request and not cached in memory on purpose: changing
 * the logo means dropping a file, and having to restart the agent —cutting
 * jobs in progress— to change an image would be an absurd price. Clients
 * already cache it for an hour via the header.
 */
function buscaLogo(): { bytes: Buffer; tipo: string } | null {
  for (const carpeta of [RAIZ, '.']) {
    for (const [archivo, tipo] of LOGOS) {
      try {
        return { bytes: readFileSync(join(carpeta, archivo)), tipo };
      } catch {
        // Not there: try the next format.
      }
    }
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * The raw body, with its own cap.
 *
 * Kept apart from `readBody` on purpose: MAX_BODY protects the text routes and
 * is computed to fit them exactly —what the largest tier asks for today and
 * not a byte more—. A photo does not fit there, and raising the cap on every
 * route to make it fit would open the door that limit closes.
 */
async function readBodyBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new Error(`body too large (cap ${max} bytes)`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Withstanding noise: request limit and task cache
// ---------------------------------------------------------------------------
//
// Every request to /result, /files or /brief costs an RPC call BEFORE anything
// can be verified — the task has to be read to know who its client is. The
// public RPC is limited to ~15 calls/s, so an unauthenticated curl loop used
// up that quota and left the agent unable to deliver its real work, with
// legitimate clients' money locked until the deadline expired.

/** Requests per minute per IP. 0 disables it. */
const LIMITE_POR_MINUTO = (() => {
  const n = Number(process.env.LIMITE_POR_MINUTO?.trim() || '60');
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
})();

/**
 * Trust `x-forwarded-for`. Only with a proxy in front (Caddy, nginx).
 *
 * Off by default on purpose: trusting it without a proxy lets anyone send that
 * header with a made-up IP per request, and the limit stops existing.
 */
const TRAS_PROXY = process.env.TRAS_PROXY === '1';

const cubos = new Map<string, { n: number; hasta: number }>();

/**
 * Warned once, not on every request: this is a setting to fix, not an event
 * to count.
 */
let avisadoDelProxy = false;

function ipDe(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (TRAS_PROXY) {
    const primera = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (primera) return primera;
  } else if (xff && !avisadoDelProxy) {
    // `x-forwarded-for` arrives and we do not trust it: there is a proxy in
    // front and this agent does not know. Not a detail — ALL requests arrive
    // with the proxy's IP, so the "per client" limit becomes a GLOBAL one: the
    // indexer, a browser and a client's brief share the same bucket, and when
    // it fills up the agent answers 429 to everyone. A client trying to send
    // their brief gets hit, and since the payment is already locked, they are
    // left waiting for the deadline. It really happened, on mainnet.
    avisadoDelProxy = true;
    console.warn(
      '[panal] x-forwarded-for is arriving but TRAS_PROXY is not 1: there is a proxy ' +
        'in front and the per-IP limit is counting ALL clients in the same ' +
        'bucket. Set TRAS_PROXY=1 in .env and restart. If there is NO proxy in front, ' +
        'leave it off: trusting that header without a proxy lets anyone make up ' +
        'an IP per request and the limit stops existing.',
    );
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** true if it must be rejected. A fixed one-minute window, plenty here. */
function pasaDelLimite(req: IncomingMessage): boolean {
  if (LIMITE_POR_MINUTO === 0) return false;
  const ahora = Date.now();
  const ip = ipDe(req);
  const cubo = cubos.get(ip);
  if (!cubo || cubo.hasta <= ahora) {
    // Cleaned here and not with a timer: without this the map grows without
    // end with a different IP per request, which is its own way of crashing.
    if (cubos.size > 10_000) for (const [k, v] of cubos) if (v.hasta <= ahora) cubos.delete(k);
    cubos.set(ip, { n: 1, hasta: ahora + 60_000 });
    return false;
  }
  cubo.n += 1;
  return cubo.n > LIMITE_POR_MINUTO;
}

/**
 * The task, cached for a few seconds.
 *
 * Only for READ routes (/result, /files), and only its `client` is used, which
 * never changes. The brief path does NOT use it: there the status and hash are
 * checked, and serving a five-second-old status could accept a brief for a
 * task that just closed.
 *
 * Besides withstanding noise, it saves the obvious: downloading four files of
 * a delivery used to make four identical reads of the same task.
 */
const CACHE_TAREA_MS = 5_000;
const tareasCache = new Map<string, { cliente: Address; hasta: number }>();

/**
 * The task exists on-chain, but the node we query does not see it yet.
 *
 * It is NOT the agent's or the client's fault, which is why it has its own
 * type: the caller needs to tell "not yet" from "something broke", two things
 * with opposite reactions —one is retried, the other is not.
 */
class TareaAunNoVisible extends Error {
  constructor(readonly taskId: bigint) {
    super(`task #${taskId} is not visible on this RPC node yet`);
    this.name = 'TareaAunNoVisible';
  }
}

/**
 * Is this failure "that task does not exist (yet)"?
 *
 * `tasks` is a public array, so its getter can only revert on an out-of-range
 * index. Any other failure —RPC down, timeout, network— looks different and is
 * NOT disguised as this: swallowing it would hide a real fault.
 */
function pareceInexistente(err: unknown): boolean {
  const m = err instanceof Error ? `${err.message}` : String(err);
  return /revert|out-of-bounds|out of bounds|0x32/i.test(m);
}

/**
 * Reads the task, tolerating lag between nodes.
 *
 * WHY IT EXISTS. The client mines `createTask` against THEIR RPC and, as soon
 * as they have the receipt, sends us the brief. We validate by reading the task
 * against OURS, which is another node and may be one block behind: for it the
 * task does not exist yet, the getter reverts and the send failed with a 500.
 * The client saw "could not send the brief" and had to retry by hand, with
 * their money already locked. It failed the first time and worked the second,
 * which is the signature of a race, not a fault.
 *
 * Four attempts with growing waits comfortably cover a Monad block (~800 ms)
 * without punishing the shared RPC.
 */
async function leerTarea(taskId: bigint): ReturnType<typeof panal.getTask> {
  for (let intento = 1; intento <= 4; intento++) {
    try {
      return await panal.getTask(taskId);
    } catch (err) {
      if (!pareceInexistente(err)) throw err;
      if (intento === 4) break;
      await new Promise((r) => setTimeout(r, 250 * intento));
    }
  }
  throw new TareaAunNoVisible(taskId);
}

async function clienteDeTarea(taskId: bigint): Promise<Address> {
  const k = taskId.toString();
  const ahora = Date.now();
  const cacheada = tareasCache.get(k);
  if (cacheada && cacheada.hasta > ahora) return cacheada.cliente;
  const task = await leerTarea(taskId);
  if (tareasCache.size > 1_000) for (const [kk, v] of tareasCache) if (v.hasta <= ahora) tareasCache.delete(kk);
  tareasCache.set(k, { cliente: task.client, hasta: ahora + CACHE_TAREA_MS });
  return task.client;
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (pasaDelLimite(req)) {
      res.setHeader('retry-after', '60');
      json(res, 429, { error: 'too many requests' });
      return;
    }

    // The dashboard lives on another domain: without CORS the client can
    // neither send you the brief nor download their result.
    res.setHeader('access-control-allow-origin', 'https://panal.lat');
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      // Credentials go in custom headers, and those are NOT simple: without
      // declaring them here the browser blocks the download at preflight.
      //
      // Every new header has to be added TO THIS LIST. It was forgotten with
      // `x-panal-filename` when attachments were added, and the effect is one
      // you cannot see reading the code: the server is fine, the route is
      // fine, and the browser refuses to make the request without leaving a
      // trace in the agent's log.
      res.setHeader(
        'access-control-allow-headers',
        'content-type, x-panal-address, x-panal-signature, x-panal-expira, x-panal-filename, x-payment, x-payment-payer',
      );
      res.setHeader('access-control-max-age', '86400');
      res.writeHead(204).end();
      return;
    }

    // ---- Your logo, if you set one ---------------------------------------------
    //
    // A `logo.svg` file —or `logo.png`, or `logo.webp`— next to package.json
    // and that is it. The generator leaves one with your agent's initial, so
    // you do not appear faceless from minute one: overwrite it with yours and
    // there is nothing else to touch.
    //
    // The registry stores the URL, so the image has to live somewhere; and the
    // natural place is the same domain you already serve, because it is the
    // one the chain already says is yours.
    //
    // IT ANSWERS `/logo` AND ANY EXTENSION, and serves whichever file you
    // really have, whatever extension is asked for. It sounds sloppy and is
    // not: already registered agents published `…/logo.svg` and that URL is
    // written on-chain, so changing format cannot force them to pay for
    // another transaction. What decides how an image is drawn is the
    // `content-type`, not the URL's extension.
    //
    // Served with open CORS on purpose: it is a public image that will be
    // drawn on other people's storefronts, and without the header a `<canvas>`
    // that touches it to make a thumbnail stays dark.
    if (RUTA_LOGO.test(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const logo = buscaLogo();
      if (!logo) {
        json(res, 404, { error: 'this agent publishes no logo' });
        return;
      }
      res.writeHead(200, {
        'content-type': logo.tipo,
        'content-length': logo.bytes.byteLength,
        'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : logo.bytes);
      return;
    }

    // Business card: who you are and what you can do.
    //
    // If you charge per call it has to be ANNOUNCED here. For months the
    // LexPanal bot had x402 working and nobody used it, simply because it did
    // not show on its card: a payment nobody can discover does not exist.
    if (url.pathname === '/agent.json' && req.method === 'GET') {
      const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
      /**
       * `?lang=fr`: the same profile with the phrases in French.
       *
       * WITHOUT WAITING. If the language is already translated it is served
       * translated; if not, the original is served and the translation is
       * ordered in the background for next time. Translating in here rules out
       * retries —nobody waits for a model with a blank card— and without
       * retries a passing 429 left that language untranslated forever.
       */
      const idioma = normalizarIdioma(url.searchParams.get('lang'));
      const nivelesFicha = NIVELES_OK.map(comoFicha);
      let descripcion = FICHA_TEXTO.description;
      /**
       * Which language is being served, and `null` if it is the original.
       *
       * It has to be SAID, not left to guess. Since the translation runs in the
       * background, asking for `?lang=fr` before it is ready returns the
       * original profile with a spotless 200: whoever stores it —the indexer
       * does— keeps the English text believing it is the French, and since it
       * got all ten languages it considers the job done and never comes back.
       * It happened on mainnet: nine out of ten catalogue "translations" were
       * the original.
       */
      let servidoEn: string | null = null;
      if (idioma) {
        const frases = {
          description: descripcion,
          tiers: NIVELES_OK.map((n) => ({ name: n.name ?? '', description: n.description ?? '' })),
        };
        const traducido = frasesGuardadas(frases, idioma, DATA_DIR);
        if (!traducido) pedirTraduccion(frases, idioma, LLM_FICHA, DATA_DIR);
        if (traducido) {
          servidoEn = idioma;
          descripcion = traducido.description;
          traducido.tiers.forEach((t, i) => {
            const destino = nivelesFicha[i];
            // Only what was already there gets overwritten: a tier without a
            // name does not gain one by going through the translator, and one
            // with a name does not lose it.
            if (!destino) return;
            if (destino.name && t.name) destino.name = t.name;
            if (destino.description && t.description) destino.description = t.description;
          });
        }
      }
      const x402 =
        X402_PRICE !== null
          ? {
              method: 'POST' as const,
              path: '/x402/ask',
              ...(base ? { url: `${base}/x402/ask` } : {}),
              scheme: 'eip2612-permit',
              asset: X402_TOKEN,
              assetSymbol: X402_SYMBOL,
              amount: X402_PRICE.toString(),
              payTo: account.address,
              howTo: 'POST {"prompt":"…"} and you get a 402 with the quote. Sign it and repeat with X-Payment.',
            }
          : null;

      json(res, 200, {
        agent: account.address,
        protocol: 'panal',
        network: 'monad-mainnet',
        chainId: monad.id,
        // The name is NEVER translated: "LexPanal" means nothing in French and
        // translating it would invent another name for this agent.
        ...(FICHA_TEXTO.name ? { name: FICHA_TEXTO.name } : {}),
        ...(descripcion ? { description: descripcion } : {}),
        // Only when it really was translated. Absent = this is in the language
        // its owner wrote it in, even if you asked for another.
        ...(servidoEn ? { lang: servidoEn } : {}),
        endpoints: {
          base,
          postBrief: {
            method: 'POST',
            path: '/brief/:taskId',
            signMessage: 'Panal brief #<taskId>  (EIP-191, signed by the task client)',
            body: `{"brief": string (max ${MAX_BRIEF_CHARS} chars), "address": "0x…", "signature": "0x…"}`,
            // CAREFUL: this is the BASIC cap, never the largest tier's.
            //
            // An old client cannot pick a tier, so it will lock the registry
            // price and buy the basic one. Announcing the big tier's cap would
            // make it send a book while paying for the small job, and find out
            // with the money already locked. Whoever can read `tiers` will see
            // the rest.
            maxBriefChars: MAX_BRIEF_CHARS,
          },
          postAttachment: {
            method: 'POST',
            path: '/upload/:taskId',
            signMessage: 'Panal brief #<taskId>  (the SAME signature as the brief, no other needed)',
            body: 'the raw bytes; the name in the X-Panal-Filename header',
            howTo:
              'announce each attachment in the brief with a [panal-attach/1] block BEFORE hiring, and upload the bytes here afterwards. Only those the brief announced are accepted.',
            maxAttachmentBytes: MAX_FILE_BYTES,
          },
          getResult: {
            method: 'GET',
            path: '/result/:taskId',
            signMessage: 'Panal resultado #<taskId> · <epoch>  (EIP-191, X-Panal-* headers)',
          },
          ...(x402 ? { x402Ask: x402 } : {}),
        },
        // The tiers, only if this agent sells any. Absent means it offers none,
        // and the reader must NOT make them up from the price.
        ...(nivelesFicha.length > 0 ? { tiers: nivelesFicha } : {}),
        // OLD ALIAS, at the root. This is where the template used to publish
        // it, and there are clients out there that only look here. Served for
        // compatibility and will go away; what should be read is `endpoints`.
        ...(x402 ? { x402Ask: x402 } : {}),
      });
      return;
    }

    // ---- Pay per call: you pay and I answer on the spot ------------------------
    if (url.pathname === '/x402/ask' && req.method === 'POST') {
      if (X402_PRICE === null) {
        json(res, 404, { error: 'this agent does not charge per call; hire it through the escrow' });
        return;
      }
      const body = JSON.parse(await readBody(req)) as { prompt?: string };
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt || prompt.length > 2000) {
        json(res, 400, { error: 'prompt required, max 2000 characters' });
        return;
      }

      // The envelope, before anything else. Cutting a cycle here matters more
      // than in the escrow: in x402 payment comes BEFORE work, so an extra lap
      // is not wasted time, it is money charged for going round in circles.
      // And it comes before the 402 on purpose: if the chain is tainted, no
      // quote is even given.
      const sobre = parseEnvelope(req.headers);
      try {
        assertCanServe(sobre, account.address);
      } catch (err) {
        if (err instanceof LoopDetected) {
          console.error(`[x402] cycle cut: ${err.message}`);
          json(res, 508, { error: err.message, trace: err.trace });
          return;
        }
        throw err;
      }

      const domain = await dominioPermit();
      const pagoCrudo = req.headers['x-payment'];

      // No payment: answer 402 with the quote. This is the step that finally
      // gives meaning to a status code reserved and unused since the nineties,
      // because there was no way to pay on the web.
      if (typeof pagoCrudo !== 'string' || !pagoCrudo.trim()) {
        // If the client says who they are, they get their nonce for free and
        // save a chain query before being able to sign.
        const quien = req.headers['x-payment-payer'];
        const payer = typeof quien === 'string' && isAddress(quien) ? (quien as Address) : null;
        const nonce = payer ? await permitNonce(panal.publicClient, X402_TOKEN, payer).catch(() => undefined) : undefined;

        res.setHeader('www-authenticate', `eip2612-permit realm="panal", chain="${domain.chainId}"`);
        json(
          res,
          402,
          buildQuote({
            asset: X402_TOKEN,
            assetSymbol: X402_SYMBOL,
            amount: X402_PRICE,
            payTo: account.address,
            resource: '/x402/ask',
            description: X402_DESCRIPTION,
            domain,
            payerNonce: nonce,
          }),
        );
        return;
      }

      const leido = parsePaymentHeader(pagoCrudo);
      if (!leido.ok) {
        json(res, 400, { error: leido.error });
        return;
      }

      // PAYMENT IS TAKEN BEFORE SERVING. If it served first and the payment
      // failed, the work would be given away with no way to recover it.
      const cobro = await verifyAndSettle(
        { publicClient: panal.publicClient, walletClient: panal.walletClient ?? null, token: X402_TOKEN, domain, payee: account.address },
        leido.payment,
        X402_PRICE,
      );
      if (!cobro.ok) {
        json(res, cobro.status, { error: cobro.error });
        return;
      }
      console.log(`[x402] charged ${cobro.amount} from ${leido.payment.payer} · tx ${cobro.txHash}`);

      // It is paid: whatever happens from here, something must be answered. If
      // the model blows up, say so; staying silent would be keeping the money.
      try {
        const salida = await handleTask(
          prompt,
          contexto(
            {
              taskId: null,
              client: leido.payment.payer,
              amount: cobro.amount,
              deadline: 0n,
              // An x402 call is one question and one answer: there is no task
              // to anchor an attachment to, so there are no attachments.
              adjuntos: [],
              // What was already discussed with THIS person. The payment says
              // who they are: they signed a permit and the charge executed
              // on-chain, so nobody can continue someone else's conversation
              // without paying as them. That is why nothing needs
              // authenticating here.
              historial: historialParaElModelo(DATA_DIR, leido.payment.payer),
            },
            sobre,
          ),
        );
        // An x402 call has no task, so there is nothing to anchor and no
        // signature to protect a download with: files have nothing to hold on
        // to. The text is returned and the log says so instead of staying
        // quiet, otherwise the author looks for the fault in the wrong place.
        const { text: answer, files } = normalizarSalida(salida);
        if (files.length) {
          console.error(
            `[x402] your handleTask returned ${files.length} file(s) and an x402 call cannot deliver them: ` +
              'there is no task to anchor them nor a signature to protect the download. Only the text goes.',
          );
        }
        res.setHeader('x-payment-tx', cobro.txHash);
        json(res, 200, { answer, paid: { txHash: cobro.txHash, amount: cobro.amount.toString(), asset: X402_TOKEN } });

        // The turn is saved HERE, with both halves and only if there was an
        // answer. Saving it before working would leave unanswered questions in
        // memory, and next time the model would read a conversation in which
        // it stayed silent.
        recordarTurno(DATA_DIR, leido.payment.payer, { pregunta: prompt, respuesta: answer, cuando: Date.now() });
      } catch (err) {
        console.error(`[x402] charged but failed to answer: ${err instanceof Error ? err.message : err}`);
        json(res, 502, {
          error: 'the payment went through but the agent could not answer',
          paid: { txHash: cobro.txHash, amount: cobro.amount.toString() },
        });
      }
      return;
    }

    // Manual brief resend, for when the dashboard's automatic send does not
    // arrive: a phone, a wallet that swallows the signature, a tab closed
    // halfway. Served from the agent itself on purpose: same origin, no CORS
    // in between, and it works inside a wallet's browser.
    if (url.pathname === '/reenviar' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGINA_REENVIO);
      return;
    }

    // ---- The client sends you the brief ----------------------------------------
    // The canonical route is POST /brief/<taskId>: it is what the panal.lat
    // dashboard calls and what the reference bot documents. POST /brief with
    // the taskId inside the body is also accepted, because some clients
    // already spoke that way and breaking them fixes nothing.
    const rutaBrief = /^\/brief(?:\/(\d+))?$/.exec(url.pathname);
    if (rutaBrief && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as {
        taskId?: string | number;
        brief?: string;
        address?: string;
        signature?: string;
      };
      const idCrudo = rutaBrief[1] ?? body.taskId;
      if (idCrudo === undefined || !body.brief || !body.signature) {
        json(res, 400, { error: 'taskId, brief or signature missing' });
        return;
      }
      // First guard, deliberately against the LARGEST cap: the paid tier is not
      // known yet —it is on-chain and costs an eth_call— and a text that does
      // not fit the most expensive tier fits none. Whatever can be decided
      // without asking anyone is decided without asking.
      if (body.brief.length > TOPE_BRIEF_MAYOR) {
        json(res, 400, {
          error: `the brief is ${body.brief.length} characters and the cap is ${TOPE_BRIEF_MAYOR}`,
          maxBriefChars: TOPE_BRIEF_MAYOR,
          ...(NIVELES_OK.length > 0 ? { tiers: NIVELES_OK.map(comoFicha) } : {}),
        });
        return;
      }
      const taskId = BigInt(idCrudo);

      // The call-chain envelope, if this brief comes from another agent.
      // Checked BEFORE reading the task: if it is a cycle, even the eth_call is
      // unnecessary.
      const sobre = parseEnvelope(req.headers);
      try {
        assertCanServe(sobre, account.address);
      } catch (err) {
        if (err instanceof LoopDetected) {
          // 508 Loop Detected. It exists for exactly this, and saying it with
          // the right code lets the caller tell it apart from its own failure.
          console.error(`[panal] cycle cut at #${taskId}: ${err.message}`);
          json(res, 508, { error: err.message, trace: err.trace });
          return;
        }
        throw err;
      }

      // With retries: the client just mined the task against another node and
      // ours may lag behind. See `leerTarea`.
      const task = await leerTarea(taskId);

      // Four checks, and all four matter: that the task is yours, that it is
      // still open, that whoever claims to sign is the client who paid, and
      // that the signature proves it.
      if (task.worker.toLowerCase() !== account.address.toLowerCase()) {
        json(res, 403, { error: 'that task does not belong to this agent' });
        return;
      }
      // The dashboard also sends who is signing; if it does not match the
      // task's client, it stops before spending a signature verification.
      if (body.address && body.address.toLowerCase() !== task.client.toLowerCase()) {
        json(res, 403, { error: "that address is not the task's client" });
        return;
      }
      if (task.status !== TaskStatus.Open) {
        json(res, 409, { error: `the task is ${TaskStatus[task.status]}` });
        return;
      }
      if (!(await signedBy(briefSignMessage(taskId), body.signature, task.client))) {
        json(res, 401, { error: "the signature is not from this task's client" });
        return;
      }

      // The cap OF THE TIER THEY PAID FOR. Checked now and not above because
      // the amount was not known until here, and the amount is the only thing
      // that says which tier was bought: the client writes the brief and could
      // claim the most expensive one.
      //
      // The number and the tiers are both stated: the client already has the
      // payment locked, and knowing whether the text is too long or the tier
      // too small is the difference between fixing it and waiting for the
      // deadline to get the money back.
      const nivel = nivelDe(task.amount);
      if (NIVEL_MINIMO && task.amount < NIVEL_MINIMO.wei) {
        json(res, 400, {
          error: `this task locked ${task.amount} and the cheapest tier costs ${NIVEL_MINIMO.wei}`,
          tiers: NIVELES_OK.map(comoFicha),
        });
        return;
      }
      const topeDelNivel = nivel?.maxBriefChars ?? MAX_BRIEF_CHARS;
      if (body.brief.length > topeDelNivel) {
        json(res, 400, {
          error:
            `the brief is ${body.brief.length} characters and the tier you paid for ` +
            `(${nivel?.name ?? 'basic'}) allows up to ${topeDelNivel}`,
          maxBriefChars: topeDelNivel,
          ...(NIVELES_OK.length > 0 ? { tiers: NIVELES_OK.map(comoFicha) } : {}),
        });
        return;
      }
      // And that the text is THE one that was ordered. That is what the
      // taskHash is for: without this check, a client could pay for one thing
      // on-chain and ask for another over HTTP, and in a dispute the
      // arbitrator would have nothing to decide on. One extra character and
      // this trips, which is exactly the point.
      if (keccak256(toBytes(body.brief)) !== task.taskHash) {
        json(res, 409, {
          error: 'that text is not the one registered on-chain for this task',
          taskHash: task.taskHash,
        });
        return;
      }

      // The brief is saved NOW, before answering: the upload that follows needs
      // it on disk to know which bytes it may accept.
      saveBrief(taskId, body.brief);
      const { faltan } = repasarAdjuntos(taskId, body.brief);
      if (faltan.length > 0) {
        // Not an error: it is the other half of the brief, still on its way.
        // The answer says exactly what is expected so the client can upload it
        // without guessing. (Response keys stay as the protocol defines them.)
        if (sobre) sobrePendiente.set(taskId.toString(), sobre);
        json(res, 202, {
          ok: true,
          faltanAdjuntos: faltan.map((f) => ({ name: f.name, size: f.size, hash: f.hash })),
          subirA: `/upload/${taskId}`,
        });
        return;
      }

      json(res, 202, { ok: true });
      // No await: the client should not wait for you to finish working.
      void work(taskId, body.brief, sobre);
      return;
    }

    // ---- The client uploads the attachments their brief announced --------------
    //
    // Signed ONCE, with the same `Panal brief #<id>` that opened the brief.
    // Asking for one signature per file would mean three popups for someone who
    // already paid, and it would buy nothing: what decides what gets in is not
    // the signature, it is the manifest the chain already covers.
    const subida = /^\/upload\/(\d+)$/.exec(url.pathname);
    if (subida && req.method === 'POST') {
      const taskId = BigInt(subida[1]!);
      /** Rejects while draining the body: otherwise the client sees a reset instead of the reason. */
      const rechazar = (status: number, cuerpo: unknown): void => {
        req.resume();
        json(res, status, cuerpo);
      };

      // Local checks first, they cost neither RPC nor bandwidth.
      const brief = loadBrief(taskId);
      if (!brief) {
        rechazar(409, { error: 'send the brief first to POST /brief/' + taskId });
        return;
      }
      const anunciados = parseAttachmentsManifest(brief);
      if (anunciados.length === 0) {
        rechazar(409, { error: 'that brief announces no attachments' });
        return;
      }

      const cred = credencialesDe(req, url);
      if (!cred.address || !cred.signature) {
        rechazar(400, { error: 'address and signature missing (x-panal-address / x-panal-signature headers)' });
        return;
      }

      const task = await leerTarea(taskId);
      if (task.worker.toLowerCase() !== account.address.toLowerCase()) {
        rechazar(403, { error: 'that task does not belong to this agent' });
        return;
      }
      if (task.status !== TaskStatus.Open) {
        rechazar(409, { error: `the task is ${TaskStatus[task.status]}` });
        return;
      }
      if (cred.address.toLowerCase() !== task.client.toLowerCase()) {
        rechazar(403, { error: "only the task's client can upload attachments to it" });
        return;
      }
      if (!(await signedBy(briefSignMessage(taskId), cred.signature, task.client))) {
        rechazar(401, { error: "the signature is not from this task's client" });
        return;
      }

      // Nothing can weigh more than the largest announced attachment: the size
      // is INSIDE the manifest, i.e. inside what the chain covers. Checked
      // before reading so as not to swallow anyone's bytes.
      const tope = Math.min(MAX_FILE_BYTES, Math.max(...anunciados.map((f) => f.size)));
      const declarado = Number(req.headers['content-length'] ?? 0);
      if (declarado > tope) {
        rechazar(413, { error: `that file is ${declarado} bytes and the largest you announced is ${tope}` });
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await readBodyBytes(req, tope);
      } catch (err) {
        json(res, 413, { error: err instanceof Error ? err.message : 'body too large' });
        return;
      }

      // The guard. Matching is by hash, so the name in the header decides
      // nothing: it only breaks ties if the same file was attached twice.
      // The name comes percent-encoded: an HTTP header does not accept
      // characters outside latin-1, and "receipt ñ.png" is a normal name.
      let nombre: string | undefined;
      const cabecera = req.headers['x-panal-filename'];
      if (typeof cabecera === 'string') {
        try {
          nombre = decodeURIComponent(cabecera);
        } catch {
          nombre = cabecera;
        }
      }
      const anunciado = matchAttachment(anunciados, bytes, nombre);
      if (!anunciado) {
        json(res, 403, {
          error: 'those bytes are none of the attachments the brief announces',
          esperados: anunciados.map((f) => ({ name: f.name, size: f.size, hash: f.hash })),
        });
        return;
      }

      guardarAdjunto(taskId, anunciado.name, bytes);
      const { faltan: pendientes } = repasarAdjuntos(taskId, brief);
      console.log(
        `[panal] #${taskId} attachment "${anunciado.name}" received (${bytes.byteLength} bytes) · ${pendientes.length} missing`,
      );

      json(res, 202, {
        ok: true,
        guardado: anunciado.name,
        faltanAdjuntos: pendientes.map((f) => ({ name: f.name, size: f.size, hash: f.hash })),
      });

      // With the last attachment, work can start. The brief has been waiting
      // since it arrived; this is what releases it.
      if (pendientes.length === 0) {
        const sobreGuardado = sobrePendiente.get(taskId.toString()) ?? null;
        sobrePendiente.delete(taskId.toString());
        void work(taskId, brief, sobreGuardado);
      }
      return;
    }

    // ---- The client collects their result ---------------------------------------
    const match = /^\/result\/(\d+)$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      const taskId = BigInt(match[1]!);
      const cred = credencialesDe(req, url);
      if (!cred.address || !cred.signature) {
        json(res, 400, { error: 'address and signature missing (x-panal-address / x-panal-signature headers)' });
        return;
      }
      if (cred.porQuery) avisaQuery(taskId);
      // Cached: only the client is used here, and it never changes.
      const cliente = await clienteDeTarea(taskId);
      if (cred.address.toLowerCase() !== cliente.toLowerCase()) {
        json(res, 403, { error: "only the task's client can download the result" });
        return;
      }
      if (!(await credencialValida(taskId, cred.signature, cred.expira, cliente))) {
        json(res, 401, { error: 'invalid or expired signature' });
        return;
      }
      const text = loadResult(taskId);
      if (!text) {
        json(res, 404, { error: 'there is no result for that task yet' });
        return;
      }
      json(res, 200, { resultText: text });
      return;
    }

    // ---- The client downloads the files of their delivery -----------------------
    //
    // Protected like the result, and with THE SAME signature: `Panal resultado
    // #<id>` unlocks the text and all its files. Signing once per file would
    // mean asking the client for four signatures for a delivery of four PDFs.
    const archivo = /^\/files\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (archivo && req.method === 'GET') {
      const taskId = BigInt(archivo[1]!);
      const cred = credencialesDe(req, url);
      if (!cred.address || !cred.signature) {
        json(res, 400, { error: 'address and signature missing (x-panal-address / x-panal-signature headers)' });
        return;
      }
      if (cred.porQuery) avisaQuery(taskId);
      // Cached: only the client is used here, and it never changes.
      const cliente = await clienteDeTarea(taskId);
      if (cred.address.toLowerCase() !== cliente.toLowerCase()) {
        json(res, 403, { error: "only the task's client can download its files" });
        return;
      }
      if (!(await credencialValida(taskId, cred.signature, cred.expira, cliente))) {
        json(res, 401, { error: 'invalid or expired signature' });
        return;
      }

      // The name comes from the URL, i.e. from outside: it is cleaned the same
      // way as when writing it. Without this, `/files/31/..%2F..%2F.env` would
      // read the .env.
      let nombre: string;
      try {
        nombre = sanitizeFileName(decodeURIComponent(archivo[2]!));
      } catch {
        json(res, 400, { error: 'invalid file name' });
        return;
      }

      let bytes: Buffer;
      try {
        bytes = readFileSync(join(filesDir(taskId), nombre));
      } catch {
        json(res, 404, { error: 'that task has no such file' });
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
        // `attachment` on purpose: the agent chose what is inside, and the
        // client's browser is not allowed to run it as a page.
        'content-disposition': comoAdjunto(nombre),
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
      return;
    }

    json(res, 404, { error: 'not found' });
  })().catch((err) => {
    // "I do not see it yet" is NOT a 500. With 425 (Too Early) the caller knows
    // retrying makes sense; with 500 it looked like an agent fault and the
    // dashboard gave up, leaving the client resending by hand. It answers fast
    // and without log noise: there is nothing broken to look at.
    if (err instanceof TareaAunNoVisible) {
      if (!res.headersSent) {
        json(res, 425, { error: err.message, reintentable: true });
      } else res.end();
      return;
    }
    console.error(`[http] ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  });
});

server.listen(PORT);

// The watchdog. It starts AFTER listening: its first sweep can take a few
// seconds against the RPC, and meanwhile the agent must already be serving
// normal requests.
arrancarVigilante({
  panal,
  yo: account.address,
  dataDir: DATA_DIR,
  briefGuardado: loadBrief,
  // The same guard work() uses: a single source of truth about what is being
  // worked on right now.
  enCurso: (taskId) => inFlight.has(taskId.toString()),
  resultadoGuardado: loadResult,
  // Resuming a half-done job is exactly the same as doing it the first time.
  // The envelope is null: the chain that brought it no longer exists —the
  // process holding it died—, so this resumption cannot keep spending on
  // anyone's behalf. If the job needed delegation, it will use this agent's
  // own budget and not the caller's.
  // Only `entregada` (delivered) counts as resolved. A model failure or a wait
  // for attachments returns false and the task stays on the watchdog's list.
  trabajar: async (taskId, brief) => (await work(taskId, brief, null)) === 'entregada',
  reentregar: async (taskId, texto) => {
    const { txHash } = await panal.deliverResult(taskId, texto);
    console.log(`[watchdog] #${taskId} delivered on the second attempt · tx ${txHash}`);
  },
  urlPublica: process.env.PUBLIC_URL?.trim(),
});

// Automatic withdrawal: what the escrow credits for each approved job stays in
// the contract until someone calls `withdraw`, and an agent running alone has
// nobody to press the button. `RETIRADA=off` turns it off; the reason for each
// threshold is in retirada.ts.
// While the board is claiming a job the wallet is signing, even if `work()`
// has not started yet. The withdrawal has to see that: two transactions in a
// row from the same wallet clash on the nonce.
let tablonFirmando = false;

const retirada = opcionesDelEntorno(process.env);
if (retirada) {
  arrancarRetirada({
    panal,
    yo: account.address,
    opciones: retirada,
    // The same guard as the watchdog: with a job in progress the wallet may be
    // about to sign its delivery, and two transactions in a row clash on the
    // nonce.
    ocupado: () => inFlight.size > 0 || tablonFirmando,
  });
}

// The job board: picking up, on its own, ownerless posted jobs that match this
// agent. OFF unless `TABLON=on`: claiming is committing to deliver. The reason
// for each rule is in tablon.ts.
const tablon = opcionesTablon(process.env);
if (tablon) {
  void arrancarTablon({
    panal,
    yo: account.address,
    opciones: tablon,
    ocupado: () => inFlight.size > 0 || tablonFirmando,
    marcar: (ocupada) => {
      tablonFirmando = ocupada;
    },
    // The same path as a normal job: saves, works, serves the delivery from
    // this server —which is where the client looks for it— and anchors it.
    trabajar: (taskId, brief) => work(taskId, brief, null),
  });
}
