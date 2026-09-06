import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/dist-dev/",
      "dist-mcpb/",
      "**/node_modules/",
      "docs/",
      "packages/core/extension/",
      "packages/core/tests/__golden__/",
      "**/.invisible/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { files: ["scripts/**/*.mjs", "evals/**/*.mts"], languageOptions: { globals: globals.node } },
  {
    rules: {
      // `?? []` / `?.` chains read better than the rule's alternatives in parser code.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
