import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const GENUINE_FREE_MODEL = 'opencode/big-pickle';
export const GENUINE_FREE_VERSION = '1.18.31';
export const GENUINE_FREE_CATALOG = 'https://opencode.ai/inference/v1/models';
const CATALOG_LIMIT = 2 * 1024 * 1024;
const ADMISSION_MAX_AGE_MS = 60_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = stage => { throw new Error(`Genuine-free admission failed: ${stage}`); };

export function genuineFreeProjectConfig() {
  return {
    model: GENUINE_FREE_MODEL, small_model: GENUINE_FREE_MODEL,
    enabled_providers: ['opencode'], provider: { opencode: { whitelist: ['big-pickle'] } },
    autoupdate: false, share: 'disabled', plugin: [],
    agent: Object.fromEntries(Object.entries({ teammate: 32, 'teammate-bootstrap': 8,
      'teammate-model-probe': 2, build: 32, plan: 32, general: 32, explore: 32 })
      .map(([name, steps]) => [name, { model: GENUINE_FREE_MODEL, steps }])),
  };
}

// Only an explicit, complete all-zero raw price shape qualifies. Native V1's
// normalized catalog defaults missing prices to zero, so it is not price evidence.
export function validateGenuineFreeCatalog(catalog) {
  if (catalog?.object !== 'list' || !Array.isArray(catalog.data)) fail('catalog-shape');
  const matches = catalog.data.filter(model => model?.id === 'big-pickle');
  const model = matches[0];
  if (matches.length !== 1 || model.owned_by !== 'opencode' || model.type !== 'chat' ||
      model.capabilities?.tools?.supported !== true) fail('catalog-model');
  // This also refuses separate reasoning prices, context tiers, multipliers and
  // any future cost dimension. Reasoning tokens use the documented output price.
  if (!isDeepStrictEqual(model.cost, {
    text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } },
  })) fail('catalog-price');
  return model.cost;
}

export async function preflightGenuineFreeNative(input, { spawn = spawnSync } = {}) {
  const { env, projectPath } = input;
  if (env.OPENCODE_E2E_MODEL !== GENUINE_FREE_MODEL) fail('model-selection');
  if (fs.existsSync(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'))) fail('auth-present');
  const binary = fs.realpathSync(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH);
  const fd = fs.openSync(binary, 'r'), magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('native-elf');
  const run = args => {
    const result = spawn(binary, args, {
      cwd: projectPath, env, encoding: 'utf8', timeout: 90_000, maxBuffer: CATALOG_LIMIT,
    });
    if (result.error || result.signal || result.status !== 0) fail('native-command');
    return result.stdout;
  };
  const version = run(['--version']);
  if (!/^(?:opencode v)?1\.18\.31(?:\r?\n)?$/.test(version) ||
      version.replace(/\r?\n$/, '').includes('\n')) fail('native-version');
  const inventory = run(['models', 'opencode', '--refresh']);
  if (!isDeepStrictEqual(inventory.trim().split(/\r?\n/), [GENUINE_FREE_MODEL]))
    fail('native-inventory');
  const resolvedText = run(['debug', 'config']);
  let resolved;
  try { resolved = JSON.parse(resolvedText); } catch { fail('native-config-json'); }
  const required = genuineFreeProjectConfig();
  for (const [key, value] of Object.entries(required)) {
    if (key === 'agent') {
      for (const [name, bounded] of Object.entries(value)) {
        if (resolved.agent?.[name]?.model !== bounded.model ||
            resolved.agent?.[name]?.steps !== bounded.steps || resolved.agent?.[name]?.disable === true)
          fail('native-agent-bounds');
      }
    } else if (!isDeepStrictEqual(resolved[key], value)) fail('native-config');
  }
  const binaryHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(binary)) binaryHash.update(chunk);
  return { model: GENUINE_FREE_MODEL, nativeVersion: GENUINE_FREE_VERSION,
    binarySha256: binaryHash.digest('hex'), nativeInventorySha256: sha256(inventory),
    resolvedConfigSha256: sha256(resolvedText) };
}

// Called only after all passive native/managed preflight, immediately before the
// unchanged FULL test. This receipt records admission-time pricing, not future pricing.
export async function admitGenuineFreeModel(nativeEvidence, { fetch: fetchCatalog = fetch,
  now = Date.now } = {}) {
  const started = now();
  const response = await fetchCatalog(GENUINE_FREE_CATALOG, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || response.redirected || !response.body ||
      Number(response.headers.get('content-length') ?? 0) > CATALOG_LIMIT) fail('catalog-response');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > CATALOG_LIMIT) fail('catalog-size');
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  let catalog;
  try { catalog = JSON.parse(raw.toString('utf8')); } catch { fail('catalog-json'); }
  const cost = validateGenuineFreeCatalog(catalog), admittedAt = now();
  if (admittedAt < started || admittedAt - started > ADMISSION_MAX_AGE_MS) fail('catalog-stale');
  return { mode: 'genuine-free', ...nativeEvidence, catalogUrl: GENUINE_FREE_CATALOG,
    catalogSha256: sha256(raw), admittedAt: new Date(admittedAt).toISOString(),
    spawnAdmissionExpiresAt: new Date(admittedAt + ADMISSION_MAX_AGE_MS).toISOString(), cost };
}

// Expiry bounds admission of the FULL child, not pricing at each later turn.
// No-account isolation and the single-model config remain the charging boundary.
export function assertGenuineFreeAdmissionFresh(receipt, now = Date.now()) {
  const admitted = Date.parse(receipt.admittedAt), expires = Date.parse(receipt.spawnAdmissionExpiresAt);
  if (receipt.mode !== 'genuine-free' || receipt.model !== GENUINE_FREE_MODEL ||
      !Number.isFinite(admitted) || !Number.isFinite(expires) || now < admitted ||
      now >= expires || expires - admitted !== ADMISSION_MAX_AGE_MS) fail('admission-expired');
}
