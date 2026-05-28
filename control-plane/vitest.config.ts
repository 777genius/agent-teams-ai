import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    restoreMocks: true,
  },
});
