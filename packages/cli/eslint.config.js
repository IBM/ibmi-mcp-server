import pluginJs from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

const combinedGlobals = { ...globals.browser, ...globals.node };
const trimmedGlobals = Object.fromEntries(
  Object.entries(combinedGlobals).map(([key, value]) => [key.trim(), value]),
);

export default [
  {
    languageOptions: {
      globals: trimmedGlobals,
      parserOptions: { tsconfigRootDir },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: ["coverage/", "dist/", "node_modules/"],
  },
];
