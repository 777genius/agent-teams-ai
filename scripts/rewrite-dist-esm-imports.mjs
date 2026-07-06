#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

const explicitExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".mjs",
  ".node",
]);

let rewritten = 0;
walk("dist");
console.log(`Rewrote extensionless ESM imports in ${rewritten} dist files.`);

function walk(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.isFile() && (fullPath.endsWith(".js") || fullPath.endsWith(".d.ts"))) {
      rewriteFile(fullPath);
    }
  }
}

function rewriteFile(filePath) {
  const before = readFileSync(filePath, "utf8");
  let after = before.replace(
    /(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_match, prefix, specifier, suffix) =>
      `${prefix}${rewriteSpecifier(filePath, specifier)}${suffix}`,
  );
  after = after.replace(
    /(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
    (_match, prefix, specifier, suffix) =>
      `${prefix}${rewriteSpecifier(filePath, specifier)}${suffix}`,
  );
  if (filePath.endsWith(".d.ts")) {
    after = after.replace(/^#!.*\n/, "");
  }
  if (
    filePath.endsWith(".d.ts") &&
    !after.startsWith('/// <reference types="node" />')
  ) {
    after = `/// <reference types="node" />\n${after}`;
  }

  if (after !== before) {
    writeFileSync(filePath, after);
    rewritten += 1;
  }
}

function rewriteSpecifier(filePath, specifier) {
  if (explicitExtensions.has(extname(specifier))) return specifier;

  const asFile = join(filePath, "..", `${specifier}.js`);
  if (existsSync(asFile) && statSync(asFile).isFile()) {
    return `${specifier}.js`;
  }

  const asIndex = join(filePath, "..", specifier, "index.js");
  if (existsSync(asIndex) && statSync(asIndex).isFile()) {
    return `${specifier}/index.js`;
  }

  return specifier;
}
