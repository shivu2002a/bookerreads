import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules", ".next", "e2e/**"],
    // Component tests opt into jsdom with a `// @vitest-environment jsdom` header.
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**"],
    },
  },
});
