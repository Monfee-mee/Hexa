/**
 * The memory of a conversation.
 *
 * Without this, every x402 call is independent: the client asks something,
 * your agent answers, and on the next one it has no idea what was being
 * discussed. That is not a chat, it is a search box that sends invoices — and
 * whoever uses it notices by the second message, when they have to repeat the
 * whole context.
 *
 * THE PAYMENT SAYS WHO IS TALKING. The conversation is stored under the
 * payer's address, and nobody merely claims that address: they signed a
 * permit and the charge executed on-chain. Nobody can read or continue
 * someone else's conversation without paying as them, so no separate
 * authentication is needed. It is the most useful property of charging per
 * call.
 *
 * ONLY IN x402, NOT IN THE ESCROW. An escrow job is a piece of work with a
 * beginning and an end: it is paid, delivered once and approved. Dragging
 * memory into it would mix up two different things.
 *
 * WHAT IT COSTS, worth keeping in view: the history goes inside the prompt,
 * and YOU pay for the prompt while the client pays a fixed price per message.
 * A long conversation gets more expensive to answer for the same price. Hence
 * the two caps below, and hence they can be lowered.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A closed exchange: what they asked and what you answered. */
export interface Turno {
  pregunta: string;
  respuesta: string;
  /** Epoch in milliseconds. */
  cuando: number;
}

/**
 * How many turns are remembered. `MEMORIA_TURNOS=0` turns memory off.
 *
 * Six is deliberately short: it covers a normal conversation and keeps the
 * cost bounded. Raise it if your agent needs long threads and it pays off;
 * set it to zero if yours are one-off questions.
 */
const TURNOS = (() => {
  const n = Number(process.env.MEMORIA_TURNOS?.trim() || '6');
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6;
})();

/**
 * Character cap on the history that goes into the prompt.
 *
 * The turn cap alone bounds nothing: six turns can be six lines or six screens
 * of pasted code.
 */
const MAX_CHARS = (() => {
  const n = Number(process.env.MEMORIA_CHARS?.trim() || '4000');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4000;
})();

/** How many turns are kept on disk, which is more than what is sent. */
const GUARDADOS = 60;

/**
 * The file for one conversation.
 *
 * The name comes from the address, and even though it arrives already
 * validated as one it is sanitized anyway: it decides a path on disk, and an
 * extra check in a place like that costs nothing.
 */
function archivo(dataDir: string, quien: string): string {
  const limpio = quien.toLowerCase().replace(/[^a-z0-9x]/g, '');
  return join(dataDir, 'chats', `${limpio}.json`);
}

/** Everything remembered about that person, oldest to newest. */
export function leerConversacion(dataDir: string, quien: string): Turno[] {
  try {
    const turnos = JSON.parse(readFileSync(archivo(dataDir, quien), 'utf8')) as Turno[];
    return Array.isArray(turnos) ? turnos : [];
  } catch {
    // No file, or an unreadable one: start from scratch. A broken memory must
    // not stop us from answering someone who just paid.
    return [];
  }
}

/**
 * Stores an exchange.
 *
 * Called AFTER answering, with both halves: a turn with a question and no
 * answer pollutes the memory next time, which is exactly what would happen if
 * it were stored before working and the model then failed.
 */
export function recordarTurno(dataDir: string, quien: string, turno: Turno): void {
  if (TURNOS === 0) return;
  try {
    const previos = leerConversacion(dataDir, quien);
    mkdirSync(join(dataDir, 'chats'), { recursive: true });
    writeFileSync(archivo(dataDir, quien), JSON.stringify([...previos, turno].slice(-GUARDADOS)), 'utf8');
  } catch (err) {
    // Losing the memory must not take down an answer that was already paid for.
    console.error(`[memory] could not save the turn: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The history handed to the model, already capped.
 *
 * It is trimmed from the end: recent turns give context, and old ones are the
 * first to go. Returns empty when memory is off.
 */
export function historialParaElModelo(dataDir: string, quien: string): Turno[] {
  if (TURNOS === 0) return [];

  const recientes = leerConversacion(dataDir, quien).slice(-TURNOS);
  const salida: Turno[] = [];
  let chars = 0;

  // Walk from newest to oldest so that, if something has to be left out, it
  // is the old stuff. Then return it in chronological order.
  for (let i = recientes.length - 1; i >= 0; i--) {
    const t = recientes[i]!;
    const coste = t.pregunta.length + t.respuesta.length;
    if (chars + coste > MAX_CHARS) break;
    chars += coste;
    salida.unshift(t);
  }
  return salida;
}

/** How the history is told to the model. Empty if there is nothing to tell. */
export function historialComoTexto(turnos: Turno[]): string {
  if (turnos.length === 0) return '';
  return turnos
    .map((t) => `Client: ${t.pregunta}\nYou: ${t.respuesta}`)
    .join('\n\n');
}
