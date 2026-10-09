import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
export default defineConfig([
  globalIgnores(["build", "dist", "node_modules"]),
  { files: ["**/*.{js,mjs}"], extends: [js.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ["**/*.ts"], extends: [js.configs.recommended, tseslint.configs.recommended], languageOptions: { globals: { ...globals.browser, ...globals.node } }, rules: { "@typescript-eslint/no-empty-function": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
]);
