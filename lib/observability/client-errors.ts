"use client";

/**
 * Client error reporting without the Sentry SDK in the initial bundle.
 *
 * The full @sentry/nextjs client is ~60 KB, which is 40% of the member-route
 * budget (Requirement 14.2). Instead we listen for uncaught errors and load the
 * SDK on demand the first time one occurs. Healthy sessions never download it.
 */

type SentryLike = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
};

let sentryPromise: Promise<SentryLike | null> | null = null;

function loadSentry(): Promise<SentryLike | null> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return Promise.resolve(null);
  sentryPromise ??= import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
        tracesSampleRate: 0,
        sendDefaultPii: false,
        integrations: [],
      });
      return Sentry as unknown as SentryLike;
    })
    .catch(() => null);
  return sentryPromise;
}

export async function reportClientError(
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const sentry = await loadSentry();
  if (sentry) sentry.captureException(error, { extra: context });
  else if (process.env.NODE_ENV === "development") console.error("[client-error]", error, context);
}

let installed = false;

/** Idempotent. Called once from instrumentation-client.ts. */
export function installClientErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    void reportClientError(event.error ?? event.message, { source: "window.error" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    void reportClientError(event.reason, { source: "unhandledrejection" });
  });
}
