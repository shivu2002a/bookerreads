// Lighthouse CI budget (Requirement 14.1): LCP <= 2.0 s and TTI <= 3.5 s on
// Slow 4G with 4x CPU throttling, mobile emulation. Run against a preview URL:
//   LHCI_URL=https://bookerreads-xyz.vercel.app pnpm dlx @lhci/cli autorun
const base = process.env.LHCI_URL ?? "http://localhost:3000";
const paths = ["/", "/c/central-east", "/search", "/login"];

module.exports = {
  ci: {
    collect: {
      url: paths.map((p) => `${base}${p}`),
      numberOfRuns: 3,
      settings: {
        preset: "perf",
        formFactor: "mobile",
        screenEmulation: { mobile: true, width: 360, height: 780, deviceScaleFactor: 2 },
        throttlingMethod: "simulate",
        throttling: {
          // Lighthouse "Slow 4G" preset with 4x CPU.
          rttMs: 150,
          throughputKbps: 1638.4,
          requestLatencyMs: 562.5,
          downloadThroughputKbps: 1474.56,
          uploadThroughputKbps: 675,
          cpuSlowdownMultiplier: 4,
        },
      },
    },
    assert: {
      assertions: {
        "largest-contentful-paint": [
          "error",
          { maxNumericValue: 2000, aggregationMethod: "median" },
        ],
        interactive: ["error", { maxNumericValue: 3500, aggregationMethod: "median" }],
        "total-byte-weight": ["warn", { maxNumericValue: 500 * 1024 }],
        "categories:performance": ["warn", { minScore: 0.9 }],
      },
    },
    upload: { target: "temporary-public-storage" },
  },
};
