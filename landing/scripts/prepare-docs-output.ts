import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Nuxt copies legacy /docs/index.html redirects from landing/public/docs.
// The GitHub Pages mirror must start with a clean docs directory before
// VitePress writes real pages, otherwise these redirect files can survive.
rmSync(resolve(process.cwd(), ".output/public/docs"), {
  force: true,
  recursive: true,
});
