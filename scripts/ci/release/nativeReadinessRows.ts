export interface NativeScenarioRow {
  scenario: string;
  workflow: string;
  job: string;
  jobName: string;
  artifact: string;
  path: string;
  execute: string;
  upload: string;
  architecture: 'x64' | 'arm64';
  mode: string;
  kind: 'windows' | 'appimage' | 'package' | 'mac-current' | 'mac-old' | 'mac-manual';
}
const workflow = (name: string) => `.github/workflows/${name}.yml`;
function windowsScenario(
  architecture: NativeScenarioRow['architecture'],
  mode: string,
  suffix: string
): NativeScenarioRow {
  const runner = architecture === 'x64' ? 'windows-2025' : 'windows-11-arm';
  const fresh = mode === 'fresh';
  return {
    scenario: `windows-${architecture}-${mode}`,
    architecture,
    mode,
    kind: 'windows',
    workflow: workflow('updater-windows-ota'),
    job: fresh ? 'fresh-windows' : 'windows-ota',
    jobName: fresh
      ? `fresh-windows (${runner}, ${architecture})`
      : `windows-ota (${runner}, ${mode})`,
    artifact: fresh
      ? `TEST-windows-fresh-${architecture}-${suffix}`
      : `TEST-windows-ota-${architecture}-${mode}-${suffix}`,
    path: 'summary.json',
    execute: fresh
      ? 'Fresh official target installation on a separate native VM'
      : 'Original updater download install and automatic native restart',
    upload: fresh
      ? 'Preserve independently installed target reference and native proof'
      : 'Preserve actual transport installer successor preference and UI proof',
  };
}
// These are closed producer contracts, not caller-supplied success predicates.
export function nativeScenarioRows(runId: number, attempt: number): NativeScenarioRow[] {
  const suffix = `${runId}-${attempt}`;
  const rows: NativeScenarioRow[] = [];
  for (const architecture of ['x64', 'arm64'] as const)
    for (const mode of ['fresh', 'full', 'cold', 'warm'])
      rows.push(windowsScenario(architecture, mode, suffix));
  for (const mode of ['ota', 'fresh'])
    rows.push({
      scenario: `linux-appimage-${mode}`,
      architecture: 'x64',
      mode,
      kind: 'appimage',
      workflow: workflow('updater-native-feasibility'),
      job: 'linux-native-ota',
      jobName: 'linux-native-ota',
      artifact: `TEST-linux-native-ota-${suffix}`,
      path: `${mode}/evidence.json`,
      execute: 'Exercise real OTA and separate fresh target desktop',
      upload: 'Preserve native OTA proof on success and failure',
    });
  for (const [format, image] of [
    ['deb', 'ubuntu:24.04'],
    ['rpm', 'fedora:44'],
    ['pacman', 'archlinux:base'],
  ]) {
    for (const mode of ['ota', 'fresh'])
      rows.push({
        scenario: `linux-${format}-${mode}`,
        architecture: 'x64',
        mode,
        kind: 'package',
        workflow: workflow('updater-linux-packages'),
        job: 'native',
        jobName: `native (${format}, ${image})`,
        artifact: `TEST-linux-${format}-native-${suffix}`,
        path: `TEST-linux-package-evidence/${mode}/native/evidence.json`,
        execute:
          'Real native package install and unprivileged GUI in offline disposable containers',
        upload: 'Preserve real native evidence even on failure',
      });
  }
  for (const architecture of ['arm64', 'x64'] as const) {
    rows.push({
      scenario: `mac-${architecture}-current`,
      architecture,
      mode: 'current',
      kind: 'mac-current',
      workflow: workflow('updater-mac-updater'),
      job: 'mac-current-no-update',
      jobName: `mac-current-no-update (${architecture})`,
      artifact: `TEST-mac-current-no-update-${architecture}-staged-${suffix}`,
      path: 'TEST-mac-updater-evidence/mac-current-no-update.json',
      execute: 'Native signed current Mac app completes genuine no-update with OS containment',
      upload: 'Preserve native UI, Aqua capture, logs, source hashes and failure gates',
    });
    for (const mode of ['older', 'fresh'])
      rows.push({
        scenario: `mac-${architecture}-${mode}`,
        architecture,
        mode,
        kind: 'mac-old',
        workflow: workflow('updater-mac-old-updater'),
        job: 'mac-older-and-fresh',
        jobName: `mac-older-and-fresh (${mode}, ${architecture}, staged)`,
        artifact: `TEST-mac-${mode}-${architecture}-staged-${suffix}`,
        path: `TEST-mac-old-evidence-${mode}/mac-native-result.json`,
        execute: 'Real signed Squirrel OTA or fresh carried install in a separate Aqua VM',
        upload: 'Preserve native OTA, automatic Aqua successor, preferences and binding evidence',
      });
  }
  return rows;
}
export function fullNativeScenarioRows(runId: number, attempt: number): NativeScenarioRow[] {
  const rows = nativeScenarioRows(runId, attempt).filter((row) =>
    ['windows', 'appimage', 'package'].includes(row.kind)
  );
  for (const architecture of ['arm64', 'x64'] as const)
    rows.push({
      scenario: `mac-${architecture}-manual`,
      architecture,
      mode: 'manual',
      kind: 'mac-manual',
      workflow: workflow('updater-mac-manual-migration'),
      job: 'mac-manual',
      jobName: `mac-manual (${architecture})`,
      artifact: `TEST-mac-manual-${architecture}-${runId}-${attempt}`,
      path: 'TEST-mac-manual-evidence/native-manual-receipt.json',
      execute: 'Fresh 219 and original 211 manual replacement in owned sandbox profiles',
      upload: 'Preserve native ownership, preference, signing, runtime and cleanup evidence',
    });
  return rows;
}
