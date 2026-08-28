/** Combine caller abort with a default upstream fetch timeout. */
export const DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 120_000;

export function providerFetchSignal(
  signal?: AbortSignal,
  timeoutMs = DEFAULT_PROVIDER_FETCH_TIMEOUT_MS
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}
