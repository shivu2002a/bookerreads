import type { Fetcher } from "./types";

/**
 * Small process-local token bucket. Serverless instances each get their own,
 * which is fine: the point is to stop one burst of scans hammering a provider.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: "rate_limited" | "timeout" | "http" | "network" | "parse",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type GetJsonOptions = {
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** One retry by default, for transient failures only. */
  retries?: number;
  bucket?: TokenBucket;
  provider: string;
  headers?: Record<string, string>;
};

/**
 * GET JSON with a timeout, one retry on transient failure, and a token bucket.
 * Returns null for a 404 (provider has no record); throws ProviderError otherwise.
 */
export async function getJson<T>(url: string, opts: GetJsonOptions): Promise<T | null> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const retries = opts.retries ?? 1;

  if (opts.bucket && !opts.bucket.tryTake()) {
    throw new ProviderError(opts.provider, "rate_limited", `${opts.provider}: local rate limit`);
  }

  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(url, {
        signal: controller.signal,
        ...(opts.headers ? { headers: opts.headers } : {}),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        lastError = new ProviderError(
          opts.provider,
          "http",
          `${opts.provider}: HTTP ${res.status}`,
          res.status,
        );
        continue; // transient: retry
      }
      if (!res.ok) {
        throw new ProviderError(
          opts.provider,
          "http",
          `${opts.provider}: HTTP ${res.status}`,
          res.status,
        );
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new ProviderError(opts.provider, "parse", `${opts.provider}: invalid JSON`);
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        if (
          err.kind === "parse" ||
          (err.kind === "http" && err.status && err.status < 500 && err.status !== 429)
        )
          throw err;
        lastError = err;
        continue;
      }
      const aborted = (err as { name?: string }).name === "AbortError";
      lastError = new ProviderError(
        opts.provider,
        aborted ? "timeout" : "network",
        `${opts.provider}: ${aborted ? `timed out after ${timeoutMs} ms` : String((err as Error).message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ProviderError(opts.provider, "network", `${opts.provider}: failed`);
}
