/**
 * Retry when the model says "not now".
 *
 * WHY THIS EXISTS. A provider returns 429 when it is saturated or when you
 * went too fast, and 5xx when something is wrong on its side. Neither is your
 * fault and both clear up on their own within seconds. Without this, either
 * one kills the task: the client already paid, the payment stays locked, and
 * they get nothing back until the deadline expires.
 *
 * Measured against Moonshot in August 2026: two calls in a row and the second
 * came back with `engine_overloaded_error`. Not a rare case you have to
 * imagine; it is normal on a busy afternoon.
 *
 * What is **NOT** retried matters just as much: every other 4xx. A 401 is a
 * bad key, a 400 is a malformed request and a 404 is a model that does not
 * exist. Repeating them wastes time and money to reach the same answer, and
 * delays the only useful news —that something is misconfigured— until the
 * attempts run out.
 *
 * The wait GROWS between attempts. Asking a saturated engine again right away
 * just earns the same 429: it pushes more load exactly when it can least
 * take it.
 */

/** Waits between attempts, in milliseconds. Four calls at most. */
const ESPERAS = [1_000, 4_000, 10_000];

/** Status codes that get retried. The rest are final answers. */
export function esReintentable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * A `fetch` that tolerates a hiccuping provider.
 *
 * Returns the last response, retryable or not: the caller decides what to do
 * with it, as with a normal `fetch`. NETWORK failures are thrown once the
 * attempts run out, because there is no response to return.
 */
export async function fetchModelo(
  url: string,
  init: RequestInit,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  let ultimoFallo: unknown;

  for (let intento = 0; intento <= ESPERAS.length; intento++) {
    if (intento > 0) {
      const espera = ESPERAS[intento - 1]!;
      console.warn(`[model] retry ${intento} of ${ESPERAS.length} in ${espera} ms`);
      await dormir(espera);
    }
    try {
      const res = await fetch(url, init);
      if (!esReintentable(res.status) || intento === ESPERAS.length) return res;
      console.warn(`[model] the provider answered ${res.status}`);
    } catch (err) {
      // A network drop or the AbortSignal timeout. Retried all the same: they
      // are as transient as a 503, and with the payment locked, not giving up
      // at the first stumble is what separates delivering from not delivering.
      ultimoFallo = err;
      if (intento === ESPERAS.length) throw err;
      console.warn(`[model] the call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw ultimoFallo ?? new Error('unreachable');
}
