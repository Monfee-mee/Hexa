/**
 * ────────────────────────────────────────────────────────────────────────────
 *  The job board: picking up matching jobs on its own, with nobody clicking.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE BOARD IS. A client can pay for a job WITHOUT choosing an agent
 * (`createTask` with `worker = address(0)`) and post a public listing. The
 * first active agent to call `claimTask` takes it. Until now only a person
 * could do that from the web; the board was designed for a program to do it.
 *
 * OFF BY DEFAULT, ON PURPOSE. Taking a job is committing to deliver it before
 * the deadline, with a stranger's money locked. That does not switch itself on
 * just by updating the template: it is enabled with `TABLON=on`.
 *
 * WHAT IT TAKES. Only what meets all four conditions:
 *   - it was not posted by this same agent;
 *   - it pays in this agent's currency and AT LEAST what it charges per job in
 *     the registry: the agent already chose its price, and the board does not
 *     discount it;
 *   - it has plenty of time left (`TABLON_MARGEN_MINUTOS`);
 *   - its listing mentions one of its skills —those on its on-chain profile,
 *     plus `TABLON_PALABRAS`—. It is a simple rule on purpose: the real brief
 *     can only be read AFTER taking the job, so the listing is the only thing
 *     to decide with, and a predictable match beats a clever one nobody can
 *     explain.
 * And out of what matches, one per round: the best paying.
 *
 * HOW IT WORKS IT. With the same `work()` as a normal job: it stores the brief
 * on disk, works it, SERVES the delivery from this server and anchors its
 * hash. The client fetches the delivery from the `bot:` the worker publishes,
 * as with any job, so the delivery lives here and not on the board. And since
 * the brief stays on disk and the task is assigned to this agent on-chain, if
 * the process dies halfway the watchdog picks it up again.
 *
 * THE WALLET, ONE AT A TIME. `claimTask` is a transaction. With a job in
 * progress the round is skipped, and after claiming there is a wait before
 * working: two transactions in a row from the same wallet clash on the nonce,
 * and on Monad one sent right after another reverts. The gas for `claimTask`
 * has been set by hand in the SDK since 0.18.3: without that, Monad charges a
 * whole inflated limit.
 */

import type { Address } from 'viem';
import { formatEther } from 'viem';
import type { EncargoDelTablon, PanalClient } from '@panal/sdk';

export interface OpcionesTablon {
  /** How often the board is checked, in minutes. */
  minutos: number;
  /** Minimum time that must be left to take it. */
  margenMinutos: number;
  /** Words that count as a match, besides the profile skills. */
  palabras: string[];
}

export const TABLON_POR_DEFECTO: OpcionesTablon = {
  minutos: 5,
  margenMinutos: 30,
  palabras: [],
};

/**
 * The options from .env, or `null` if it is off — which is the norm.
 *
 * Only `TABLON=on` turns it on. A numeric value that cannot be understood
 * neither turns anything off nor throws: the default is used and the log says
 * so.
 */
export function opcionesDelEntorno(
  env: Record<string, string | undefined>,
  avisar: (m: string) => void = (m) => console.warn(m),
): OpcionesTablon | null {
  if (env.TABLON?.trim().toLowerCase() !== 'on') return null;
  const o: OpcionesTablon = { ...TABLON_POR_DEFECTO, palabras: [] };

  if (env.TABLON_MINUTOS?.trim()) {
    const n = Number(env.TABLON_MINUTOS);
    if (Number.isFinite(n) && n >= 1) o.minutos = n;
    else avisar(`[board] TABLON_MINUTOS="${env.TABLON_MINUTOS}" is not valid (minimum 1): using ${o.minutos}.`);
  }
  if (env.TABLON_MARGEN_MINUTOS?.trim()) {
    const n = Number(env.TABLON_MARGEN_MINUTOS);
    if (Number.isFinite(n) && n >= 5) o.margenMinutos = n;
    else avisar(`[board] TABLON_MARGEN_MINUTOS="${env.TABLON_MARGEN_MINUTOS}" is not valid (minimum 5): using ${o.margenMinutos}.`);
  }
  if (env.TABLON_PALABRAS?.trim()) {
    o.palabras = env.TABLON_PALABRAS.split(',').map((p) => p.trim()).filter(Boolean);
  }
  return o;
}

/** No accents, lowercase, and dashes and slashes as spaces. */
function plano(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ');
}

/**
 * Does the listing mention any of these words?
 *
 * Whole word, not a fragment: "test" does not match "testimony", and "ai" does
 * not match any word that contains those two letters. A word shorter than
 * three letters does not count: those are exactly the ones that show up by
 * chance.
 */
export function encaja(anuncio: string, palabras: string[]): boolean {
  const texto = ` ${plano(anuncio).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return palabras.some((p) => {
    const q = plano(p).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return q.length >= 3 && texto.includes(` ${q} `);
  });
}

export interface DepsTablon {
  panal: PanalClient;
  yo: Address;
  opciones: OpcionesTablon;
  /** What this agent charges per job in the registry, and in which currency. */
  precio: { amount: bigint; currency: Address };
  /** Its skills, from the on-chain profile. */
  habilidades: string[];
  /** Is a job in progress? Then the wallet is not touched. */
  ocupado: () => boolean;
  /** Marks the wallet as busy while claiming and working. */
  marcar: (ocupada: boolean) => void;
  /** The template's `work()`: works, serves and anchors. */
  trabajar: (taskId: bigint, brief: string) => Promise<string>;
  /** Pause between claiming and working. Injectable for tests. */
  esperar?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

/** What can be taken from what is posted, best paying first. */
export function candidatos(
  lista: EncargoDelTablon[],
  deps: Pick<DepsTablon, 'yo' | 'precio' | 'habilidades' | 'opciones'>,
  ahoraS: number,
): EncargoDelTablon[] {
  const palabras = [...deps.habilidades, ...deps.opciones.palabras];
  return lista
    .filter((e) => e.cliente.toLowerCase() !== deps.yo.toLowerCase())
    .filter((e) => e.currency.toLowerCase() === deps.precio.currency.toLowerCase())
    .filter((e) => e.amount >= deps.precio.amount)
    .filter((e) => Number(e.deadline) - ahoraS >= deps.opciones.margenMinutos * 60)
    .filter((e) => encaja(e.anuncio, palabras))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

/**
 * One round: checks the board and, if something matches, claims and works it.
 *
 * Returns what it did, line by line, for the tests. Never throws: a failure
 * here must not take down the agent serving its normal jobs.
 */
export async function repasarTablon(deps: DepsTablon): Promise<string[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hecho: string[] = [];
  const anotar = (m: string): void => {
    hecho.push(m);
    log(m);
  };

  if (deps.ocupado()) return hecho;

  let lista: EncargoDelTablon[];
  try {
    lista = await deps.panal.listBoard({ limit: 30 });
  } catch (err) {
    anotar(`[board] could not read the board: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return hecho;
  }
  const elegido = candidatos(lista, deps, Math.floor(Date.now() / 1000))[0];
  if (!elegido) return hecho;

  deps.marcar(true);
  try {
    try {
      await deps.panal.claimTask(elegido.taskId);
    } catch (err) {
      // The usual reason here is that someone else took it first: the board is
      // first come, first served. Not a fault of the agent.
      anotar(`[board] #${elegido.taskId} could not be claimed: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      return hecho;
    }
    anotar(
      `[board] #${elegido.taskId} claimed · ${formatEther(elegido.amount)} · "${elegido.anuncio.slice(0, 80)}"`,
    );

    // Two transactions in a row from the same wallet clash on Monad.
    await esperar(15_000);

    let brief: string;
    try {
      brief = await deps.panal.readBoardBrief(elegido.taskId);
    } catch (err) {
      // Claimed and no brief: the client paid but did not leave the text. The
      // watchdog will keep flagging it; nothing else to do here.
      anotar(`[board] #${elegido.taskId} claimed but with no brief to read: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      return hecho;
    }

    const r = await deps.trabajar(elegido.taskId, brief);
    anotar(`[board] #${elegido.taskId} ${r === 'entregada' ? 'delivered' : `not delivered yet (${r}): the watchdog will pick it up`}`);
    return hecho;
  } catch (err) {
    anotar(`[board] #${elegido.taskId}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return hecho;
  } finally {
    deps.marcar(false);
  }
}

/**
 * Starts the rounds. Reads this agent's price and skills from the chain once,
 * at startup: they are what its owner decided.
 */
export async function arrancarTablon(
  deps: Omit<DepsTablon, 'precio' | 'habilidades'>,
): Promise<void> {
  let precio: DepsTablon['precio'];
  let habilidades: string[];
  try {
    const ficha = await deps.panal.getAgent(deps.yo);
    if (!ficha.active) {
      console.warn('[board] this agent is not active in the registry: claimTask would reject it. Board off.');
      return;
    }
    precio = { amount: ficha.pricePerTask, currency: ficha.currency };
    habilidades = ficha.metadata.skills ?? [];
  } catch (err) {
    console.warn(`[board] could not read the profile: ${err instanceof Error ? err.message : err}. Board off.`);
    return;
  }
  if (habilidades.length + deps.opciones.palabras.length === 0) {
    console.warn('[board] no skills in the profile and no TABLON_PALABRAS: nothing to decide with. Board off.');
    return;
  }

  const completas: DepsTablon = { ...deps, precio, habilidades };
  console.log(
    `Board: every ${deps.opciones.minutos} min · from ${formatEther(precio.amount)} in its currency · ` +
      `with at least ${deps.opciones.margenMinutos} min left · ${habilidades.length + deps.opciones.palabras.length} words.`,
  );
  let enMarcha = false;
  const ronda = async (): Promise<void> => {
    if (enMarcha) return;
    enMarcha = true;
    try {
      await repasarTablon(completas);
    } finally {
      enMarcha = false;
    }
  };
  setTimeout(() => void ronda(), 60_000);
  setInterval(() => void ronda(), deps.opciones.minutos * 60_000);
}
