import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const landingRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: landingRoot,
  test: {
    environment: "happy-dom",
    include: ["stores/**/*.test.ts", "utils/**/*.test.ts"],
  },
  define: {
    "import.meta.client": "true",
  },
  resolve: {
    alias: {
      "~": resolve(landingRoot),
    },
  },
});
