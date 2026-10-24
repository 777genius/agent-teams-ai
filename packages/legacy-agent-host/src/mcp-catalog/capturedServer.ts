import { z } from 'zod';

const value = z
  .string()
  .max(64 * 1024)
  .refine((value) => !value.includes('\0'));
const strings = z.record(z.string().min(1).max(256), value);
const command = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/[\0\r\n]/u.test(value));
const remote = {
  url: z
    .string()
    .url()
    .max(8192)
    .refine((value) => /^https?:\/\//u.test(value)),
  headers: strings.optional(),
};

/** Private selected native configurations; no SDK-server callbacks or runtime-supplied config. */
export const capturedMcpServerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stdio'),
      command,
      args: z.array(value).max(256).optional(),
      env: strings.optional(),
    })
    .strict(),
  z.object({ type: z.literal('http'), ...remote }).strict(),
  z.object({ type: z.literal('sse'), ...remote }).strict(),
]);
export const capturedMcpServersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) =>
          !/[\0\r\n]/u.test(value) && !['team', 'agent-teams'].includes(value.toLowerCase())
      ),
    capturedMcpServerSchema
  )
  .refine(
    (value) =>
      Object.keys(value).length <= 256 && Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024
  );

export type CapturedMcpServer = z.infer<typeof capturedMcpServerSchema>;
export type CapturedMcpServers = z.infer<typeof capturedMcpServersSchema>;

/** Native transport defaults match the existing catalog's command-first detection. */
export function captureSelectedMcpServers(
  selected: Record<string, Record<string, unknown>>
): CapturedMcpServers {
  const result: Record<string, CapturedMcpServer> = Object.create(null);
  for (const [name, original] of Object.entries(selected)) {
    if (original.enabled === false || original.disabled === true) continue;
    const { enabled: _enabled, disabled: _disabled, ...config } = original;
    const type = config.type ?? (typeof config.command === 'string' ? 'stdio' : 'http');
    result[name] = capturedMcpServerSchema.parse({ ...config, type });
  }
  return capturedMcpServersSchema.parse(result);
}
