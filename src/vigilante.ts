/**
 * The watchdog: finds out about tasks even when nobody knocks on the door.
 *
 * A normal agent only works when someone does POST /brief. That leaves three
 * holes that cost real money, and all three have happened:
 *
 *   1. THE BRIEF THAT NEVER ARRIVED. The client paid on-chain and pushing the
 *      brief failed —a phone, a wallet that swallows the signature, a closed
 *      tab, your agent down for two minutes—. The payment stays locked and
 *      you never find out.
 *   2. THE HALF-DONE JOB. You received the brief, started working and the
 *      process died. On restart there is no trace left: the task stays open
 *      forever.
 *   3. THE DELIVERY THAT WAS NOT ANCHORED. You finished the work, saved it,
 *      and the delivery transaction failed. You have the result on disk and
 *      the client has nothing.
 *
 * WHAT IT CANNOT DO, worth being clear about before expecting it: the escrow
 * stores `keccak256(brief)`, not the brief. A watchdog that sees a new task
 * knows it exists, whose it is and how much it pays, but NOT what was asked.
 * If the brief never arrived, there is nothing to make up: it warns with the
 * resend link and waits. Guessing would mean delivering anything and
 * anchoring its hash, which is worse than not delivering.
 *
 * "LOOKED AT" IS NOT "RESOLVED", and mixing them up cost two real tasks.
 *
 * The marker stores how far tasks have been ENUMERATED, not how far they have
 * been resolved. It used to be written at the end of every round no matter
 * what, so a task that failed halfway —the model hanging, the RPC down— was
 * left behind the marker and never looked at again. And whatever remembered
 * it lived only in memory, so a restart kept the optimistic half (the marker,
 * on disk) and lost the other (the pending list, in RAM).
 *
 * Now both live in the SAME file and are written together: the marker says
 * how far enumeration went, and `pendientes` carries the exceptions. A task
 * leaves that list when it is really closed —delivered, completed,
 * cancelled— and not when something was attempted with it.
 *
 * IT POLLS, IT DOES NOT LISTEN FOR EVENTS. `eth_getLogs` on the public RPC is
 * limited to 100 blocks, so an agent stopped for twenty minutes can no longer
 * recover its own gap. Reading the task counter and looking at the new ones
 * is one call per round, works the same after any downtime and does not
 * depend on the RPC keeping anything.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import type { Address } from 'viem';
import { TaskStatus, type PanalClient } from '@panal/sdk';

export interface VigilanteDeps {
  panal: PanalClient;
  /** This agent's address. */
  yo: Address;
  /** Where to store how far it looked. */
  dataDir: string;
  /**
   * Works a task whose brief is ALREADY at hand.
   *
   * Returns whether it DELIVERED, and that boolean is half the fix in this
   * file. `work()` is written to never throw —one broken task must not take
   * down the whole round—, so from here a retry that worked and one that blew
   * up again on a usage limit looked exactly the same: no error. The watchdog
   * considered the task done and stopped looking at it.
   *
   * And rethrowing the error is not enough: `work()` also exits cleanly when
   * the task is waiting for attachments that have not arrived, which is not
   * resolving it either. It has to say so, not be inferred from nobody
   * complaining.
   */
  trabajar: (taskId: bigint, brief: string) => Promise<boolean>;
  /**
   * Is that task being worked on RIGHT NOW?
   *
   * Without this, the watchdog cannot tell a job in progress from a dead one:
   * both look the same from outside —open task, brief on disk, no result—. It
   * showed up in the first real test, where it announced it was resuming a
   * task that was running along just fine. It did not duplicate it because
   * `work` has its own guard, but the warning was false, and a job longer than
   * the interval would repeat it every round.
   */
  enCurso: (taskId: bigint) => boolean;
  /** The received brief, if it was stored. */
  briefGuardado: (taskId: bigint) => string | null;
  /** The already computed result, if any. */
  resultadoGuardado: (taskId: bigint) => string | null;
  /** Retries anchoring a result that is already computed. */
  reentregar: (taskId: bigint, texto: string) => Promise<void>;
  /** The agent's public URL, for the orphaned-brief warning. */
  urlPublica?: string;
}

/** How often it looks when there is activity, in seconds. */
const CADA = (() => {
  const n = Number(process.env.VIGILANTE_SEGUNDOS?.trim() || '60');
  // Under 15 s adds nothing and does burn the RPC limit.
  return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 60;
})();

/**
 * How many empty rounds before slowing down, and how far it slows.
 *
 * An idle agent asks `getTaskCount()` every 60 s even if nothing happens. A
 * drop. But the public RPC is SHARED and cuts off at around 50 concurrent
 * calls: with a thousand agents that is 16.7 calls/s permanently, and
 * together they drain the well the indexer also drinks from — and the
 * indexer is what the whole market catalogue depends on.
 *
 * So after a while without finding anything —the normal case— it switches to
 * looking every five minutes. At the first finding it goes back to the short
 * pace.
 *
 * What it costs: a lost brief is detected in five minutes instead of one.
 * Deadlines are measured in hours, so it changes nothing for anyone.
 */
const VUELTAS_EN_BLANCO = 20;
const CADA_TRANQUILO = Math.max(CADA, 300);

/**
 * How long to wait before considering a brief lost.
 *
 * The normal path is: the transaction is mined and the client pushes the
 * brief a few seconds later. Without this wait, the watchdog would shout on
 * every legitimate task and the warning would stop meaning anything.
 */
const GRACIA_MS = 3 * 60 * 1000;

/** How many tasks back are looked at on a first start with no marker. */
const REPASO_INICIAL = 50n;

/**
 * Cap on the pending list.
 *
 * A task leaves the list when it closes —delivered, completed, cancelled—,
 * and they all end up closing: when the deadline expires the client gets
 * their money back and the task is no longer open. The cap exists anyway
 * because nothing FORCES the client to cancel: an abandoned task can stay
 * open forever, and without a cap the file would grow without end.
 *
 * When trimming, the OLDEST ones are dropped, which are the least
 * recoverable, and it is said out loud. Keeping quiet would repeat the very
 * failure this file is here to fix.
 */
const MAX_PENDIENTES = 500;

/** What is known about a task after looking at it. "Attempted" is not a verdict. */
type Veredicto = 'resuelta' | 'pendiente';

export function arrancarVigilante(deps: VigilanteDeps): { parar: () => void } {
  if (process.env.VIGILANTE === 'off') {
    console.log('Watchdog disabled (VIGILANTE=off).');
    return { parar: () => {} };
  }

  const estadoPath = join(deps.dataDir, 'vigilante.json');
  /**
   * When a task with no brief was first seen.
   *
   * This CAN live only in memory: it only serves the grace period before
   * shouting, and losing it on a restart just restarts that countdown. What
   * cannot live only in memory is the pending list, which is why it is kept
   * apart.
   */
  const vistas = new Map<string, number>();
  /** Already warned about, so the warning is not repeated every round. */
  const avisadas = new Set<string>();
  /** Stored briefs that do not match, so the complaint is not repeated. */
  const quejadas = new Set<string>();
  let parado = false;

  interface Estado {
    visto: bigint;
    pendientes: Set<string>;
  }

  const leerEstado = (): Estado => {
    try {
      const raw = JSON.parse(readFileSync(estadoPath, 'utf8')) as {
        visto?: string;
        pendientes?: string[];
      };
      return {
        // -1 and not 0: without a marker the initial sweep has to run.
        visto: raw.visto === undefined ? -1n : BigInt(raw.visto),
        // A file from the previous version has no list. It is read as empty
        // and the first round fills it again with whatever is still open ahead
        // of the marker; whatever was orphaned behind it has to be recovered
        // by hand, which is exactly the damage this fixes.
        pendientes: new Set(raw.pendientes ?? []),
      };
    } catch {
      return { visto: -1n, pendientes: new Set() };
    }
  };

  /**
   * Both things are written TOGETHER, and that is the fix.
   *
   * The marker used to go to disk and the pending list stayed in RAM, so a
   * restart kept the half that says "already looked" and lost the one that
   * says "but this is still unresolved". In a single file that cannot happen.
   */
  const escribirEstado = (visto: bigint, pendientes: Set<string>): void => {
    let lista = [...pendientes];
    if (lista.length > MAX_PENDIENTES) {
      // Sorted by id: the oldest first, which are the ones dropped.
      lista.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const tiradas = lista.slice(0, lista.length - MAX_PENDIENTES);
      lista = lista.slice(-MAX_PENDIENTES);
      console.error(
        `[watchdog] the pending list went over ${MAX_PENDIENTES}: no longer tracking ` +
          `${tiradas.length} old task(s) (#${tiradas[0]}…#${tiradas[tiradas.length - 1]}). ` +
          'Check them by hand if any is still open.',
      );
    }
    try {
      writeFileSync(estadoPath, JSON.stringify({ visto: visto.toString(), pendientes: lista }, null, 2));
    } catch (err) {
      // Losing the state costs repeating the sweep, so nothing stops.
      console.error(`[watchdog] could not save the state: ${err instanceof Error ? err.message : err}`);
    }
  };

  /** true if it found something to handle: that is what sets the pace. */
  async function repasar(): Promise<boolean> {
    const total = await deps.panal.getTaskCount();
    const { visto, pendientes } = leerEstado();
    // The first time it looks at the last REPASO_INICIAL instead of the 30,000
    // there may be: old ones are closed and do not change.
    const desde = visto >= 0n ? visto + 1n : total > REPASO_INICIAL ? total - REPASO_INICIAL : 0n;

    // The new ones, plus those left unresolved from previous rounds.
    const aMirar = new Set<string>(pendientes);
    for (let i = desde; i < total; i++) aMirar.add(i.toString());
    if (aMirar.size === 0) {
      escribirEstado(total - 1n, aMirar);
      return false;
    }

    // It STARTS from all of them still pending and only the one returning a
    // resolved verdict leaves. It used to be the other way round —in unless
    // someone complained— and that is why a failure halfway counted as a
    // success.
    const restantes = new Set<string>(aMirar);
    for (const id of aMirar) {
      // `break` and not `return`: what did get resolved has to be saved, and
      // above all what did not.
      if (parado) break;
      const taskId = BigInt(id);
      let veredicto: Veredicto = 'pendiente';
      try {
        veredicto = await revisarUna(taskId);
      } catch (err) {
        console.error(
          `[watchdog] #${taskId}: ${err instanceof Error ? err.message : err} — still pending`,
        );
      }
      if (veredicto === 'resuelta') restantes.delete(id);
    }
    escribirEstado(total - 1n, restantes);
    // There was something to look at, even if it was not ours: not an empty
    // round.
    return true;
  }

  async function revisarUna(taskId: bigint): Promise<Veredicto> {
    const task = await deps.panal.getTask(taskId);
    const id = taskId.toString();

    // Not mine: nothing to resolve and no need to look at it again.
    if (task.worker.toLowerCase() !== deps.yo.toLowerCase()) {
      vistas.delete(id);
      return 'resuelta';
    }
    // Closed on-chain —delivered, completed, disputed or cancelled—. THIS is
    // the only good way out of the list: the escrow says so, not us.
    if (task.status !== TaskStatus.Open) {
      vistas.delete(id);
      avisadas.delete(id);
      quejadas.delete(id);
      return 'resuelta';
    }

    // Being worked on right now: not a hole, it is the normal path. It is
    // neither resumed nor warned about a missing brief — it has it and is
    // using it. The watchdog only deals with what no longer moves.
    //
    // BUT IT STAYS PENDING. This used to remove it from the list, and it was
    // the same failure in another disguise: if that job in progress ended up
    // blowing up, the marker had already moved past it and nobody looked at
    // it again.
    if (deps.enCurso(taskId)) {
      vistas.delete(id);
      return 'pendiente';
    }

    // CASE 3: the result is computed and the task is still open, so the
    // delivery never got anchored. It is retried, which is free for the
    // client and gives back a task they had written off.
    //
    // If `reentregar` fails, it throws: up to `repasar`, which leaves it
    // pending.
    const resultado = deps.resultadoGuardado(taskId);
    if (resultado !== null) {
      console.log(`[watchdog] #${taskId} had an unanchored result: retrying the delivery`);
      await deps.reentregar(taskId, resultado);
      vistas.delete(id);
      return 'resuelta';
    }

    // CASE 2: the brief is stored but there is no result, so the job was
    // left half done. It is resumed.
    const brief = deps.briefGuardado(taskId);
    if (brief !== null) {
      // The hash is checked BEFORE working. The file has been on disk since
      // another run and cannot be trusted: if it does not match what is
      // on-chain, working on it would deliver something the client did not
      // ask for.
      if (keccak256(toBytes(brief)) !== task.taskHash) {
        // Pending, NOT resolved: the client can still resend the right one
        // via /reenviar and then it can be worked on. It complains only once
        // so as not to fill the log every round.
        if (!quejadas.has(id)) {
          quejadas.add(id);
          console.error(
            `[watchdog] #${taskId} the stored brief does NOT match the on-chain taskHash: ` +
              'not working on it. The client should resend it.',
          );
        }
        return 'pendiente';
      }
      console.log(`[watchdog] #${taskId} was left half done: resuming the job`);
      const entregada = await deps.trabajar(taskId, brief);
      vistas.delete(id);
      // HERE lived the second failure: it was taken as resolved without
      // checking whether it was. A model returning 429 twice in a row looked
      // the same as a perfect delivery.
      if (!entregada) {
        console.log(`[watchdog] #${taskId} was not delivered: it stays on the list for the next round`);
      }
      return entregada ? 'resuelta' : 'pendiente';
    }

    // CASE 1: there is a task and no brief. Nothing can be done here except
    // warn: the text is not on-chain and guessing it would mean making it up.
    const visto = vistas.get(id);
    if (visto === undefined) {
      vistas.set(id, Date.now());
      return 'pendiente';
    }
    if (Date.now() - visto < GRACIA_MS || avisadas.has(id)) return 'pendiente';

    avisadas.add(id);
    // How long until it expires, not when. The absolute date was printed in
    // UTC next to a log timestamp in local time, and a two-hour deadline read
    // as expired. What matters here is how much margin is left.
    const restanMin = Math.round((Number(task.deadline) * 1000 - Date.now()) / 60000);
    const vence =
      restanMin <= 0
        ? 'ALREADY EXPIRED'
        : restanMin < 60
          ? `in ${restanMin} min`
          : `in ${Math.floor(restanMin / 60)} h ${restanMin % 60} min`;
    console.error(
      `[watchdog] #${taskId} PAID AND WITH NO BRIEF. ${task.client} locked their payment more than ` +
        `${Math.round(GRACIA_MS / 60000)} min ago and the text never arrived. It cannot be guessed: the escrow ` +
        `only stores its hash.\n` +
        `  They should resend it from ${deps.urlPublica ? `${deps.urlPublica}/reenviar?task=${taskId}` : 'your /reenviar'}` +
        ` or from https://panal.lat/dashboard.\n` +
        `  If nobody does, the deadline expires ${vence} and the client gets their money back.`,
    );
    // Still open and with no brief: it stays on the list until the chain
    // says otherwise.
    return 'pendiente';
  }

  console.log(`Watchdog active: sweeps every ${CADA} s (VIGILANTE=off to turn it off).`);
  // One pass at startup, which is when it is needed most: it picks up
  // everything lost while the process was down.
  void repasar().catch((err) => console.error(`[watchdog] first sweep: ${err instanceof Error ? err.message : err}`));

  // The pace is rescheduled instead of using a fixed interval: that way it
  // can slow down on its own after a while of finding nothing.
  let enBlanco = 0;
  let tranquilo = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const programar = (ms: number): void => {
    timer = setTimeout(() => {
      void (async () => {
        let hizoAlgo = false;
        try {
          hizoAlgo = await repasar();
        } catch (err) {
          console.error(`[watchdog] ${err instanceof Error ? err.message : err}`);
        }

        if (hizoAlgo) {
          enBlanco = 0;
          if (tranquilo) {
            tranquilo = false;
            console.log(`[watchdog] activity detected: back to looking every ${CADA} s`);
          }
        } else if (++enBlanco >= VUELTAS_EN_BLANCO && !tranquilo) {
          tranquilo = true;
          console.log(
            `[watchdog] ${VUELTAS_EN_BLANCO} rounds with nothing: switching to every ${CADA_TRANQUILO} s ` +
              'to spare the shared RPC. Back to the short pace as soon as something shows up.',
          );
        }
        if (!parado) programar((tranquilo ? CADA_TRANQUILO : CADA) * 1000);
      })();
    }, ms);
    // Without unref, this timer keeps the process alive forever even when
    // everything else has finished.
    timer.unref?.();
  };
  programar(CADA * 1000);

  return {
    parar: () => {
      parado = true;
      if (timer) clearTimeout(timer);
    },
  };
}
