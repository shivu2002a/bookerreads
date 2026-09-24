import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/supabase/service",
              message:
                "The service-role client is server-only. Import it from server actions, route handlers, or lib/ code that never ships to the client.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Server-side code may import the service-role client.
    files: ["lib/**/*.ts", "app/api/**/*.ts", "app/**/actions.ts", "db/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "components/ui/**",
      "db/migrations/**",
      "playwright-report/**",
      "public/sw.js",
      "test-results/**",
    ],
  },
];

export default eslintConfig;
