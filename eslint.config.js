import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "coverage/**", ".data/**", "**/next-env.d.ts", "**/test-results/**", "**/playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Plain Node config scripts.
    files: ["**/*.mjs", "**/*.cjs", "**/*.config.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // Accessibility and hook rules for UI code. Accessibility lint is part of the Definition of Done.
    files: ["apps/web/**/*.tsx", "packages/ui/**/*.tsx"],
    plugins: { "jsx-a11y": jsxA11y, "react-hooks": reactHooks },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
    languageOptions: jsxA11y.flatConfigs.recommended.languageOptions,
  },
);
