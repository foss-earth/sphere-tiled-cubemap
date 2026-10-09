import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"], forceRerunTriggers: ["fixtures/**", "schema/**", "scripts/**", "package.json", "tsconfig.json", "node/**"] } });
