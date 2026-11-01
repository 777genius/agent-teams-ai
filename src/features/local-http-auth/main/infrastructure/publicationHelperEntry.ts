// This entry is independently bundled and never imported by the application.
import {
  encodeFrame,
  HELPER_MARKER,
  HelperFrames,
  parsePublicationRequest,
} from './publicationHelperProtocol';

declare const PUBLICATION_HELPER_BUILD_ID: string;

async function main(): Promise<void> {
  const expected = process.argv[3];
  const type = (process as NodeJS.Process & { type?: string }).type;
  const electron = process.versions.electron;
  const major = Number(process.versions.node.split('.')[0]);
  // Verify actual execution mode BEFORE request input or ANY profile filesystem work.
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== HELPER_MARKER ||
    type !== undefined ||
    ![24, 26].includes(major) ||
    (expected !== 'node' && expected !== 'electron-node') ||
    (expected === 'node' ? !!electron : !electron)
  )
    throw new Error('Unsupported helper mode');
  const { DatabaseSync } = await import('node:sqlite');
  if (
    typeof DatabaseSync !== 'function' ||
    typeof DatabaseSync.prototype.exec !== 'function' ||
    typeof DatabaseSync.prototype.close !== 'function'
  )
    throw new Error('Unsupported helper runtime');
  // Writes deliberately have no log fallback. A failed final delivery never replays.
  const send = (value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      process.stdout.write(encodeFrame(value), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  process.stdout.on('error', () => {
    process.exitCode = 1;
  });
  await send({
    v: 1,
    kind: 'ready',
    buildId: PUBLICATION_HELPER_BUILD_ID,
    mode: expected,
  });
  const frames = new HelperFrames(1);
  let input: unknown;
  for await (const chunk of process.stdin) {
    const values = frames.push(Buffer.from(chunk as Uint8Array));
    if (values.length) input = values[0];
  }
  frames.end(1);
  const request = parsePublicationRequest(input);
  const [
    { performPublication },
    { withPublicationLock },
    { privateDirectory },
    { preparePrivateFileDirectory },
  ] = await Promise.all([
    import('./authorityPublicationWorkflow'),
    import('./publicationLock'),
    import('./privateFiles'),
    import('./privateDirectories'),
  ]);
  let outcome: Awaited<ReturnType<typeof performPublication>>;
  try {
    if (request.rootMode === 'prepare-standalone-private')
      await preparePrivateFileDirectory(
        (await import('node:path')).join(request.root, '.profile-root'),
      );
    const directory = await privateDirectory(request.root);
    outcome = await withPublicationLock(directory, DatabaseSync, () =>
      performPublication(request),
    );
  } catch {
    outcome = { outcome: 'failed', hintAction: 'keep', code: 'storage-failed' };
  }
  await send({ v: 1, kind: 'result', id: request.id, ...outcome });
}
void main().catch(() => {
  process.exitCode = 1;
});
