import { canonicalJson, exactRecord, sha256 } from './supervisor/canonical';
import { OPENCODE_IDENTITIES, type FilePin, type IntegrationDescriptor } from './contracts';
import { OWNER_V2_ARGV, type OwnerSourceInvocation } from './owner-child-protocol';

export type PrivateOwnerImagePin = FilePin & { readonly root: 'p3b2'; readonly mode: 320 };
export interface OwnerLaunchSelectionV2 {
  readonly protocolVersion: 2;
  readonly recipeSha256: string;
  readonly executable: PrivateOwnerImagePin;
  readonly helper: PrivateOwnerImagePin;
  readonly source: OwnerSourceInvocation;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`p3c_owner_recipe_v2_${reason}`);
}
function parseCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`p3c_${label}_json`); }
  if (canonicalJson(value) !== bytes.toString('utf8')) throw new Error(`p3c_${label}_noncanonical`);
  return value as Record<string, unknown>;
}
function privateImage(value: unknown): PrivateOwnerImagePin {
  const p = exactRecord(value, ['root', 'relativePath', 'sha256', 'size', 'mode', 'device', 'inode', 'nlink'], 'owner_image');
  check(p.root === 'p3b2' && p.mode === 0o500 && p.nlink === 1 && Number.isSafeInteger(p.size) &&
    Number(p.size) > 0 && Number(p.size) <= 1024 ** 3, 'image_metadata');
  check(typeof p.relativePath === 'string' && /^[\x21-\x7e]{1,512}$/u.test(p.relativePath) &&
    !p.relativePath.includes('\\') && p.relativePath.split('/').every(s => s && s !== '.' && s !== '..'), 'image_path');
  check(typeof p.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(p.sha256), 'image_digest');
  for (const n of [p.device, p.inode]) check(typeof n === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(n) &&
    BigInt(n) <= 0xffffffffffffffffn, 'image_identity');
  check(p.inode !== '0', 'image_inode');
  return Object.freeze({ ...p }) as unknown as PrivateOwnerImagePin;
}
/**
 * The independently authenticated P3.C1 freeze binds recipeSha256 AND closureMerkleRoot
 * (preflight.verifyControlDocuments). Package recipe bytes first, then enumerate/hash the complete closure,
 * including the recipe, then freeze both digests. V2 must not embed its enclosing root.
 * This parser checks recipe bytes against that descriptor; it does not grant freeze authority.
 */
export function verifyP3B2Recipe(bytes: Buffer, descriptor: IntegrationDescriptor): OwnerLaunchSelectionV2 | undefined {
  const value = parseCanonicalObject(bytes, 'p3b2_recipe');
  if (value.schemaVersion === 1) { verifyLegacyP3B2Recipe(bytes, descriptor); return undefined; }
  const r = exactRecord(value, ['schemaVersion', 'purpose', 'sourceBaseCommit', 'resultCommit', 'entry',
    'supervisor', 'candidateOpenCodeSha256', 'argv', 'sourceTreeRequired', 'accepted',
    'sourceInvocation', 'launchHelper'], 'owner_recipe_v2');
  const selected = descriptor.p3b2;
  check(r.schemaVersion === 2 && r.purpose === 'agent-teams.p3b2.source-actual-owner-entry/v2' &&
    sha256(bytes) === selected.recipeSha256 && sha256(bytes) === selected.recipe.sha256, 'version_digest');
  check(r.sourceBaseCommit === selected.sourceBaseCommit && r.resultCommit === selected.resultCommit &&
    canonicalJson(r.entry) === canonicalJson({ relativePath: selected.entry.relativePath, sha256: selected.entry.sha256 }) &&
    canonicalJson(r.supervisor) === canonicalJson({ relativePath: selected.supervisor.relativePath, sha256: selected.supervisor.sha256 }) &&
    r.accepted === true && r.sourceTreeRequired === true &&
    r.candidateOpenCodeSha256 === descriptor.openCode.linuxX64Binary.sha256 &&
    r.candidateOpenCodeSha256 === descriptor.openCode.identities.linuxX64BinarySha256, 'binding');
  const source = exactRecord(r.sourceInvocation, ['format', 'executable', 'module'], 'owner_source');
  const module = exactRecord(source.module, ['path', 'sha256'], 'owner_source_module');
  const executable = privateImage(source.executable), helper = privateImage(r.launchHelper);
  check(source.format === 'agent-teams.hosted-owner-source-invocation/v1' &&
    module.path === `/p3b2/${selected.entry.relativePath}` && module.sha256 === selected.entry.sha256 &&
    /\.(?:ts|tsx|mts)$/u.test(selected.entry.relativePath), 'module');
  const pins = [executable, helper, selected.entry, selected.supervisor, selected.recipe];
  check(new Set(pins.map(p => p.relativePath)).size === pins.length &&
    new Set(pins.map(p => `${p.device}:${p.inode}`)).size === pins.length, 'image_alias');
  check(canonicalJson(r.argv) === canonicalJson(['run', module.path, ...OWNER_V2_ARGV]), 'argv');
  return Object.freeze({ protocolVersion: 2, recipeSha256: selected.recipeSha256, executable, helper,
    source: Object.freeze({ format: 'agent-teams.hosted-owner-source-invocation/v1',
      executable: Object.freeze({ device: executable.device, inode: executable.inode, sha256: executable.sha256 }),
      module: Object.freeze({ path: module.path as string, sha256: selected.entry.sha256 }) }) });
}
function verifyLegacyP3B2Recipe(bytes: Buffer, descriptor: IntegrationDescriptor): void {
  const recipe = exactRecord(
    parseCanonicalObject(bytes, 'p3b2_recipe'),
    [
      'schemaVersion',
      'purpose',
      'sourceBaseCommit',
      'resultCommit',
      'entry',
      'supervisor',
      'closureMerkleRoot',
      'candidateOpenCodeSha256',
      'argv',
      'sourceTreeRequired',
      'accepted',
    ],
    'p3b2_recipe'
  );
  const entry = exactRecord(recipe.entry, ['relativePath', 'sha256'], 'p3b2_recipe_entry');
  const supervisor = exactRecord(
    recipe.supervisor,
    ['relativePath', 'sha256'],
    'p3b2_recipe_supervisor'
  );
  if (
    recipe.schemaVersion !== 1 ||
    recipe.purpose !== 'agent-teams.p3b2.built-actual-owner-entry/v1' ||
    recipe.sourceBaseCommit !== descriptor.p3b2.sourceBaseCommit ||
    recipe.resultCommit !== descriptor.p3b2.resultCommit ||
    entry.relativePath !== descriptor.p3b2.entry.relativePath ||
    entry.sha256 !== descriptor.p3b2.entry.sha256 ||
    supervisor.relativePath !== descriptor.p3b2.supervisor.relativePath ||
    supervisor.sha256 !== descriptor.p3b2.supervisor.sha256 ||
    recipe.closureMerkleRoot !== descriptor.p3b2.closure.merkleRoot ||
    recipe.candidateOpenCodeSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    canonicalJson(recipe.argv) !==
      canonicalJson(['--runtime-manifest', '/sandbox/runtime-manifest.json']) ||
    recipe.sourceTreeRequired !== false ||
    recipe.accepted !== true
  )
    throw new Error('p3c_p3b2_recipe_binding');
}

export function selectedOwnerImages(selection?: OwnerLaunchSelectionV2): readonly FilePin[] {
  return selection === undefined ? [] : [selection.executable, selection.helper];
}
