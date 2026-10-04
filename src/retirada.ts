/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Automatic withdrawal: what the escrow owes this agent, to its wallet.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY IT EXISTS. Panal's escrow is PULL payment: approving a job CREDITS the
 * money to the agent inside the contract, it does not send it. Until someone
 * calls `withdraw`, it stays there. A human sees it on the dashboard and
 * presses the button; an agent running alone, with nobody watching, piled up
 * earnings without ever collecting them. Panal's four agents ended up with
 * over 2 MON and 3,000 $PANAL sitting idle in the escrow.
 *
 * This agent has its key in .env —it signs every delivery with it—, so it can
 * withdraw on its own. A person selling through the mailbox cannot: their key
 * is in their wallet and nobody else can withdraw for them, which is exactly
 * what the contract protects (`withdraw` always pays whoever calls it).
 *
 * WHEN IT WITHDRAWS, AND WHY NOT ALWAYS. Withdrawing costs gas, and gas is
 * paid in MON even if what is withdrawn is $PANAL. Measured on mainnet on
 * 2026-09-14:
 *
 *     withdraw MON      55,157 gas   ≈ 0.0056 MON
 *     withdraw $PANAL  103,511 gas   ≈ 0.0106 MON
 *
 * Withdrawing 0.049 MON after every job would leave 13% behind. So:
 *
 *   - MON is withdrawn when gas does not exceed `maxGasPct` of the amount (2%
 *     by default). It is a rule on CURRENT gas, not a fixed number: if gas
 *     goes up, it waits for more to accumulate; if it goes down, it withdraws
 *     sooner.
 *   - $PANAL is withdrawn from `panalDesde` (1000 by default). No relative
 *     rule is possible there: gas is in MON and the token has no price to
 *     compare it with.
 *
 * And in both cases only if the wallet covers Monad's RESERVE —gas limit ×
 * max price—, which is locked before execution even if less is charged later.
 * Without that check, the node rejects with "insufficient balance" and a retry
 * with the same nonce and fees repeats the rejection.
 *
 * GAS IS SET BY HAND, AND LEARNING THAT COST 1.096 MON. viem does not estimate
 * gas: it asks the node to fill in the transaction (`eth_fillTransaction`),
 * and Monad's returns absurd gas precisely for `withdraw(address(0))` —1.05 M
 * for one wallet, 10.7 M for another—, when what is needed is 55,157. And
 * Monad charges the WHOLE gas limit, not what is used. Lint's first automatic
 * withdrawal took out 1.092 MON and paid 1.096 in gas (2026-09-14, tx
 * 0xa960cb7e…). So gas comes from `eth_estimateGas` —which does give the right
 * number—, with a 10% margin, and is passed explicitly: viem respects it. And
 * if the estimate comes back above `TOPE_GAS`, nothing is signed.
 *
 * NEVER AT THE SAME TIME AS A DELIVERY. If a job is in progress, the round is
 * skipped: two transactions in a row from the same wallet clash on the nonce,
 * and on Monad one sent right after another reverts. For the same reason,
 * there is a pause between withdrawing MON and withdrawing $PANAL.
 */

import type { Address, Hex } from 'viem';
import { formatEther, parseEther } from 'viem';
import { NATIVE_CURRENCY, escrowAbi, type PanalClient } from '@panal/sdk';

export interface OpcionesRetirada {
  /** How often the escrow is checked, in minutes. */
  minutos: number;
  /** MON: withdraw only if gas (reserve) does not exceed this % of the amount. */
  maxGasPct: number;
  /** $PANAL: withdraw from this amount up, in wei. */
  panalDesde: bigint;
}

/**
 * Above this a withdrawal is not signed. Withdrawing MON is 55,157 gas and
 * $PANAL 103,511: 300,000 leaves plenty of room for any honest withdrawal and
 * cuts off an absurd estimate before it gets charged.
 */
export const TOPE_GAS = 300_000n;

/** The gas it is signed with: the estimate plus 10%. */
export function gasConMargen(estimado: bigint): bigint {
  return (estimado * 11n + 9n) / 10n;
}

export const RETIRADA_POR_DEFECTO: OpcionesRetirada = {
  minutos: 60,
  maxGasPct: 2,
  panalDesde: parseEther('1000'),
};

/**
 * The options from .env, or `null` if it is off (`RETIRADA=off`).
 *
 * A value that cannot be understood neither turns anything off nor throws: the
 * default is used and the log says so. An agent that refuses to start over a
 * typo in an optional variable is worse than one that withdraws with the usual
 * threshold.
 */
export function opcionesDelEntorno(
  env: Record<string, string | undefined>,
  avisar: (m: string) => void = (m) => console.warn(m),
): OpcionesRetirada | null {
  if (env.RETIRADA?.trim().toLowerCase() === 'off') return null;
  const o = { ...RETIRADA_POR_DEFECTO };

  const minutos = Number(env.RETIRADA_MINUTOS);
  if (env.RETIRADA_MINUTOS?.trim()) {
    if (Number.isFinite(minutos) && minutos >= 5) o.minutos = minutos;
    else avisar(`[withdraw] RETIRADA_MINUTOS="${env.RETIRADA_MINUTOS}" is not valid (minimum 5): using ${o.minutos}.`);
  }
  const pct = Number(env.RETIRADA_MAX_GAS_PCT);
  if (env.RETIRADA_MAX_GAS_PCT?.trim()) {
    if (Number.isFinite(pct) && pct > 0 && pct <= 50) o.maxGasPct = pct;
    else avisar(`[withdraw] RETIRADA_MAX_GAS_PCT="${env.RETIRADA_MAX_GAS_PCT}" is not valid (0-50): using ${o.maxGasPct}.`);
  }
  if (env.RETIRADA_PANAL_DESDE?.trim()) {
    try {
      o.panalDesde = parseEther(env.RETIRADA_PANAL_DESDE.trim());
    } catch {
      avisar(`[withdraw] RETIRADA_PANAL_DESDE="${env.RETIRADA_PANAL_DESDE}" is not valid: using ${formatEther(o.panalDesde)}.`);
    }
  }
  return o;
}

export interface DepsRetirada {
  panal: PanalClient;
  yo: Address;
  opciones: OpcionesRetirada;
  /** Is a job in progress? Then the wallet is not touched. */
  ocupado: () => boolean;
  /** Pause between two withdrawals in a row. Injectable for tests. */
  esperar?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

/**
 * One round: checks what is owed in each currency and withdraws what is worth
 * it.
 *
 * Returns what it did, line by line, so tests can read it. Never throws: a
 * failure here must not take down the agent serving jobs.
 */
export async function repasarRetirada(deps: DepsRetirada): Promise<string[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hecho: string[] = [];
  const anotar = (m: string): void => {
    hecho.push(m);
    log(m);
  };

  if (deps.ocupado()) return hecho;

  const { panal, yo, opciones } = deps;
  const monedas: Array<{ direccion: Address; simbolo: 'MON' | '$PANAL' }> = [
    { direccion: NATIVE_CURRENCY, simbolo: 'MON' },
    { direccion: panal.addresses.panalToken, simbolo: '$PANAL' },
  ];

  let retiradas = 0;
  for (const { direccion, simbolo } of monedas) {
    try {
      const pendiente = await panal.getPendingWithdrawal(yo, direccion);
      if (pendiente === 0n) continue;

      // $PANAL: the threshold is checked before spending even one more read.
      if (simbolo === '$PANAL' && pendiente < opciones.panalDesde) continue;

      const llamada = {
        address: panal.addresses.escrow,
        abi: escrowAbi,
        functionName: 'withdraw',
        args: [direccion],
      } as const;
      const [estimado, comisiones, saldo] = await Promise.all([
        panal.publicClient.estimateContractGas({ ...llamada, account: yo } as never),
        panal.publicClient.estimateFeesPerGas(),
        panal.publicClient.getBalance({ address: yo }),
      ]);
      const gas = gasConMargen(estimado);
      if (gas > TOPE_GAS) {
        anotar(
          `[withdraw] the gas estimate to withdraw ${simbolo} came out at ${estimado}, above the cap ` +
            `of ${TOPE_GAS}: nothing is signed. Monad charges the whole limit.`,
        );
        continue;
      }
      // The reserve, with the SAME gas it will be signed with.
      const reserva = gas * comisiones.maxFeePerGas;

      // MON: gas must not eat more than maxGasPct of the amount withdrawn. It
      // is compared against the RESERVE, which is the upper bound: if it pays
      // off with that, it pays off with what is actually charged.
      if (simbolo === 'MON' && reserva * 10_000n > pendiente * BigInt(Math.round(opciones.maxGasPct * 100))) continue;

      if (saldo < reserva) {
        anotar(
          `[withdraw] ${formatEther(pendiente)} ${simbolo} are waiting in the escrow, but the wallet has ` +
            `${formatEther(saldo)} MON and withdrawing reserves ${formatEther(reserva)} MON of gas. Top up a little MON.`,
        );
        continue;
      }

      // Another transaction from this wallet right before reverts on Monad.
      if (retiradas > 0) await esperar(20_000);
      if (deps.ocupado()) return hecho;

      const wallet = panal.walletClient;
      if (!wallet) {
        anotar('[withdraw] the client has no account to sign with: cannot withdraw.');
        return hecho;
      }
      const hash: Hex = await wallet.writeContract({
        ...llamada,
        // Explicit. Without this viem asks the node for the gas and pays
        // whatever it says.
        gas,
        chain: panal.publicClient.chain,
        account: wallet.account ?? yo,
      } as never);
      // A revert also comes with a receipt: `status` has to be checked.
      const recibo = await panal.publicClient.waitForTransactionReceipt({ hash });
      if (recibo.status !== 'success') {
        anotar(`[withdraw] withdrawing ${simbolo} reverted (tx ${hash}): still credited, retrying next round.`);
        continue;
      }
      retiradas++;
      anotar(`[withdraw] ${formatEther(pendiente)} ${simbolo} withdrawn to the wallet · tx ${hash}`);
    } catch (err) {
      anotar(`[withdraw] could not withdraw ${simbolo}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  return hecho;
}

/**
 * Starts the rounds. The first one after two minutes: the agent just started
 * and the first thing is serving jobs, not moving money.
 */
export function arrancarRetirada(deps: DepsRetirada): void {
  const { opciones } = deps;
  console.log(
    `Automatic withdrawal: every ${opciones.minutos} min · MON when gas stays under ${opciones.maxGasPct}% · ` +
      `$PANAL from ${formatEther(opciones.panalDesde)} (RETIRADA=off turns it off).`,
  );
  let enMarcha = false;
  const ronda = async (): Promise<void> => {
    if (enMarcha) return;
    enMarcha = true;
    try {
      await repasarRetirada(deps);
    } finally {
      enMarcha = false;
    }
  };
  setTimeout(() => void ronda(), 2 * 60_000);
  setInterval(() => void ronda(), opciones.minutos * 60_000);
}
