import { z } from 'zod';
export { nativeExtensionCommandSchema } from './nativeCommands.js';
export type { NativeExtensionCommand } from './nativeCommands.js';
export type {
  InstalledPluginEntry,
  InstalledMcpEntry,
  McpServerDiagnostic,
  McpServerHealthStatus,
  PluginInstallScope,
} from './contracts.js';

const id = z.string().min(1).max(256),
  digest = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.enum(['user', 'global', 'project', 'local']);
const common = {
  profileId: id,
  configRevision: id,
  targetId: digest,
  panel: z.enum(['plugins', 'mcp']),
  scope,
};
export const nativeExtensionTargetSchema = z.object(common).strict();
const plugin = z
  .object({
    pluginId: z.string(),
    scope: z.enum(['user', 'project', 'local']),
    version: z.string().optional(),
    installedAt: z.string().optional(),
    installPath: z.string().optional(),
  })
  .strict();
const mcp = z
  .object({
    name: z.string(),
    scope,
    transport: z.string().optional(),
    targetKey: z.string().optional(),
  })
  .strict();
const diagnostic = z
  .object({
    name: z.string(),
    target: z.string(),
    scope: z.enum(['local', 'user', 'project', 'global', 'dynamic', 'managed']).optional(),
    transport: z.string().optional(),
    status: z.enum(['connected', 'needs-authentication', 'failed', 'unknown']),
    statusLabel: z.string(),
    rawLine: z.string(),
    checkedAt: z.number().finite().nonnegative(),
  })
  .strict();
export const nativePluginStateSchema = z
  .object({
    ...common,
    panel: z.literal('plugins'),
    entries: z.array(plugin).max(10000),
    installCounts: z.array(z.tuple([z.string(), z.number().int().nonnegative()])).max(10000),
  })
  .strict();
export const nativeMcpStateSchema = z
  .object({ ...common, panel: z.literal('mcp'), entries: z.array(mcp).max(10000) })
  .strict();
export const nativeMcpDiagnosticsSchema = z
  .object({ ...common, panel: z.literal('mcp'), entries: z.array(diagnostic).max(10000) })
  .strict();
export const nativeExtensionReceiptSchema = z
  .object({
    commandId: id,
    profileId: id,
    configRevision: id,
    targetId: digest,
    action: z.enum(['plugin.install', 'plugin.uninstall', 'mcp.install', 'mcp.uninstall']),
    scope,
    phase: z.enum(['completed', 'failed', 'held']),
  })
  .strict();
export type NativeExtensionTarget = z.infer<typeof nativeExtensionTargetSchema>;
