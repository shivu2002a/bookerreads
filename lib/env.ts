import { z } from "zod";

/**
 * Environment validation. Import `env` from server code only; import
 * `publicEnv` from anything that may run in the browser.
 *
 * Fails loudly at first import so a missing variable surfaces at boot
 * (or at build time for statically rendered routes), not on the first request.
 */

const nonEmpty = z.string().min(1);
const secret = z.string().min(16, "expected at least 16 characters");

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(""),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional().default(""),
  NEXT_PUBLIC_POSTHOG_HOST: z.url().optional().default("https://us.i.posthog.com"),
});

const serverSchema = publicSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NOTIFY_MODE: z.enum(["live", "mock"]).default("mock"),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  DATABASE_URL: z.url(),
  CRON_SECRET: secret,
  RAZORPAY_KEY_ID: nonEmpty,
  RAZORPAY_KEY_SECRET: nonEmpty,
  RAZORPAY_WEBHOOK_SECRET: nonEmpty,
  INTERAKT_API_KEY: nonEmpty,
  INTERAKT_WEBHOOK_SECRET: nonEmpty,
  MSG91_AUTH_KEY: nonEmpty,
  MSG91_SENDER_ID: nonEmpty,
  GOOGLE_BOOKS_API_KEY: z.string().optional().default(""),
  SENTRY_AUTH_TOKEN: z.string().optional().default(""),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid ${label} environment:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

// Next.js inlines NEXT_PUBLIC_* only when accessed as literal `process.env.X`,
// so the public object is spelled out rather than built from `process.env`.
const rawPublic = () => ({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});

let cachedPublic: PublicEnv | undefined;
let cachedServer: ServerEnv | undefined;

export function getPublicEnv(): PublicEnv {
  cachedPublic ??= parseOrThrow(publicSchema, rawPublic(), "public");
  return cachedPublic;
}

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() must not be called in the browser");
  }
  cachedServer ??= parseOrThrow(serverSchema, { ...process.env, ...rawPublic() }, "server");
  return cachedServer;
}

/** Test seam: clear the parsed cache so a test can mutate process.env and re-validate. */
export function resetEnvCacheForTests(): void {
  cachedPublic = undefined;
  cachedServer = undefined;
}

export const isProduction = () => getServerEnv().NODE_ENV === "production";
export const isMockNotify = () => getServerEnv().NOTIFY_MODE === "mock";
