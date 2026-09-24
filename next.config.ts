import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

/** Allow next/image to load from a non-supabase.co Supabase URL (local dev, self-hosted). */
function supabaseLocalPattern(): Array<{
  protocol: "http" | "https";
  hostname: string;
  port?: string;
  pathname: string;
}> {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return [];
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith(".supabase.co")) return [];
    return [
      {
        protocol: u.protocol === "http:" ? "http" : "https",
        hostname: u.hostname,
        ...(u.port ? { port: u.port } : {}),
        pathname: "/storage/v1/object/public/**",
      },
    ];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // Covers come from the two catalogue providers only (design.md Catalogue Resolution).
    remotePatterns: [
      { protocol: "https", hostname: "covers.openlibrary.org" },
      { protocol: "https", hostname: "books.google.com" },
      { protocol: "https", hostname: "books.googleusercontent.com" },
      // Listing photos in Supabase Storage (hosted, and local `supabase start`).
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
      ...supabaseLocalPattern(),
    ],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    formats: ["image/webp"],
  },
  experimental: {
    serverActions: {
      // Photos are uploaded directly to Storage via signed URLs; actions carry only JSON.
      bodySizeLimit: "1mb",
    },
  },
  async headers() {
    return [
      {
        // The worker must never be served stale, or updates would not roll out.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), geolocation=(), microphone=(), payment=(self)",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  // Source map upload only when a token is present (CI/Vercel); skipped locally.
  authToken: process.env.SENTRY_AUTH_TOKEN || undefined,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
  widenClientFileUpload: false,
  webpack: { treeshake: { removeDebugLogging: true } },
  // Do not tunnel: keeps the client bundle and the middleware matcher simple.
  tunnelRoute: undefined,
});
