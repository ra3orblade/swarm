import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
