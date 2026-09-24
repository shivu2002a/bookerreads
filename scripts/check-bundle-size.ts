/**
 * Enforces Requirement 14.2: client JavaScript for member routes must be
 * under 150 KB gzipped (first load). Run after `next build`.
 *
 *   pnpm tsx scripts/check-bundle-size.ts            # check
 *   pnpm tsx scripts/check-bundle-size.ts --report   # print every route
 *
 * Reads .next/app-build-manifest.json (App Router) which maps each route to
 * the JS files needed for its first load, gzips each file once, and sums.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT_BYTES = 150 * 1024;
const NEXT_DIR = path.resolve(process.cwd(), ".next");

/** Routes that must stay under the budget. Public and auth routes too: members hit them. */
const BUDGETED_PREFIXES = [
  "/",
  "/c/",
  "/b/",
  "/dp/",
  "/m/",
  "/search",
  "/login",
  "/onboarding",
  "/shelf",
  "/requests",
  "/loans",
  "/activate",
  "/earnings",
  "/profile",
];
/** Admin is desktop-only and exempt. */
const EXEMPT_PREFIXES = ["/admin"];

type AppManifest = { pages: Record<string, string[]> };

function routeFromManifestKey(key: string): string {
  // "/(member)/shelf/page" -> "/shelf"; "/(public)/page" -> "/"
  const withoutPage = key.replace(/\/page$/, "").replace(/\/layout$/, "");
  const withoutGroups = withoutPage.replace(/\/\([^)]+\)/g, "");
  return withoutGroups === "" ? "/" : withoutGroups;
}

function isBudgeted(route: string): boolean {
  if (EXEMPT_PREFIXES.some((p) => route.startsWith(p))) return false;
  return BUDGETED_PREFIXES.some((p) => (p === "/" ? route === "/" : route.startsWith(p)));
}

function main() {
  const manifestPath = path.join(NEXT_DIR, "app-build-manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`No ${manifestPath}. Run \`pnpm build\` first.`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AppManifest;
  const report = process.argv.includes("--report");

  const gzipCache = new Map<string, number>();
  const gzipSize = (file: string): number => {
    let size = gzipCache.get(file);
    if (size === undefined) {
      const abs = path.join(NEXT_DIR, file);
      size = existsSync(abs) ? gzipSync(readFileSync(abs)).length : 0;
      gzipCache.set(file, size);
    }
    return size;
  };

  const results: Array<{ route: string; bytes: number; budgeted: boolean }> = [];
  for (const [key, files] of Object.entries(manifest.pages)) {
    if (!key.endsWith("/page")) continue;
    const route = routeFromManifestKey(key);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    const bytes = jsFiles.reduce((sum, f) => sum + gzipSize(f), 0);
    results.push({ route, bytes, budgeted: isBudgeted(route) });
  }
  results.sort((a, b) => b.bytes - a.bytes);

  const fmt = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  const failures = results.filter((r) => r.budgeted && r.bytes > LIMIT_BYTES);

  if (report || failures.length) {
    console.log(`First-load client JS (gzipped), budget ${fmt(LIMIT_BYTES)} for member routes:\n`);
    for (const r of results) {
      const flag = !r.budgeted ? "  (exempt)" : r.bytes > LIMIT_BYTES ? "  OVER" : "";
      console.log(`  ${fmt(r.bytes).padStart(9)}  ${r.route}${flag}`);
    }
    console.log();
  }

  if (failures.length) {
    console.error(`${failures.length} route(s) over the ${fmt(LIMIT_BYTES)} budget.`);
    process.exit(1);
  }
  const worst = results.filter((r) => r.budgeted)[0];
  console.log(
    `Bundle budget OK. Largest member route: ${worst ? `${worst.route} at ${fmt(worst.bytes)}` : "none"}.`,
  );
}

main();
