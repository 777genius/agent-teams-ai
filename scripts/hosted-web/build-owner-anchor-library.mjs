#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENTRY_SOURCE = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/main/infrastructure/process-supervision/OwnerAnchorLibrary.ts'
);
const MATERIALIZER_SOURCE = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorLaunchMaterializer.ts'
);
const RUNTIME_PLAN_SOURCE = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/contracts/runtimePlan.ts'
);
const PROCESS_SUPERVISION_CONTRACT_SOURCE = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/contracts/processSupervision.ts'
);
const TEAM_TYPES_SOURCE = path.join(REPOSITORY_ROOT, 'src/shared/types/team.ts');
const VIRTUAL_TEAM_TYPES_SOURCE = path.join(
  REPOSITORY_ROOT,
  '.owner-anchor-library-virtual/team-provider.ts'
);
const NATIVE_SOURCE = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c'
);
const NATIVE_HEADER = path.join(
  REPOSITORY_ROOT,
  'src/features/team-runtime-control/main/native/process-anchor/process_anchor_protocol.h'
);
const TSCONFIG_PATH = path.join(REPOSITORY_ROOT, 'tsconfig.json');
const ROOT_PACKAGE_PATH = path.join(REPOSITORY_ROOT, 'package.json');
const LOCKFILE_PATH = path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml');
const BUILD_SCRIPT_PATH = fileURLToPath(import.meta.url);
const VIRTUAL_OUT_DIR = path.join(REPOSITORY_ROOT, '.owner-anchor-library-emit');
const MODULE_SPECIFIER =
  /((?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s*))(['"])([^'"]+)\2/g;
const PACKAGE_SCHEMA_VERSION = 1;
const PACKAGE_NAME = '@agent-teams/owner-anchor-library';
const NODE_RUNTIME_BUILTINS = new Set([
  'node:child_process',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:perf_hooks',
  'node:stream',
  'node:url',
]);

function fail(message) {
  throw new Error(`owner-anchor-library:${message}`);
}

function parseArguments(argv) {
  let outputDirectory;
  let compilerPath;
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (option !== '--output' && option !== '--cc')) {
      fail('usage: --output /absolute/new/directory --cc /absolute/compiler');
    }
    if (option === '--output' && outputDirectory === undefined) outputDirectory = value;
    else if (option === '--cc' && compilerPath === undefined) compilerPath = value;
    else fail(`duplicate-or-unknown-option:${option}`);
  }
  if (!outputDirectory || !compilerPath) {
    fail('usage: --output /absolute/new/directory --cc /absolute/compiler');
  }
  if (!path.isAbsolute(outputDirectory)) fail('output-must-be-absolute');
  if (!path.isAbsolute(compilerPath)) fail('compiler-must-be-absolute');
  if (path.parse(outputDirectory).root === outputDirectory) fail('output-must-not-be-filesystem-root');
  return { outputDirectory: path.normalize(outputDirectory), compilerPath: path.normalize(compilerPath) };
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function assertRegularExecutable(filePath, label) {
  const resolved = await realpath(filePath).catch(() => fail(`${label}-unavailable`));
  const metadata = await stat(resolved);
  if (!metadata.isFile()) fail(`${label}-not-regular-file`);
  await access(resolved, constants.X_OK).catch(() => fail(`${label}-not-executable`));
  return resolved;
}

async function createNewOutputDirectory(outputDirectory) {
  const parent = path.dirname(outputDirectory);
  const parentMetadata = await stat(parent).catch(() => fail('output-parent-unavailable'));
  if (!parentMetadata.isDirectory()) fail('output-parent-not-directory');
  const callerUid = process.getuid?.();
  if (callerUid === undefined || parentMetadata.uid !== callerUid) {
    fail('output-parent-not-caller-owned');
  }
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('output-collision');
    }
    throw error;
  }
  const outputMetadata = await stat(outputDirectory);
  if (!outputMetadata.isDirectory() || outputMetadata.uid !== callerUid) {
    fail('output-not-caller-owned-directory');
  }
}

async function writeExclusive(filePath, contents, mode = 0o444) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runTool(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: options.timeout ?? 30_000,
    env: options.env ?? {},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`tool-failed:${path.basename(executable)}:${result.status}:${(result.stderr ?? '').trim()}`);
  }
  return { stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

function readProviderTypeSource(sourceText) {
  const match = sourceText.match(/export type TeamProviderId\s*=\s*([^;]+);/);
  if (!match) fail('team-provider-type-unavailable');
  return `/** Derived exactly from src/shared/types/team.ts during packaging. */\nexport type TeamProviderId = ${match[1].trim()};\n`;
}

function resolveSourceModule(ts, moduleName, containingFile, compilerOptions) {
  if (moduleName === '@shared/types') {
    return {
      resolvedFileName: VIRTUAL_TEAM_TYPES_SOURCE,
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
  }
  if (path.normalize(containingFile) === MATERIALIZER_SOURCE && moduleName === '../../../contracts') {
    return {
      resolvedFileName: RUNTIME_PLAN_SOURCE,
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
  }
  return ts.resolveModuleName(moduleName, containingFile, compilerOptions, ts.sys).resolvedModule;
}

function emittedRelativePath(sourceFile, extension) {
  const relative = path.relative(REPOSITORY_ROOT, sourceFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('source-outside-repository');
  return relative.replace(/\.(?:cts|mts|tsx?|jsx?)$/, extension).split(path.sep).join('/');
}

function relativeModuleSpecifier(fromOutput, targetOutput) {
  let relative = path.posix.relative(path.posix.dirname(fromOutput), targetOutput);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

function rewriteModuleSpecifiers(ts, text, sourceFile, outputFile, kind, compilerOptions) {
  return text.replace(MODULE_SPECIFIER, (whole, prefix, quote, moduleName) => {
    if (moduleName.startsWith('node:')) return whole;
    const resolved = resolveSourceModule(ts, moduleName, sourceFile, compilerOptions);
    if (!resolved || resolved.isExternalLibraryImport) fail(`external-module:${moduleName}`);
    const targetSource = path.normalize(resolved.resolvedFileName);
    const targetOutput = emittedRelativePath(targetSource, kind === 'javascript' ? '.js' : '.d.ts');
    const specifierTarget = kind === 'javascript' ? targetOutput : targetOutput.replace(/\.d\.ts$/, '.js');
    return `${prefix}${quote}${relativeModuleSpecifier(outputFile, specifierTarget)}${quote}`;
  });
}

function moduleSpecifiers(text) {
  const values = [];
  for (const match of text.matchAll(new RegExp(MODULE_SPECIFIER.source, 'g'))) values.push(match[3]);
  return values;
}

function validateModuleClosure(outputs, entryRelative, kind) {
  const pending = [entryRelative];
  const visited = new Set();
  const builtins = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    const output = outputs.get(current);
    if (!output) fail(`missing-${kind}-dependency:${current}`);
    visited.add(current);
    for (const specifier of moduleSpecifiers(output.text)) {
      if (specifier.startsWith('node:')) {
        if (!NODE_RUNTIME_BUILTINS.has(specifier)) fail(`undeclared-node-builtin:${specifier}`);
        builtins.add(specifier);
        continue;
      }
      if (!specifier.startsWith('.')) fail(`external-${kind}-dependency:${specifier}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier));
      const target = kind === 'types' ? resolved.replace(/\.js$/, '.d.ts') : resolved;
      if (target.startsWith('../')) fail(`${kind}-dependency-outside-package:${specifier}`);
      pending.push(target);
    }
  }
  return { included: visited, builtins };
}

async function compileTypeScriptClosure() {
  const typescriptEntry = await realpath(require.resolve('typescript'));
  if (!typescriptEntry.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) fail('typescript-not-workspace-installed');
  const ts = require(typescriptEntry);
  const configRead = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configRead.error) fail(ts.flattenDiagnosticMessageText(configRead.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(configRead.config, ts.sys, REPOSITORY_ROOT);
  const compilerOptions = {
    ...parsed.options,
    allowImportingTsExtensions: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: false,
    inlineSourceMap: false,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: false,
    noEmitOnError: true,
    outDir: VIRTUAL_OUT_DIR,
    rootDir: REPOSITORY_ROOT,
    sourceMap: false,
    target: ts.ScriptTarget.ES2022,
    types: ['node'],
  };
  const providerSource = await readFile(TEAM_TYPES_SOURCE, 'utf8');
  const virtualTeamTypes = readProviderTypeSource(providerSource);
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host = {
    ...defaultHost,
    fileExists: (fileName) =>
      path.normalize(fileName) === VIRTUAL_TEAM_TYPES_SOURCE || defaultHost.fileExists(fileName),
    readFile: (fileName) =>
      path.normalize(fileName) === VIRTUAL_TEAM_TYPES_SOURCE
        ? virtualTeamTypes
        : defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (path.normalize(fileName) === VIRTUAL_TEAM_TYPES_SOURCE) {
        return ts.createSourceFile(fileName, virtualTeamTypes, languageVersion, true, ts.ScriptKind.TS);
      }
      return defaultHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile
      );
    },
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) =>
        resolveSourceModule(ts, moduleName, path.normalize(containingFile), compilerOptions)
      ),
    resolveModuleNameLiterals: (moduleLiterals, containingFile) =>
      moduleLiterals.map((moduleLiteral) => ({
        resolvedModule: resolveSourceModule(
          ts,
          moduleLiteral.text,
          path.normalize(containingFile),
          compilerOptions
        ),
      })),
  };
  const emitted = [];
  host.writeFile = (fileName, text, _bom, _onError, sourceFiles) => {
    const sourceFile = sourceFiles?.[0]?.fileName;
    if (!sourceFile || (!fileName.endsWith('.js') && !fileName.endsWith('.d.ts'))) return;
    emitted.push({ fileName: path.normalize(fileName), sourceFile: path.normalize(sourceFile), text });
  };
  const program = ts.createProgram([ENTRY_SOURCE], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((item) => item.category === ts.DiagnosticCategory.Error);
  const emit = program.emit();
  diagnostics.push(...emit.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error));
  if (diagnostics.length > 0) {
    fail(`typescript-diagnostics:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, host)}`);
  }
  const javascript = new Map();
  const declarations = new Map();
  for (const output of emitted) {
    const kind = output.fileName.endsWith('.d.ts') ? 'types' : 'javascript';
    const relative = path.relative(VIRTUAL_OUT_DIR, output.fileName).split(path.sep).join('/');
    const rewritten = rewriteModuleSpecifiers(
      ts,
      output.text,
      output.sourceFile,
      relative,
      kind,
      compilerOptions
    );
    (kind === 'types' ? declarations : javascript).set(relative, {
      text: rewritten,
      sourceFile: output.sourceFile,
    });
  }
  const entryJavaScript = emittedRelativePath(ENTRY_SOURCE, '.js');
  const entryTypes = emittedRelativePath(ENTRY_SOURCE, '.d.ts');
  const runtimeClosure = validateModuleClosure(javascript, entryJavaScript, 'javascript');
  const typeClosure = validateModuleClosure(declarations, entryTypes, 'types');
  const includedOutputs = new Map();
  for (const relative of runtimeClosure.included) includedOutputs.set(relative, javascript.get(relative));
  for (const relative of typeClosure.included) includedOutputs.set(relative, declarations.get(relative));
  return {
    compilerEntry: typescriptEntry,
    compilerVersion: ts.version,
    entryJavaScript,
    entryTypes,
    includedOutputs,
    runtimeBuiltins: [...runtimeClosure.builtins].sort(),
  };
}

function readCapabilityBindings(headerText, spawnerText, contractText) {
  const headerProtocolVersion = headerText.match(/#define PA_PROTOCOL_VERSION\s+(\d+)/)?.[1];
  const contractProtocolVersion = contractText.match(
    /PROCESS_SUPERVISION_PROTOCOL_VERSION\s*=\s*(\d+)/
  )?.[1];
  const headerVersion = headerText.match(/#define PA_PROVIDER_STDIO_CAPABILITY_VERSION\s+(\d+)/)?.[1];
  const headerHash = headerText.match(/#define PA_PROVIDER_STDIO_CAPABILITY_HASH\s*\\\s*\n\s*"([^"]+)"/)?.[1];
  const sourceVersion = spawnerText.match(/NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION\s*=\s*(\d+)/)?.[1];
  const sourceHash = spawnerText.match(/NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH\s*=\s*\n?\s*'([^']+)'/)?.[1];
  if (
    !headerProtocolVersion ||
    headerProtocolVersion !== contractProtocolVersion ||
    !headerVersion ||
    !headerHash ||
    headerVersion !== sourceVersion ||
    headerHash !== sourceHash
  ) {
    fail('provider-stdio-capability-binding-mismatch');
  }
  return {
    protocolVersion: Number(headerProtocolVersion),
    providerStdioVersion: Number(headerVersion),
    providerStdioHash: headerHash,
  };
}

function inspectElf(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString('ascii') !== 'ELF') {
    fail('native-output-not-elf');
  }
  if (bytes[5] !== 1) fail('native-output-not-little-endian');
  const elfClass = bytes[4] === 2 ? 'ELF64' : bytes[4] === 1 ? 'ELF32' : fail('native-elf-class');
  const machineNumber = bytes.readUInt16LE(18);
  const machine = machineNumber === 62 ? 'x86_64' : machineNumber === 183 ? 'aarch64' : `machine-${machineNumber}`;
  const expected = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (!expected || machine !== expected) fail(`native-architecture-mismatch:${machine}:${process.arch}`);
  const strings = bytes.toString('latin1');
  const interpreter = strings.match(/\/[\x21-\x7e]*(?:ld-linux|ld-musl)[\x21-\x7e]*\.so(?:\.[0-9]+)*/)?.[0];
  return {
    format: elfClass,
    machine,
    linkage: interpreter ? 'dynamic' : 'static-or-undetermined',
    interpreter: interpreter ?? null,
    applicability: interpreter
      ? `Linux ${machine}; requires the recorded ELF interpreter and ABI-compatible target libc`
      : `Linux ${machine}; libc linkage was not inferable from an ELF interpreter and must be admitted separately`,
  };
}

async function buildNativeArtifact(outputDirectory, compilerPath) {
  const resolvedCompiler = await assertRegularExecutable(compilerPath, 'compiler');
  const compilerEnvironment = Object.freeze({
    PATH: [...new Set([path.dirname(resolvedCompiler), '/usr/bin', '/bin'])].join(path.delimiter),
    LANG: 'C',
    LC_ALL: 'C',
    SOURCE_DATE_EPOCH: '0',
  });
  const nativeDirectory = path.join(outputDirectory, 'native');
  await mkdir(nativeDirectory, { mode: 0o700 });
  const executablePath = path.join(nativeDirectory, 'process-anchor');
  const compileArguments = [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-pedantic',
    '-fstack-protector-strong',
    '-D_FORTIFY_SOURCE=2',
    '-fPIE',
    '-pie',
    '-Wl,-z,relro,-z,now',
    NATIVE_SOURCE,
    '-o',
    executablePath,
  ];
  const compilerVersion = runTool(resolvedCompiler, ['--version'], {
    env: compilerEnvironment,
  }).stdout.split('\n')[0];
  const compilerTarget = runTool(resolvedCompiler, ['-dumpmachine'], {
    env: compilerEnvironment,
  }).stdout;
  runTool(resolvedCompiler, compileArguments, {
    cwd: nativeDirectory,
    env: compilerEnvironment,
    timeout: 60_000,
  });
  await chmod(executablePath, 0o555);
  const bytes = await readFile(executablePath);
  return {
    executablePath,
    compilerPath: resolvedCompiler,
    compilerVersion,
    compilerTarget,
    compilerEnvironment,
    compileArguments,
    elf: inspectElf(bytes),
  };
}

function generatedNativeModule(nativeBinding) {
  return `import { createHash } from 'node:crypto';\nimport { readFile } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\n\nexport const OWNER_ANCHOR_NATIVE_ARTIFACT = Object.freeze(${JSON.stringify(nativeBinding, null, 2)});\n\nexport function resolveOwnerAnchorNativeArtifact(packageRoot = new URL('.', import.meta.url)) {\n  return fileURLToPath(new URL(OWNER_ANCHOR_NATIVE_ARTIFACT.relativePath, packageRoot));\n}\n\nexport async function verifyOwnerAnchorNativeArtifact(packageRoot) {\n  const artifactPath = resolveOwnerAnchorNativeArtifact(packageRoot);\n  const digest = 'sha256:' + createHash('sha256').update(await readFile(artifactPath)).digest('hex');\n  if (digest !== OWNER_ANCHOR_NATIVE_ARTIFACT.sha256) {\n    throw new Error('owner-anchor-native-artifact-hash-mismatch');\n  }\n  return artifactPath;\n}\n`;
}

function generatedNativeTypes(nativeBinding) {
  return `export interface OwnerAnchorNativeArtifactBinding {\n  readonly relativePath: 'native/process-anchor';\n  readonly sha256: '${nativeBinding.sha256}';\n  readonly protocolVersion: ${nativeBinding.protocolVersion};\n  readonly providerStdioCapabilityVersion: ${nativeBinding.providerStdioCapabilityVersion};\n  readonly providerStdioCapabilityHash: '${nativeBinding.providerStdioCapabilityHash}';\n  readonly target: Readonly<{ os: 'linux'; arch: '${nativeBinding.target.arch}'; machine: '${nativeBinding.target.machine}'; linkage: '${nativeBinding.target.linkage}'; interpreter: string | null }>;\n}\nexport declare const OWNER_ANCHOR_NATIVE_ARTIFACT: Readonly<OwnerAnchorNativeArtifactBinding>;\nexport declare function resolveOwnerAnchorNativeArtifact(packageRoot?: URL): string;\nexport declare function verifyOwnerAnchorNativeArtifact(packageRoot?: URL): Promise<string>;\n`;
}

async function inputRecord(filePath, role) {
  const metadata = await stat(filePath);
  return {
    path: path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/'),
    role,
    bytes: metadata.size,
    sha256: await sha256File(filePath),
  };
}

async function payloadRecord(outputDirectory, relative) {
  const filePath = path.join(outputDirectory, relative);
  const metadata = await stat(filePath);
  return {
    path: relative.split(path.sep).join('/'),
    bytes: metadata.size,
    mode: `0${(metadata.mode & 0o777).toString(8)}`,
    sha256: await sha256File(filePath),
  };
}

async function makePackageDirectoriesTraversable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await makePackageDirectoriesTraversable(path.join(directory, entry.name));
  }
  await chmod(directory, 0o755);
}

async function main() {
  if (process.platform !== 'linux') fail('linux-host-required');
  if (process.arch !== 'x64' && process.arch !== 'arm64') fail(`unsupported-host-architecture:${process.arch}`);
  const { outputDirectory, compilerPath } = parseArguments(process.argv.slice(2));
  await createNewOutputDirectory(outputDirectory);

  const rootPackage = JSON.parse(await readFile(ROOT_PACKAGE_PATH, 'utf8'));
  const typescript = await compileTypeScriptClosure();
  for (const [relative, output] of [...typescript.includedOutputs].sort(([left], [right]) => left.localeCompare(right))) {
    await writeExclusive(path.join(outputDirectory, 'lib', relative), output.text);
  }

  const native = await buildNativeArtifact(outputDirectory, compilerPath);
  const headerText = await readFile(NATIVE_HEADER, 'utf8');
  const spawnerText = await readFile(
    path.join(
      REPOSITORY_ROOT,
      'src/features/team-runtime-control/main/infrastructure/process-supervision/NodeAnchorSpawner.ts'
    ),
    'utf8'
  );
  const capability = readCapabilityBindings(
    headerText,
    spawnerText,
    await readFile(PROCESS_SUPERVISION_CONTRACT_SOURCE, 'utf8')
  );
  const nativeSha256 = await sha256File(native.executablePath);
  const nativeBinding = {
    relativePath: 'native/process-anchor',
    sha256: nativeSha256,
    protocolVersion: capability.protocolVersion,
    providerStdioCapabilityVersion: capability.providerStdioVersion,
    providerStdioCapabilityHash: capability.providerStdioHash,
    target: {
      os: 'linux',
      arch: process.arch,
      machine: native.elf.machine,
      linkage: native.elf.linkage,
      interpreter: native.elf.interpreter,
    },
  };
  await writeExclusive(path.join(outputDirectory, 'native-artifact.js'), generatedNativeModule(nativeBinding));
  await writeExclusive(path.join(outputDirectory, 'native-artifact.d.ts'), generatedNativeTypes(nativeBinding));
  await writeExclusive(path.join(outputDirectory, 'native', 'source', 'process_anchor.c'), await readFile(NATIVE_SOURCE));
  await writeExclusive(
    path.join(outputDirectory, 'native', 'source', 'process_anchor_protocol.h'),
    headerText
  );

  const packageJson = {
    name: PACKAGE_NAME,
    version: `${rootPackage.version}-owner-anchor.1`,
    type: 'module',
    private: false,
    license: rootPackage.license,
    main: `./lib/${typescript.entryJavaScript}`,
    types: `./lib/${typescript.entryTypes}`,
    exports: {
      '.': { types: `./lib/${typescript.entryTypes}`, import: `./lib/${typescript.entryJavaScript}` },
      './native-artifact': { types: './native-artifact.d.ts', import: './native-artifact.js' },
      './provenance.json': './provenance.json',
    },
    dependencies: {},
    peerDependencies: { '@types/node': '>=20' },
    engines: { node: rootPackage.engines?.node ?? '>=20' },
  };
  await writeExclusive(path.join(outputDirectory, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  const packageReadme = `# Owner anchor library\n\nGenerated process-ownership package. Import the main entry for the Product adapter, ports, parsers, materializer and spawner. Import \`${PACKAGE_NAME}/native-artifact\` and await \`verifyOwnerAnchorNativeArtifact()\` before supplying its path to \`NodeAnchorSpawner\`.\n\nThis directory is provenance-bearing output, not a signature or admission decision. The native ELF is for ${native.elf.applicability}. A consumer must pin this package and its provenance in the existing image manifest and must not copy the ELF to a different libc/architecture target without rebuilding there.\n`;
  await writeExclusive(path.join(outputDirectory, 'README.md'), packageReadme);

  const payloadPaths = [
    ...[...typescript.includedOutputs.keys()].map((relative) => path.posix.join('lib', relative)),
    'native-artifact.js',
    'native-artifact.d.ts',
    'native/process-anchor',
    'native/source/process_anchor.c',
    'native/source/process_anchor_protocol.h',
    'package.json',
    'README.md',
  ].sort();
  const sourcePaths = new Set(
    [...typescript.includedOutputs.values()].map((output) =>
      output.sourceFile === VIRTUAL_TEAM_TYPES_SOURCE ? TEAM_TYPES_SOURCE : output.sourceFile
    )
  );
  sourcePaths.add(NATIVE_SOURCE);
  sourcePaths.add(NATIVE_HEADER);
  const sourceInputs = [];
  for (const sourcePath of [...sourcePaths].sort()) sourceInputs.push(await inputRecord(sourcePath, 'source'));
  for (const [inputPath, role] of [
    [BUILD_SCRIPT_PATH, 'recipe'],
    [TSCONFIG_PATH, 'typescript-config'],
    [ROOT_PACKAGE_PATH, 'tool-declaration'],
    [LOCKFILE_PATH, 'tool-lock'],
  ]) sourceInputs.push(await inputRecord(inputPath, role));
  const nodePath = await realpath(process.execPath);
  const provenance = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    artifact: 'owner-anchor-library',
    trust: 'provenance-only-not-signature-or-admission',
    package: { name: PACKAGE_NAME, version: packageJson.version },
    target: { os: 'linux', arch: process.arch, ...native.elf },
    capability: {
      lifecycleProtocolVersion: capability.protocolVersion,
      providerStdioVersion: capability.providerStdioVersion,
      providerStdioHash: capability.providerStdioHash,
      nativeSha256,
    },
    runtime: { format: 'esm', builtins: [...new Set([...typescript.runtimeBuiltins, 'node:crypto', 'node:fs/promises', 'node:url'])].sort(), externalDependencies: [] },
    tools: {
      node: { path: nodePath, version: process.version, sha256: await sha256File(nodePath) },
      typescript: {
        path: path.relative(REPOSITORY_ROOT, typescript.compilerEntry).split(path.sep).join('/'),
        version: typescript.compilerVersion,
        sha256: await sha256File(typescript.compilerEntry),
      },
      cCompiler: {
        path: native.compilerPath,
        version: native.compilerVersion,
        target: native.compilerTarget,
        sha256: await sha256File(native.compilerPath),
        environment: native.compilerEnvironment,
        arguments: native.compileArguments.map((argument) =>
          argument === NATIVE_SOURCE ? 'src/features/team-runtime-control/main/native/process-anchor/process_anchor.c' : argument === native.executablePath ? 'native/process-anchor' : argument
        ),
      },
    },
    sourceInputs: sourceInputs.sort((left, right) => left.path.localeCompare(right.path)),
    outputs: await Promise.all(payloadPaths.map((relative) => payloadRecord(outputDirectory, relative))),
    manifestSelfHash: 'excluded; the admitting manifest pins provenance.json bytes',
  };
  await writeExclusive(path.join(outputDirectory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await makePackageDirectoriesTraversable(outputDirectory);
  process.stdout.write(`${pathToFileURL(path.join(outputDirectory, 'provenance.json')).href}\n`);
}

await main();
