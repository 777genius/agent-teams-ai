import { z } from 'zod';

const value = z
  .string()
  .max(64 * 1024)
  .refine((item) => !item.includes('\0'));
const name = z.string().regex(/^[\w.-]{1,100}$/u);
const scope = z.enum(['user', 'global', 'project', 'local']);
const pluginScope = z.enum(['user', 'project', 'local']);
const qualifiedName = z
  .string()
  .max(512)
  .regex(/^[\w.-]+@[\w.-]+$/u);
const headers = z
  .array(z.object({ key: z.string().regex(/^[A-Za-z][\w-]{0,100}$/u), value }).strict())
  .max(128);
const envValues = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,100}$/iu), value);
const npmPackage = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?:@[\w.-]+\/)?[\w.-]+$/u)
  .refine((item) => !item.startsWith('-') && item !== '.' && item !== '..');
const npmVersion = z
  .string()
  .min(1)
  .max(256)
  .refine((item) => !/[\0\r\n\s]/u.test(item));
const url = z
  .string()
  .max(16384)
  .refine((item) => {
    try {
      return ['https:', 'http:'].includes(new URL(item).protocol);
    } catch {
      return false;
    }
  });
const installSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), npmPackage, npmVersion: npmVersion.optional() }).strict(),
  z
    .object({
      type: z.literal('http'),
      url,
      transportType: z.enum(['sse', 'http', 'streamable-http']).optional(),
    })
    .strict(),
]);

/** Finite Main-resolved install targets, never arbitrary command/argv or a renderer filesystem selector. */
export const nativeExtensionCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plugin.install'), qualifiedName, scope: pluginScope }).strict(),
  z.object({ action: z.literal('plugin.uninstall'), qualifiedName, scope: pluginScope }).strict(),
  z
    .object({
      action: z.literal('mcp.install'),
      serverName: name,
      scope,
      installSpec,
      envValues,
      headers,
    })
    .strict(),
  z.object({ action: z.literal('mcp.uninstall'), serverName: name, scope }).strict(),
]);
export type NativeExtensionCommand = z.infer<typeof nativeExtensionCommandSchema>;
export interface CompiledExtensionCommand {
  readonly panel: 'plugins' | 'mcp';
  readonly requestedScope: NativeExtensionCommand['scope'];
  readonly nativeScope: 'user' | 'project' | 'local';
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** Preserve the old scope alias only at the captured Claude configuration target. */
export function compileNativeExtensionCommand(raw: unknown): CompiledExtensionCommand {
  const input = nativeExtensionCommandSchema.parse(raw);
  const nativeScope = input.scope === 'global' ? 'user' : input.scope;
  if (input.action === 'plugin.install' || input.action === 'plugin.uninstall') {
    return {
      panel: 'plugins',
      requestedScope: input.scope,
      nativeScope,
      args: [
        'plugin',
        input.action === 'plugin.install' ? 'install' : 'uninstall',
        '-s',
        nativeScope,
        input.qualifiedName,
      ],
      timeoutMs: input.action === 'plugin.install' ? 120_000 : 30_000,
    };
  }
  const args = ['mcp', input.action === 'mcp.install' ? 'add' : 'remove', '-s', nativeScope];
  if (input.action === 'mcp.install') {
    for (const [key, item] of Object.entries(input.envValues))
      if (item) args.push('-e', `${key}=${item}`);
    if (input.installSpec.type === 'stdio') {
      const pkg = input.installSpec.npmVersion
        ? `${input.installSpec.npmPackage}@${input.installSpec.npmVersion}`
        : input.installSpec.npmPackage;
      args.push(input.serverName, '--', 'npx', '-y', pkg);
    } else {
      args.push('-t', input.installSpec.transportType === 'sse' ? 'sse' : 'http');
      for (const header of input.headers)
        if (header.value) args.push('-H', `${header.key}: ${header.value}`);
      args.push(input.serverName, input.installSpec.url);
    }
  } else args.push(input.serverName);
  return { panel: 'mcp', requestedScope: input.scope, nativeScope, args, timeoutMs: 30_000 };
}
