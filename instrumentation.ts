import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Validate the server environment once at boot so a missing variable fails
    // loudly here rather than on the first request that needs it.
    const { getServerEnv } = await import("./lib/env");
    getServerEnv();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
