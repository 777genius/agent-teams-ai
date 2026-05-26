#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";

const root = process.env.CONTROL_PLANE_ARCHITECTURE_ROOT
  ? resolve(process.env.CONTROL_PLANE_ARCHITECTURE_ROOT)
  : new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const appsRoot = join(root, "apps");
const packagesRoot = join(root, "packages");
const featuresRoot = join(packagesRoot, "features");
const sharedRoot = join(packagesRoot, "shared");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const boundaryLayerSegments = new Set(["domain", "application"]);
const privateFeatureExportSegments = new Set(["application", "domain", "infrastructure"]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const forbiddenBoundaryImports = [
  { pattern: /^@nestjs(?:\/.*)?$/, reason: "Nest belongs to interface/platform wiring" },
  { pattern: /^@prisma\/client(?:\/.*)?$/, reason: "Prisma belongs to infrastructure" },
  { pattern: /^@octokit(?:\/.*)?$/, reason: "Octokit belongs to GitHub adapters" },
  { pattern: /^fastify(?:\/.*)?$/, reason: "Fastify belongs to HTTP adapters" },
  { pattern: /^express(?:\/.*)?$/, reason: "Express belongs to HTTP adapters" },
  {
    pattern: /^@trpc(?:\/.*)?$/,
    reason: "Transport frameworks belong to interface adapters",
  },
  { pattern: /^bullmq(?:\/.*)?$/, reason: "Queue SDKs belong to infrastructure" },
  { pattern: /^pg(?:\/.*)?$/, reason: "Database clients belong to infrastructure" },
  { pattern: /^telegraf(?:\/.*)?$/, reason: "Messenger SDKs belong to adapters" },
  { pattern: /^grammy(?:\/.*)?$/, reason: "Messenger SDKs belong to adapters" },
  { pattern: /^@grammyjs(?:\/.*)?$/, reason: "Messenger SDKs belong to adapters" },
  {
    pattern: /^@slack\/(?:bolt|web-api)(?:\/.*)?$/,
    reason: "Messenger SDKs belong to adapters",
  },
  { pattern: /^discord\.js(?:\/.*)?$/, reason: "Messenger SDKs belong to adapters" },
  {
    pattern: /^node-telegram-bot-api(?:\/.*)?$/,
    reason: "Messenger SDKs belong to adapters",
  },
  {
    pattern: /^@agent-teams-control-plane\/platform-/,
    reason: "Application/domain depend on ports and shared abstractions, not platform",
  },
];

const forbiddenSharedImports = [
  {
    pattern: /^@agent-teams-control-plane\/platform-/,
    reason: "shared kernel must not import platform adapters",
  },
  {
    pattern: /^@agent-teams-control-plane\/features-/,
    reason: "shared kernel must not import feature packages",
  },
  { pattern: /^@nestjs(?:\/.*)?$/, reason: "shared kernel must not import Nest" },
  {
    pattern: /^@prisma\/client(?:\/.*)?$/,
    reason: "shared kernel must not import DB SDKs",
  },
  { pattern: /^@octokit(?:\/.*)?$/, reason: "shared kernel must not import GitHub SDKs" },
  {
    pattern: /^fastify(?:\/.*)?$/,
    reason: "shared kernel must not import HTTP frameworks",
  },
  {
    pattern: /^express(?:\/.*)?$/,
    reason: "shared kernel must not import HTTP frameworks",
  },
  {
    pattern: /^@trpc(?:\/.*)?$/,
    reason: "shared kernel must not import transport frameworks",
  },
  { pattern: /^bullmq(?:\/.*)?$/, reason: "shared kernel must not import queue SDKs" },
  { pattern: /^pg(?:\/.*)?$/, reason: "shared kernel must not import DB clients" },
  {
    pattern: /^telegraf(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
  {
    pattern: /^grammy(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
  {
    pattern: /^@grammyjs(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
  {
    pattern: /^@slack\/(?:bolt|web-api)(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
  {
    pattern: /^discord\.js(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
  {
    pattern: /^node-telegram-bot-api(?:\/.*)?$/,
    reason: "shared kernel must not import messenger SDKs",
  },
];

const forbiddenPhaseOneDependencies = [
  { pattern: /^@nestjs\/config$/, reason: "Use framework-free config validation first" },
  {
    pattern: /^@octokit(?:\/.*)?$/,
    reason: "GitHub SDKs start in the GitHub connector phase",
  },
  { pattern: /^octokit$/, reason: "GitHub SDKs start in the GitHub connector phase" },
  { pattern: /^@prisma\/client$/, reason: "Prisma starts in the persistence phase" },
  { pattern: /^prisma$/, reason: "Prisma starts in the persistence phase" },
  { pattern: /^pg$/, reason: "Database clients start in the persistence phase" },
  {
    pattern: /^bullmq$/,
    reason: "Queue SDKs start after outbox requirements are proven",
  },
  {
    pattern: /^pg-boss$/,
    reason: "Queue SDKs start after outbox requirements are proven",
  },
  { pattern: /^redis$/, reason: "Queue/cache SDKs are not part of the phase 1 scaffold" },
  {
    pattern: /^ioredis$/,
    reason: "Queue/cache SDKs are not part of the phase 1 scaffold",
  },
  { pattern: /^kafkajs$/, reason: "Broker SDKs are not part of the phase 1 scaffold" },
  { pattern: /^amqplib$/, reason: "Broker SDKs are not part of the phase 1 scaffold" },
  { pattern: /^stripe$/, reason: "Billing SDKs start in the billing phase" },
  { pattern: /^@stripe\/stripe-js$/, reason: "Billing SDKs start in the billing phase" },
  { pattern: /^telegraf$/, reason: "Messenger SDKs start in connector phases" },
  { pattern: /^grammy$/, reason: "Messenger SDKs start in connector phases" },
  { pattern: /^@grammyjs(?:\/.*)?$/, reason: "Messenger SDKs start in connector phases" },
  {
    pattern: /^@slack\/(?:bolt|web-api)$/,
    reason: "Messenger SDKs start in connector phases",
  },
  { pattern: /^discord\.js$/, reason: "Messenger SDKs start in connector phases" },
  {
    pattern: /^node-telegram-bot-api$/,
    reason: "Messenger SDKs start in connector phases",
  },
];

const violations = [];

const allSourceFiles = await collectSourceFiles([appsRoot, packagesRoot]);
const packageManifestFiles = await collectPackageManifestFiles([root]);
const featurePackages = await listFeaturePackages(featuresRoot);
const featurePackageByName = loadFeaturePackageMetadata(featurePackages);
const boundaryFiles = allSourceFiles.filter(isFeatureDomainOrApplicationFile);

for (const manifestPath of packageManifestFiles) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (isSharedPackageManifest(manifestPath)) {
    const dependencyNames = listDependencyNames(manifest);
    if (dependencyNames.length > 0) {
      violations.push({
        file: manifestPath,
        message: `shared kernel package must remain dependency-free; found ${dependencyNames.join(", ")}`,
      });
    }
  }
  for (const dependencyName of listDependencyNames(manifest)) {
    const match = forbiddenPhaseOneDependencies.find((item) =>
      item.pattern.test(dependencyName),
    );
    if (match) {
      violations.push({
        file: manifestPath,
        message: `declares ${dependencyName}: ${match.reason}`,
      });
    }
  }
}

for (const file of boundaryFiles) {
  const source = readFileSync(file, "utf8");
  for (const imported of extractImportSpecifiers(source)) {
    const match = forbiddenBoundaryImports.find((item) => item.pattern.test(imported));
    if (match) {
      violations.push({
        file,
        message: `imports ${imported}: ${match.reason}`,
      });
    }
    if (isDomainFile(file) && isApplicationImport(imported)) {
      violations.push({
        file,
        message: `imports ${imported}: domain must not depend on application`,
      });
    }
  }
}

for (const file of allSourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const imported of extractImportSpecifiers(source)) {
    if (isSharedProductionFile(file)) {
      const match = forbiddenSharedImports.find((item) => item.pattern.test(imported));
      if (match) {
        violations.push({
          file,
          message: `imports ${imported}: ${match.reason}`,
        });
      }
      if (!isRelativeImport(imported)) {
        violations.push({
          file,
          message: `imports ${imported}: shared kernel production code must use only relative imports`,
        });
      }
    }
    if (isCrossFeatureInfrastructureImport(file, imported)) {
      violations.push({
        file,
        message: `imports ${imported}: feature infrastructure is private to its bounded context`,
      });
    }
  }
  if (/\bforwardRef\s*\(/.test(source)) {
    violations.push({
      file,
      message: "uses forwardRef(); add an ADR before allowing circular Nest modules",
    });
  }
  if (/\bScope\.REQUEST\b|scope\s*:\s*Scope\.REQUEST\b/.test(source)) {
    violations.push({
      file,
      message:
        "uses request-scoped providers; use explicit command/session objects instead",
    });
  }
  if (hasImplicitNestConstructorInjection(source)) {
    violations.push({
      file,
      message:
        "uses Nest constructor injection without explicit @Inject(); keep DI wiring explicit for ESM/tsx runtime safety",
    });
  }
}

for (const featurePackage of featurePackages) {
  const indexPath = join(featurePackage, "src", "index.ts");
  const packageJsonPath = join(featurePackage, "package.json");
  if (!existsSync(indexPath)) {
    violations.push({
      file: featurePackage,
      message: "feature package must expose an explicit src/index.ts entrypoint",
    });
    continue;
  }
  if (!existsSync(packageJsonPath)) {
    violations.push({
      file: featurePackage,
      message: "feature package must have package.json with explicit exports",
    });
  } else {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!manifest.exports || !manifest.exports["."]) {
      violations.push({
        file: packageJsonPath,
        message: "feature package must export only deliberate public entrypoints",
      });
    }
    if (hasWildcardExport(manifest.exports)) {
      violations.push({
        file: packageJsonPath,
        message: "feature package exports must not use wildcard subpaths",
      });
    }
    if (exportsPrivateFeatureLayer(manifest.exports)) {
      violations.push({
        file: packageJsonPath,
        message:
          "feature package exports must not expose domain, application, or infrastructure subpaths directly",
      });
    }
  }
  const indexSource = readFileSync(indexPath, "utf8");
  if (/export\s+\*\s+from\s+["']/.test(indexSource)) {
    violations.push({
      file: indexPath,
      message:
        "wildcard exports hide the public surface; export named symbols explicitly",
    });
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations found:");
  for (const violation of violations) {
    console.error(`- ${relative(root, violation.file)}: ${violation.message}`);
  }
  process.exit(1);
}

console.log(
  `Architecture boundary check passed for ${boundaryFiles.length} domain/application files and ${allSourceFiles.length} source files.`,
);

async function collectSourceFiles(roots) {
  const files = [];
  for (const directory of roots) {
    if (existsSync(directory)) {
      files.push(...(await collectDirectorySourceFiles(directory)));
    }
  }
  return files.sort();
}

async function collectDirectorySourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDirectorySourceFiles(path)));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

async function collectPackageManifestFiles(roots) {
  const files = [];
  for (const directory of roots) {
    if (existsSync(directory)) {
      files.push(...(await collectDirectoryPackageManifestFiles(directory)));
    }
  }
  return files.sort();
}

async function collectDirectoryPackageManifestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryPackageManifestFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      files.push(path);
    }
  }

  return files;
}

async function listFeaturePackages(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
    .sort();
}

function loadFeaturePackageMetadata(featurePackages) {
  const byPackageName = new Map();

  for (const featurePackage of featurePackages) {
    const packageJsonPath = join(featurePackage, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof manifest.name === "string" && manifest.name.length > 0) {
      byPackageName.set(manifest.name, featurePackage);
    }
  }

  return byPackageName;
}

function listDependencyNames(manifest) {
  return dependencySections.flatMap((section) =>
    manifest[section] && typeof manifest[section] === "object"
      ? Object.keys(manifest[section])
      : [],
  );
}

function isSharedPackageManifest(file) {
  return normalize(file) === join(sharedRoot, "package.json");
}

function isSharedProductionFile(file) {
  const relativePath = relative(sharedRoot, file);
  return (
    !relativePath.startsWith("..") &&
    !relativePath.startsWith("/") &&
    relativePath.startsWith("src") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".test.tsx")
  );
}

function isRelativeImport(imported) {
  return imported.startsWith(".");
}

function isFeatureDomainOrApplicationFile(file) {
  const segments = relative(featuresRoot, file).split(/[\\/]/);
  if (segments[0]?.startsWith("..")) {
    return false;
  }
  const srcIndex = segments.indexOf("src");
  return srcIndex >= 0 && boundaryLayerSegments.has(segments[srcIndex + 1]);
}

function isDomainFile(file) {
  const segments = relative(featuresRoot, file).split(/[\\/]/);
  const srcIndex = segments.indexOf("src");
  return srcIndex >= 0 && segments[srcIndex + 1] === "domain";
}

function isApplicationImport(imported) {
  return imported.includes("/application") || imported.startsWith("../application");
}

function isCrossFeatureInfrastructureImport(file, imported) {
  const sourceFeaturePackage = getContainingFeaturePackage(file);
  if (!sourceFeaturePackage) {
    return false;
  }

  const targetFeaturePath = resolveFeatureImportPath(file, imported);
  if (!targetFeaturePath) {
    return false;
  }

  const targetFeaturePackage = getContainingFeaturePackage(targetFeaturePath);
  if (!targetFeaturePackage || targetFeaturePackage === sourceFeaturePackage) {
    return false;
  }

  return hasFeatureLayerSegment(targetFeaturePath, "infrastructure");
}

function getContainingFeaturePackage(file) {
  const normalizedFile = normalize(file);
  return featurePackages.find((featurePackage) => {
    const relativePath = relative(featurePackage, normalizedFile);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !relativePath.startsWith("/"))
    );
  });
}

function resolveFeatureImportPath(file, imported) {
  if (imported.startsWith(".")) {
    return resolve(file, "..", imported);
  }

  for (const [packageName, featurePackage] of featurePackageByName) {
    if (imported === packageName) {
      return featurePackage;
    }
    if (imported.startsWith(`${packageName}/`)) {
      const subpath = imported.slice(packageName.length + 1);
      if (subpath.startsWith("src/")) {
        return join(featurePackage, subpath);
      }
      return join(featurePackage, "src", subpath);
    }
  }

  return undefined;
}

function hasFeatureLayerSegment(file, layer) {
  const featurePackage = getContainingFeaturePackage(file);
  if (!featurePackage) {
    return false;
  }

  const segments = relative(featurePackage, file).split(/[\\/]/);
  const srcIndex = segments.indexOf("src");
  return srcIndex >= 0 && segments[srcIndex + 1] === layer;
}

function hasWildcardExport(exportsValue) {
  if (!exportsValue || typeof exportsValue !== "object") {
    return false;
  }

  for (const [key, value] of Object.entries(exportsValue)) {
    if (key.includes("*")) {
      return true;
    }
    if (typeof value === "string" && value.includes("*")) {
      return true;
    }
    if (hasWildcardExport(value)) {
      return true;
    }
  }

  return false;
}

function exportsPrivateFeatureLayer(exportsValue) {
  return collectExportPaths(exportsValue).some(hasPrivateFeatureLayerSegment);
}

function collectExportPaths(exportsValue) {
  if (typeof exportsValue === "string") {
    return [exportsValue];
  }
  if (!exportsValue || typeof exportsValue !== "object") {
    return [];
  }

  return Object.entries(exportsValue).flatMap(([key, value]) => [
    key,
    ...collectExportPaths(value),
  ]);
}

function hasPrivateFeatureLayerSegment(value) {
  return value
    .split(/[\\/]/)
    .some((segment) => privateFeatureExportSegments.has(segment));
}

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'";]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        specifiers.add(value);
      }
    }
  }

  return specifiers;
}

function hasImplicitNestConstructorInjection(source) {
  if (!/@(?:Controller|Injectable)\s*\(/.test(source)) {
    return false;
  }

  const constructorPattern = /constructor\s*\(([\s\S]*?)\)\s*\{/g;
  for (const match of source.matchAll(constructorPattern)) {
    const parameters = match[1] ?? "";
    const parameterCount = countConstructorParameters(parameters);
    const explicitInjectCount = [...parameters.matchAll(/@Inject\s*\(/g)].length;
    if (parameterCount > explicitInjectCount) {
      return true;
    }
  }

  return false;
}

function countConstructorParameters(parameters) {
  const trimmed = parameters.trim().replace(/,\s*$/, "");
  if (trimmed.length === 0) {
    return 0;
  }

  let depth = 0;
  let count = 1;

  for (const char of trimmed) {
    if (char === "(" || char === "{" || char === "[" || char === "<") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]" || char === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === "," && depth === 0) {
      count += 1;
    }
  }

  return count;
}
