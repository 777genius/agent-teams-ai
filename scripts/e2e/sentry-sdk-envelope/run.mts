/** Run on an isolated validation host: tsx run.mts <retained-producer-proof> <NEW-output-directory>. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { SENTRY_INVENTORY_PAYLOAD_ID } from '../../../src/shared/utils/sentryArtifactInventory.js';
import { processIdentity, stopOwnedGroup } from '../release-updater/native-window.mts';
import { EXPECTED, IDENTITY, validateChain, type Chain } from './contract.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv[2] === '--pipe-descendant') {
  process.on('SIGTERM', () => undefined);
  await writeFile(process.argv[3]!, String(process.pid));
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}
if (process.argv[2] === '--pipe-root') {
  const directory = process.argv[3]!;
  spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(import.meta.url),
      '--pipe-descendant',
      join(directory, 'descendant-ready'),
    ],
    { stdio: 'inherit' }
  );
  const until = Date.now() + 5000;
  while (!(await stat(join(directory, 'descendant-ready')).catch(() => null))) {
    assert.ok(Date.now() < until, 'Owned descendant did not become ready');
    await new Promise((done) => setTimeout(done, 20));
  }
  await writeFile(
    join(directory, 'control-receipt.json'),
    JSON.stringify({ valid: true, scope: 'process lifecycle only; no SDK event' })
  );
  process.exit(0);
}
if (process.argv[2] === '--typecheck') {
  const configDir = process.argv[3];
  assert.ok(configDir, 'Supply NEW per-process typecheck directory');
  await mkdir(configDir, { recursive: false });
  const compiler = join(repository, 'node_modules/@typescript/native/bin/tsc');
  for (const [processName, entries] of Object.entries({
    main: ['main.mts', 'run.mts'],
    preload: ['preload.mts'],
    renderer: ['renderer.mts'],
  })) {
    const config = join(resolve(configDir), `${processName}.json`);
    await writeFile(
      config,
      JSON.stringify({
        extends: join(repository, 'scripts/tsconfig/tsconfig.sentry-sdk-e2e.json'),
        compilerOptions: { typeRoots: [join(repository, 'node_modules/@types')] },
        files: entries.map((entry) => fileURLToPath(new URL(entry, import.meta.url))),
        include: [],
      })
    );
    const check = spawn(process.execPath, [compiler, '--noEmit', '-p', config], {
      stdio: 'inherit',
    });
    const code = await new Promise<number | null>((done, reject) => {
      check.once('error', reject);
      check.once('close', done);
    });
    assert.equal(code, 0, `${processName} strict TS7 boundary failed`);
  }
  process.exit(0);
}
type Digest = { sha256: string; bytes: number };
type Pair = {
  relativeFile: string;
  debugId: string;
  source: Digest;
  originalMap: Digest & { relativeFile: string };
};
const DIGESTS = [
  [
    'a3cae29d465776586892091fb5d08cb305006546cbf2ca6214ebfad03295d83f',
    655,
    'e183d45bcdc433f5b60447bf5579abbee1c3ae60f24db445c32633400c112466',
    237,
  ],
  [
    'b02162938bcfadf70a082887782399365f1d6967d40a83340e264db4fea047af',
    663,
    'de96c29a44a11627fcb2dfb2c108cc6de07e3b2937c8ada5b76b76e8b331562e',
    245,
  ],
  [
    'e369a46b3c3d988b5b741028457813459580ea5378f2e2df4cd0ceda1c9dc79f',
    566,
    '31f5df4fdf7538106f393be03a8bded44aa1cd2e13bc8ad5ef728f38b894748e',
    528,
  ],
  [
    '65546197a9b174a3ee2efc5969cd4001230ad3666a9626de27dd1a8644ff02e2',
    3504,
    '0ba89060cffbed00f536c6406a94f89ae618758dafc5a84b6f07aabfba234df6',
    407,
  ],
] as const;
async function bounded(path: string): Promise<Buffer> {
  const info = await stat(path);
  assert.ok(info.isFile() && info.size <= 1024 * 1024, 'Fixture file byte bound');
  return readFile(path);
}
const digest = (bytes: Buffer): Digest => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
function sourcePath(input: string, file: string): string {
  return join(
    input,
    file.replace('dist-electron/main/', 'main/').replace('out/renderer/', 'renderer/')
  );
}
async function verifyInput(input: string, copied?: string): Promise<Pair[]> {
  const report = JSON.parse((await bounded(join(input, 'report.json'))).toString()) as {
    observations: { runtime: { artifacts: { relativeFile: string; debugId: string }[] } }[];
  };
  assert.deepEqual(
    report.observations
      .flatMap((row) => row.runtime.artifacts)
      .map(({ relativeFile, debugId }) => ({ relativeFile, debugId })),
    EXPECTED
  );
  const evidence: Pair[] = [];
  for (const target of ['main', 'renderer']) {
    const proof = JSON.parse(
      (await bounded(join(input, 'host-evidence', target + '.json'))).toString()
    ) as {
      target: string;
      mapStage: string;
      uploadVerified: boolean;
      artifacts: Pair[];
      runtime: { artifacts: { relativeFile: string; debugId: string }[] };
    };
    assert.equal(proof.target, target);
    assert.equal(proof.mapStage, 'original-before-sentry-upload-preparation');
    assert.equal(proof.uploadVerified, false);
    const rows = EXPECTED.filter((row) =>
      row.relativeFile.startsWith(target === 'main' ? 'dist-electron/' : 'out/')
    );
    assert.deepEqual(
      proof.runtime.artifacts.map(({ relativeFile, debugId }) => ({ relativeFile, debugId })),
      rows
    );
    assert.deepEqual(
      proof.artifacts.map(({ relativeFile, debugId }) => ({ relativeFile, debugId })),
      rows
    );
    evidence.push(...proof.artifacts);
    const files = await readdir(join(input, target), { recursive: true });
    assert.deepEqual(
      files.filter((file) => /\.(?:cjs|js)(?:\.map)?$/.test(file)).sort(),
      rows
        .flatMap((row) => {
          const file = row.relativeFile
            .replace('dist-electron/main/', '')
            .replace('out/renderer/', '');
          return [file, file + '.map'];
        })
        .sort()
    );
  }
  for (const [index, row] of evidence.entries()) {
    const expected = EXPECTED[index]!;
    const [sourceSha, sourceBytes, mapSha, mapBytes] = DIGESTS[index]!;
    assert.deepEqual(row, {
      ...expected,
      source: { sha256: sourceSha, bytes: sourceBytes },
      originalMap: {
        relativeFile: expected.relativeFile + '.map',
        sha256: mapSha,
        bytes: mapBytes,
      },
    });
    const js = await bounded(sourcePath(input, row.relativeFile));
    const map = await bounded(sourcePath(input, row.originalMap.relativeFile));
    assert.deepEqual(digest(js), row.source, 'Retained JS digest differs');
    assert.deepEqual(
      digest(map),
      { sha256: row.originalMap.sha256, bytes: row.originalMap.bytes },
      'Retained original map digest differs'
    );
    assert.equal(
      js.toString().split('sentry-dbid-' + row.debugId).length,
      2,
      'Exactly one retained injected ID'
    );
    const parsed = JSON.parse(map.toString()) as {
      version: number;
      sources: unknown;
      mappings: unknown;
    };
    assert.ok(
      parsed.version === 3 && Array.isArray(parsed.sources) && typeof parsed.mappings === 'string'
    );
    if (copied) {
      assert.deepEqual(await bounded(join(copied, row.relativeFile)), js);
      assert.deepEqual(await bounded(join(copied, row.originalMap.relativeFile)), map);
    }
  }
  return evidence;
}
/** Expiry rejects synchronously; finally waits for birth-fenced cleanup. */
async function ownedRun(
  executable: string,
  args: string[],
  cwd: string,
  output: string,
  milliseconds: number,
  env: NodeJS.ProcessEnv
): Promise<number | null> {
  assert.equal(process.platform, 'linux', 'Birth-fenced fixture requires Linux');
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const logs: string[] = [];
  let logBytes = 0;
  const append = (data: Buffer) => {
    const remaining = 1024 * 1024 - logBytes;
    if (remaining > 0) {
      logs.push(data.subarray(0, remaining).toString());
      logBytes += Math.min(data.length, remaining);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let exitCode: number | null | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  void closed.catch(() => undefined);
  let owner: Awaited<ReturnType<typeof processIdentity>> = null;
  let cleanup: ReturnType<typeof stopOwnedGroup> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let acceptedCode: number | null | undefined;
  try {
    assert.ok(child.pid, 'Owned child did not spawn');
    owner = await processIdentity(child.pid);
    assert.ok(owner, 'Child vanished before birth fence; cleanup unknown');
    assert.equal(owner.group, owner.pid);
    await writeFile(
      join(output, 'owned-process.json'),
      JSON.stringify({ owner, executable, args, cwd }, null, 2)
    );
    const deadline = new Promise<never>((_done, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('Owned fixture deadline expired'));
      }, milliseconds);
    });
    acceptedCode = await Promise.race([closed, deadline]);
    assert.equal(expired, false, 'Late close cannot reverse expired deadline');
    return acceptedCode;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      assert.ok(owner, 'No birth fence; no group signal authorized');
      const result = await (cleanup ??= stopOwnedGroup(owner));
      await writeFile(
        join(output, 'owned-group-cleanup.json'),
        JSON.stringify({ ...result, expired, exitCode, acceptedCode }, null, 2)
      );
      assert.deepEqual(result.remaining, [], 'Unconfirmed owned cleanup');
    } catch (error) {
      await writeFile(
        join(output, 'owned-group-cleanup-error.json'),
        JSON.stringify({ owner, expired, error: String(error) }, null, 2)
      );
      throw error;
    } finally {
      await writeFile(join(output, 'electron.log'), logs.join(''));
    }
  }
}
if (process.argv[2] === '--negative-lifecycle') {
  const output = resolve(process.argv[3]!);
  await mkdir(output, { recursive: false });
  await assert.rejects(
    ownedRun(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(import.meta.url),
        '--pipe-root',
        output,
      ],
      output,
      output,
      3000,
      { PATH: process.env.PATH, HOME: output }
    ),
    /deadline expired/
  );
  assert.equal(
    JSON.parse(await readFile(join(output, 'control-receipt.json'), 'utf8')).valid,
    true
  );
  const cleanup = JSON.parse(await readFile(join(output, 'owned-group-cleanup.json'), 'utf8'));
  assert.equal(cleanup.exitCode, 0);
  assert.equal(cleanup.expired, true);
  assert.equal(cleanup.acceptedCode, undefined);
  assert.deepEqual(cleanup.remaining, []);
  assert.ok(cleanup.sigkill.length > 0);
  console.log(
    'PASS bounded deadline counterexample: root exit0, descendant pipe, irreversible failure, zero owned live'
  );
  process.exit(0);
}
if (process.argv[2] === '--negative-input') {
  const input = resolve(process.argv[3]!);
  const output = resolve(process.argv[4]!);
  await mkdir(output, { recursive: false });
  await verifyInput(input);
  for (const extension of ['', '.map']) {
    const probe = join(output, extension ? 'tampered-map' : 'tampered-js');
    await cp(input, probe, { recursive: true });
    const file = sourcePath(probe, EXPECTED[0].relativeFile + extension);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(' ')]));
    await assert.rejects(verifyInput(probe), /Retained (?:JS|original map) digest differs/);
  }
  await writeFile(
    join(output, 'negative-input.json'),
    JSON.stringify({
      validInput: true,
      tamperedJsRejected: true,
      tamperedMapRejected: true,
      electronSpawns: 0,
    })
  );
  console.log('PASS retained input integrity: tampered JS/maps rejected before launch');
  process.exit(0);
}
if (process.argv[2] === '--negative-receipt') {
  const receiptBytes = await bounded(resolve(process.argv[3]!));
  const receipt = JSON.parse(receiptBytes.toString()) as {
    appRoot: string;
    chain: Chain;
    artifactMode: string;
  };
  const preserve = receipt.artifactMode === 'preserve';
  validateChain(receipt.chain, receipt.appRoot, preserve);
  const probes: Record<string, (chain: Chain) => void> = {
    missingStage: (chain) => {
      delete chain['renderer-afterNormalize'];
    },
    wrongEventId: (chain) => {
      chain['renderer-early']!.event_id = '0123456789abcdef0123456789abcdef';
    },
    wrongProcess: (chain) => {
      chain['renderer-early']!.tags!['event.process'] = 'main';
    },
    finalMutation: (chain) => {
      chain['renderer-transport']!.debug_meta!.images![0]!.debug_id = preserve
        ? '[redacted]'
        : EXPECTED[2].debugId;
    },
    pairLoss: (chain) => {
      chain['renderer-ipc']!.debug_meta!.images!.pop();
    },
    wrongFinalLocator: (chain) => {
      chain['main-transport']!.debug_meta!.images![0]!.code_file = 'app:///impostor.js';
    },
  };
  for (const [name, mutate] of Object.entries(probes)) {
    const chain = structuredClone(receipt.chain);
    mutate(chain);
    assert.throws(() => validateChain(chain, receipt.appRoot, preserve), { name: 'Error' }, name);
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      sourceReceipt: digest(receiptBytes),
      rejectedMutations: Object.keys(probes),
    })
  );
  process.exit(0);
}
const fixtureArgs = process.argv.slice(2).filter((argument) => argument !== '--preserve');
const preserve = process.argv.includes('--preserve');
const negativeObservation = fixtureArgs[0] === '--negative-observation';
const inputArg = fixtureArgs[negativeObservation ? 1 : 0];
const outputArg = fixtureArgs[negativeObservation ? 2 : 1];
assert.ok(inputArg && outputArg, 'Supply retained producer proof and NEW output directory');
const input = resolve(inputArg);
const output = resolve(outputArg);
await mkdir(output, { recursive: false });
const appDir = join(output, 'synthetic app');
const home = join(output, 'home');
await Promise.all([mkdir(appDir), mkdir(home), mkdir(join(output, 'evidence'))]);
// Reject changed retained JS/maps before any build or Electron launch.
const pairs = await verifyInput(input);
const requireHarness = createRequire(import.meta.url);
const sdkEntry = requireHarness.resolve('@sentry/electron/main');
const sdkPackage = JSON.parse(await readFile(join(dirname(sdkEntry), '../package.json'), 'utf8'));
assert.equal(sdkPackage.version, '7.10.0');
const core = createRequire(sdkEntry)('@sentry/core') as { SDK_VERSION: string };
assert.equal(core.SDK_VERSION, '10.42.0');
await symlink(
  join(repository, 'node_modules'),
  join(appDir, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir'
);

for (const target of ['main', 'renderer'])
  await cp(
    join(input, target),
    join(appDir, target === 'main' ? 'dist-electron/main' : 'out/renderer'),
    { recursive: true }
  );
await verifyInput(input, appDir);
await writeFile(
  join(appDir, 'package.json'),
  JSON.stringify({
    name: 'sentry-sdk-synthetic-fixture',
    version: '0.0.0',
    main: 'fixture-main.cjs',
  })
);
await writeFile(
  join(appDir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
    },
  })
);
for (const kind of ['main', 'preload', 'renderer'] as const) {
  await build({
    configFile: false,
    root: appDir,
    envDir: appDir,
    logLevel: 'silent',
    resolve: { alias: { '@shared': join(repository, 'src/shared') } },
    define: {
      __APP_VERSION__: '"inventory-sandbox"',
      __BUILD_GIT_SHA__: JSON.stringify(IDENTITY.gitSha),
      __BUILD_ID__: JSON.stringify(IDENTITY.buildId),
      __FIXTURE_PRESERVE_ARTIFACTS__: JSON.stringify(preserve),
      __RELEASE_CHANNEL__: '"development"',
      __SENTRY_ENVIRONMENT__: '"development"',
    },
    esbuild: {
      tsconfigRaw: {
        compilerOptions: { target: 'ES2023' },
      },
    },
    build: {
      outDir: appDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: kind === 'renderer' ? 'chrome142' : 'node22',
      lib: {
        entry: fileURLToPath(new URL(`./${kind}.mts`, import.meta.url)),
        name: `Fixture${kind}`,
        formats: kind === 'renderer' ? ['iife'] : ['cjs'],
        fileName: () => `fixture-${kind}.${kind === 'renderer' ? 'js' : 'cjs'}`,
      },
      rollupOptions: {
        external: kind === 'renderer' ? [] : ['electron', '@sentry/electron/main', /^node:/],
      },
    },
  });
}
const htmlPath = join(appDir, 'out/renderer/index.html');
const html = await readFile(htmlPath, 'utf8');
const marker = `<script id="${SENTRY_INVENTORY_PAYLOAD_ID}" type="application/json">`;
assert.equal(html.split(marker).length, 2, 'Exactly one genuine producer inventory payload');
const inventoryStart = html.indexOf(marker);
const inventoryClose = html.indexOf('</script>', inventoryStart + marker.length);
assert.ok(inventoryClose >= inventoryStart + marker.length, 'Inventory payload has a closing tag');
const inventoryEnd = inventoryClose + '</script>'.length;
const moduleStart = html.indexOf('<script type="module"');
assert.ok(
  inventoryStart >= 0 && inventoryEnd > inventoryStart && moduleStart >= inventoryEnd,
  'Producer payload must end before the original module'
);
await writeFile(
  htmlPath,
  html.slice(0, inventoryEnd) +
    '<script src="../../fixture-renderer.js"></script>' +
    html.slice(inventoryEnd)
);
await writeFile(
  join(output, 'input-byte-proof.json'),
  JSON.stringify(
    {
      sourcePairs: pairs,
      sdkVersion: sdkPackage.version,
      coreVersion: core.SDK_VERSION,
      sourceInventory: EXPECTED,
    },
    null,
    2
  )
);
const electron = requireHarness('electron') as string;
const args = [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), appDir];
assert.equal(
  process.platform,
  'linux',
  'First SDK receipt requires Linux birth-fenced process cleanup'
);
const code = await ownedRun(electron, args, appDir, output, 60_000, {
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY,
  HOME: home,
  USERPROFILE: home,
  NODE_ENV: 'test',
  ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  SENTRY_FIXTURE_DUPLICATE_OBSERVATION: negativeObservation ? '1' : undefined,
});
if (negativeObservation) {
  assert.equal(code, 1, 'First valid SDK chain must not hide duplicate observation failure');
  const base = JSON.parse(
    (await bounded(join(output, 'evidence/observation-base.json'))).toString()
  ) as { appRoot: string; chain: Chain };
  validateChain(base.chain, base.appRoot, preserve);
  const failures = JSON.parse(
    (await bounded(join(output, 'evidence/capture-failures.json'))).toString()
  ) as string[];
  assert.ok(
    failures.some((message) => message.includes('Duplicate SDK capture stage: main-early'))
  );
  const failure = JSON.parse((await bounded(join(output, 'evidence/failure.json'))).toString()) as {
    message: string;
    captureFailures: string[];
  };
  assert.match(failure.message, /Persistent SDK observation failure/);
  assert.deepEqual(failure.captureFailures, failures);
  assert.equal(
    await stat(join(output, 'evidence/sdk-receipt.json')).catch(() => null),
    null,
    'Failed capture must not publish acceptance receipt'
  );
  console.log(
    JSON.stringify({
      output,
      status: 'PASS',
      gate: 'real SDK duplicate observation rejected after first valid chain',
      captureFailures: failures,
    })
  );
  process.exit(0);
}
assert.equal(
  code,
  0,
  `Synthetic SDK failed; inspect ${output}/evidence/failure.json and electron.log`
);
const receipt = JSON.parse(
  (await bounded(join(output, 'evidence/sdk-receipt.json'))).toString()
) as {
  currentRedactorCorruptsValidIds: boolean;
  captured: string[];
  boundary: string;
  chain: Chain;
  appRoot: string;
  inputByteProof: { sourcePairs: Pair[] };
  captureFailures: string[];
  artifactMode: string;
  artifactPairsPreserved: boolean;
};
assert.equal(receipt.currentRedactorCorruptsValidIds, !preserve);
assert.equal(receipt.artifactPairsPreserved, preserve);
assert.equal(receipt.artifactMode, preserve ? 'preserve' : 'baseline');
assert.deepEqual(receipt.captureFailures, []);
assert.equal(await stat(join(output, 'evidence/capture-failures.json')).catch(() => null), null);
assert.deepEqual(new Set(receipt.captured), new Set(['main', 'worker', 'renderer']));
assert.deepEqual(receipt.inputByteProof.sourcePairs, pairs);
validateChain(receipt.chain, receipt.appRoot, preserve);
await verifyInput(input, appDir);
console.log(JSON.stringify({ output, status: 'PASS', boundary: receipt.boundary }));
