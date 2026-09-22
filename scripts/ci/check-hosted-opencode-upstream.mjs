import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;
const DOWNSTREAM_VERSION = /^(\d+)\.(\d+)\.(\d+)-agentteams\.\d+$/u;

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function inspectOpenCodeUpstream(lock, release) {
  const downstream = DOWNSTREAM_VERSION.exec(lock?.version ?? '');
  const upstream = STABLE_TAG.exec(release?.tag_name ?? '');
  if (
    lock?.runtime !== 'opencode' ||
    lock?.source?.repository !== '777genius/opencode-anomaly' ||
    !downstream ||
    !upstream ||
    typeof release?.html_url !== 'string'
  ) {
    throw new Error('hosted_opencode_upstream_metadata_invalid');
  }
  const pinned = downstream.slice(1).map(Number);
  const latest = upstream.slice(1).map(Number);
  return Object.freeze({
    drifted: compareVersions(pinned, latest) < 0,
    latestTag: release.tag_name,
    latestUrl: release.html_url,
    pinnedTag: `v${pinned.join('.')}`,
  });
}

export function renderReport(result) {
  const status = result.drifted ? 'UPDATE REQUIRED' : 'CURRENT';
  return (
    `# OpenCode upstream tracking\n\n` +
    `Status: **${status}**\n\n` +
    `- Agent Teams downstream base: \`${result.pinnedTag}\`\n` +
    `- Latest upstream stable: [\`${result.latestTag}\`](${result.latestUrl})\n` +
    `- Policy: \`docs/hosted-opencode-downstream-policy.md\`\n\n` +
    (result.drifted
      ? 'Port only the bounded hosted-approval patch, rebuild immutable artifacts, run compatibility and sandbox actual-owner E2E, then update both product and orchestrator pins.\n'
      : 'No downstream port is currently required.\n')
  );
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index === args.length - 1) throw new Error(`missing_argument:${flag}`);
  return resolve(args[index + 1]);
}

async function main(args) {
  const lockPath = valueAfter(args, '--lock');
  const releasePath = valueAfter(args, '--upstream-release');
  const reportPath = valueAfter(args, '--report');
  const [lock, release] = await Promise.all(
    [lockPath, releasePath].map(async (path) => JSON.parse(await readFile(path, 'utf8')))
  );
  const result = inspectOpenCodeUpstream(lock, release);
  const report = renderReport(result);
  await writeFile(reportPath, report, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: 'a' });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.drifted ? 2 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  await main(process.argv.slice(2));
}
