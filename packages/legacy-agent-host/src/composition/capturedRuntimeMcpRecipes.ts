import { z } from 'zod';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { captureCodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import { readCapturedMcpBytes } from '../mcp-catalog/capturedFile.js';
import { capturedMcpServersSchema } from '../mcp-catalog/capturedServer.js';
import { capturedMcpSourceSchema } from '../mcp-catalog/capturedSource.js';
import { runtimeMemberProfileSchema } from './runtimeProfile.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { readCodexMcpCatalog } from '../adapters/providers/readCodexMcpCatalog.js';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import type { CodexConfiguredMcpCatalog } from '@agent-teams/provider-implementations/codex';
import type { CodexMemberProfile, RuntimeMemberProfile } from './runtimeProfile.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
export const capturedRuntimeMcpReferencesSchema = z
  .array(z.object({ memberId: id, digest: hash }).strict())
  .max(256)
  .refine((rows) => new Set(rows.map((row) => row.memberId)).size === rows.length);
export type CapturedRuntimeMcpReference = z.infer<
  typeof capturedRuntimeMcpReferencesSchema
>[number];
const overlaySchema = z
  .object({
    capturedMcpServers: capturedMcpServersSchema,
    capturedMcpSource: capturedMcpSourceSchema.optional(),
    mcpPolicyPlugin: z
      .object({ path: z.string().min(1).max(8192).startsWith('/'), sha256: hash })
      .strict()
      .optional(),
    capturedMcpCatalog: z.unknown().optional(),
  })
  .strict();
const artifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: id,
    memberId: id,
    provider: z.enum(['claude', 'codex', 'opencode']),
    baseRecipeDigest: hash,
    cwd: z.string().min(1).max(8192),
    overlay: overlaySchema,
  })
  .strict();
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const held = (): never => {
  throw new TeamLaunchError('hold', 'capture-runtime-mcp-recipe');
};
const locator = (commandId: string, memberId: string) =>
  `launches/mcp-recipes/${runtimeDigest([commandId, memberId])}.json`;

function withoutOverlay(profile: RuntimeMemberProfile) {
  const copy: Record<string, unknown> = { ...profile };
  for (const key of [
    'capturedMcpServers',
    'capturedMcpSource',
    'capturedMcpCatalog',
    'mcpPolicyPlugin',
  ])
    delete copy[key];
  return copy;
}
function reconstruct(
  base: RuntimeMemberProfile,
  overlay: z.infer<typeof overlaySchema>
): RuntimeMemberProfile {
  if (
    (base.provider !== 'codex' && overlay.capturedMcpCatalog !== undefined) ||
    (base.provider !== 'opencode' && overlay.mcpPolicyPlugin !== undefined)
  )
    return held();
  const result = runtimeMemberProfileSchema.parse({ ...withoutOverlay(base), ...overlay });
  if (result.provider === 'codex') {
    if (!result.capturedMcpCatalog) return held();
    captureCodexConfiguredMcpCatalog(result.capturedMcpCatalog);
  }
  return result;
}
function read(
  store: TeamOwnerStore,
  commandId: string,
  base: RuntimeMemberProfile,
  expected?: string
) {
  for (const directory of ['launches', 'launches/mcp-recipes']) {
    try {
      const stat = lstatSync(join(store.directory, directory));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return held();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === undefined)
        return undefined;
      return held();
    }
  }
  let bytes: Buffer | undefined;
  try {
    bytes = readCapturedMcpBytes(
      join(store.directory, locator(commandId, base.memberId)),
      MAX_ARTIFACT_BYTES
    );
  } catch {
    return held();
  }
  if (!bytes) {
    if (expected !== undefined) return held();
    return undefined;
  }
  try {
    const artifact = artifactSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (
      artifact.commandId !== commandId ||
      artifact.memberId !== base.memberId ||
      artifact.provider !== base.provider ||
      artifact.cwd !== base.cwd ||
      artifact.baseRecipeDigest !== runtimeDigest(base) ||
      (expected !== undefined && runtimeDigest(artifact) !== expected)
    )
      return held();
    return {
      artifact,
      recipe: reconstruct(base, artifact.overlay),
      reference: { memberId: base.memberId, digest: runtimeDigest(artifact) },
    };
  } catch {
    return held();
  }
}

/** Existing launch-owned private recipe artifacts. Historical construction performs no catalog IO. */
export async function prepareCapturedRuntimeMcpRecipes(options: {
  store: TeamOwnerStore;
  commandId: string;
  baseRecipes: readonly RuntimeMemberProfile[];
  selectedRecipes: readonly RuntimeMemberProfile[];
  assertCurrent(): void;
  withAuthority<T>(action: () => T): T;
  readCatalog?: (
    profile: CodexMemberProfile,
    assertCurrent: () => void,
    signal?: AbortSignal
  ) => Promise<CodexConfiguredMcpCatalog>;
  signal?: AbortSignal;
}): Promise<CapturedRuntimeMcpReference[]> {
  id.parse(options.commandId);
  if (
    options.baseRecipes.length !== options.selectedRecipes.length ||
    options.baseRecipes.length > 256 ||
    new Set(options.baseRecipes.map((row) => row.memberId)).size !== options.baseRecipes.length
  )
    return held();
  const references: CapturedRuntimeMcpReference[] = [];
  for (const [index, base] of options.baseRecipes.entries()) {
    const selected = options.selectedRecipes[index];
    if (
      !selected ||
      runtimeDigest(withoutOverlay(base)) !== runtimeDigest(withoutOverlay(selected)) ||
      !selected.capturedMcpServers
    )
      return held();
    options.assertCurrent();
    const prior = options.withAuthority(() => read(options.store, options.commandId, base));
    if (prior) {
      references.push(prior.reference);
      continue;
    }
    const overlay: z.infer<typeof overlaySchema> = {
      capturedMcpServers: structuredClone(selected.capturedMcpServers),
      ...(selected.capturedMcpSource
        ? { capturedMcpSource: structuredClone(selected.capturedMcpSource) }
        : {}),
      ...(selected.provider === 'opencode' && selected.mcpPolicyPlugin
        ? { mcpPolicyPlugin: structuredClone(selected.mcpPolicyPlugin) }
        : {}),
    };
    if (selected.provider === 'codex')
      overlay.capturedMcpCatalog = captureCodexConfiguredMcpCatalog(
        await (options.readCatalog ?? readCodexMcpCatalog)(
          selected,
          options.assertCurrent,
          options.signal
        )
      );
    options.assertCurrent();
    reconstruct(base, overlay);
    const artifact = {
      schemaVersion: 1 as const,
      commandId: options.commandId,
      memberId: base.memberId,
      provider: base.provider,
      baseRecipeDigest: runtimeDigest(base),
      cwd: base.cwd,
      overlay,
    };
    if (Buffer.byteLength(JSON.stringify(artifact, null, 2)) + 1 > MAX_ARTIFACT_BYTES)
      return held();
    const reference = options.withAuthority(() => {
      options.assertCurrent();
      const existing = read(options.store, options.commandId, base);
      if (existing) {
        if (runtimeDigest(existing.artifact) !== runtimeDigest(artifact)) return held();
        return existing.reference;
      }
      options.store.write(locator(options.commandId, base.memberId), artifact);
      return read(options.store, options.commandId, base, runtimeDigest(artifact))!.reference;
    });
    references.push(reference);
  }
  return capturedRuntimeMcpReferencesSchema.parse(references);
}

/** A missing/corrupt original is HOLD; a new launch command can capture new current configuration. */
export function loadCapturedRuntimeMcpRecipe(
  store: TeamOwnerStore,
  commandId: string,
  base: RuntimeMemberProfile,
  reference: CapturedRuntimeMcpReference
): RuntimeMemberProfile {
  if (reference.memberId !== base.memberId) return held();
  return read(store, id.parse(commandId), base, hash.parse(reference.digest))!.recipe;
}
