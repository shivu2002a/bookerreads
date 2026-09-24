import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPublicEnv, getServerEnv, resetEnvCacheForTests } from "./env";

const VALID: Record<string, string> = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  CRON_SECRET: "0123456789abcdef0123456789abcdef",
  RAZORPAY_KEY_ID: "rzp_test_x",
  RAZORPAY_KEY_SECRET: "s",
  RAZORPAY_WEBHOOK_SECRET: "w",
  INTERAKT_API_KEY: "i",
  INTERAKT_WEBHOOK_SECRET: "iw",
  MSG91_AUTH_KEY: "m",
  MSG91_SENDER_ID: "BKRRDS",
};

const original = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  for (const key of Object.keys(VALID)) delete process.env[key];
  Object.assign(process.env, VALID, overrides);
  resetEnvCacheForTests();
}

describe("env", () => {
  beforeEach(() => setEnv({}));
  afterEach(() => {
    process.env = { ...original };
    resetEnvCacheForTests();
  });

  it("parses a complete server environment with defaults", () => {
    const env = getServerEnv();
    expect(env.NOTIFY_MODE).toBe("mock");
    expect(env.NEXT_PUBLIC_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(env.CRON_SECRET).toBe(VALID.CRON_SECRET);
  });

  it("fails when a required variable is missing and names it", () => {
    setEnv({ RAZORPAY_WEBHOOK_SECRET: undefined });
    expect(() => getServerEnv()).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it("rejects a short CRON_SECRET", () => {
    setEnv({ CRON_SECRET: "short" });
    expect(() => getServerEnv()).toThrow(/CRON_SECRET/);
  });

  it("rejects an unknown NOTIFY_MODE", () => {
    setEnv({ NOTIFY_MODE: "loud" });
    expect(() => getServerEnv()).toThrow(/NOTIFY_MODE/);
  });

  it("public env does not require server secrets", () => {
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined, CRON_SECRET: undefined });
    expect(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL).toBe(VALID.NEXT_PUBLIC_SUPABASE_URL);
  });
});
