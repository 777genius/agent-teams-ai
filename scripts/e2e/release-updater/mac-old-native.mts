import assert from 'node:assert/strict';
import { resolve4, resolve6 } from 'node:dns/promises';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { connect, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical, digest } from '../../ci/release/contract.ts';
import { waitFor } from './cdp.mts';
import { macProcesses } from './mac-loopback.mts';

import type { MacCommands } from './mac-loopback.mts';

export type MacIdentity = Awaited<ReturnType<typeof macProcesses>>[number];
const label = 'com.agent-teams.app.ShipIt';
const executable = (app: string) => path.join(app, 'Contents', 'MacOS', 'Agent Teams AI');
async function pf(commands: MacCommands, label: string, args: string[]) {
  return commands.checked(label, '/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args]);
}
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export function oldMacCiOnly() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  assert(
    process.env.GITHUB_WORKFLOW_REF?.startsWith(
      '777genius/agent-teams-ai/.github/workflows/updater-mac-old-updater.yml@'
    )
  );
  assert(process.getuid?.() !== 0, 'The existing disposable Aqua account must be unprivileged');
}
async function absent(file: string) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
export async function freshMacHome(commands: MacCommands) {
  oldMacCiOnly();
  const user = (await commands.checked('aqua-account', '/usr/bin/id', ['-un'])).stdout.trim();
  assert.equal(
    (
      await commands.checked('aqua-console', '/usr/bin/stat', ['-f', '%Su', '/dev/console'])
    ).stdout.trim(),
    user
  );
  const record = await commands.checked('physical-account-home', '/usr/bin/dscl', [
    '/Search',
    '-read',
    `/Users/${user}`,
    'NFSHomeDirectory',
  ]);
  const home = await realpath(os.homedir());
  assert.equal(record.stdout.trim(), `NFSHomeDirectory: ${home}`);
  assert.equal(await realpath(process.env.HOME ?? ''), home);
  assert.equal((await stat(home)).uid, process.getuid?.());
  const candidates = [
    'agent-teams-ai',
    'Agent Teams AI',
    'Agent Teams UI',
    'Claude Agent Teams UI',
    'claude-agent-teams-ui',
    'claude-devtools',
    'claude-code-context',
  ].map((name) => path.join(home, 'Library', 'Application Support', name));
  const roots = [
    ...candidates,
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.config', 'opencode'),
    path.join(home, 'Library', 'Caches', label),
    path.join(home, 'Library', 'Caches', 'com.agent-teams.app'),
    path.join(home, 'Library', 'Caches', 'agent-teams-ai-updater'),
  ];
  for (const root of roots)
    assert(
      await absent(root),
      `Fresh disposable account already contains app/provider state: ${root}`
    );
  for (const root of [path.join(home, '.claude'), path.join(home, '.codex')])
    await mkdir(root, { mode: 0o700 });
  return {
    home,
    user,
    uid: process.getuid?.(),
    candidates,
    verifiedAbsentBefore: roots,
    usesPhysicalHome: true,
    overridesRequiredForSuccessor: false,
  };
}

// This CI-generated reader queries the real user launchd domain; it does not replace Squirrel.
const jobSource = `#include <stdio.h>
#include <string.h>
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
int main(int argc, const char **argv) { @autoreleasepool {
  if (argc != 2) return 2;
  CFStringRef label = CFSTR("com.agent-teams.app.ShipIt");
  if (strcmp(argv[1], "--remove-job") == 0) {
    CFErrorRef error = NULL;
    if (!SMJobRemove(kSMDomainUserLaunchd, label, NULL, true, &error)) { if (error) { NSLog(@"%@", (__bridge id)error); CFRelease(error); } return 3; }
  }
  CFDictionaryRef job = SMJobCopyDictionary(kSMDomainUserLaunchd, label);
  NSDictionary *result = job ? @{ @"present": @YES, @"job": (__bridge NSDictionary *)job } : @{ @"present": @NO };
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:&error];
  if (!data) { NSLog(@"%@", error); return 4; }
  fwrite(data.bytes, 1, data.length, stdout);
  if (job) CFRelease(job);
  return 0;
} }
`;
const aquaSource = `import AppKit
import CoreGraphics
import ImageIO
import Vision
import Foundation
func emit(_ object: Any) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) }
let args = CommandLine.arguments
if args[1] == "--apps" {
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.agent-teams.app").map { app -> [String: Any] in
    return ["pid": Int(app.processIdentifier), "bundle": app.bundleURL?.path ?? "", "executable": app.executableURL?.path ?? "", "launchDate": app.launchDate?.timeIntervalSince1970 ?? 0, "finished": app.isFinishedLaunching, "terminated": app.isTerminated, "architecture": app.executableArchitecture]
  }
  try emit(apps)
} else if args[1] == "--windows" {
  guard let pid = Int(args[2]), let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { exit(2) }
  try emit(all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 })
} else if args[1] == "--image" {
  let url = URL(fileURLWithPath: args[2])
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(3) }
  var pixels = [UInt8](repeating: 0, count: 64 * 64 * 4)
  guard let context = CGContext(data: &pixels, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(4) }
  context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
  let colors = Set(stride(from: 0, to: pixels.count, by: 4).map { Int(pixels[$0]) << 16 | Int(pixels[$0 + 1]) << 8 | Int(pixels[$0 + 2]) })
  let mean = stride(from: 0, to: pixels.count, by: 4).reduce(0) { $0 + Int(pixels[$1]) + Int(pixels[$1 + 1]) + Int(pixels[$1 + 2]) } / (64 * 64 * 3)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["en-US"]
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
  try emit(["width": image.width, "height": image.height, "distinctColors": colors.count, "meanRgb": mean, "text": text])
} else { exit(5) }
`;
export async function prepareOldMacNative(commands: MacCommands) {
  const job = path.join(commands.output, 'TEST-launchd-reader');
  const aqua = path.join(commands.output, 'TEST-aqua-reader');
  await writeFile(`${job}.m`, jobSource, { flag: 'wx' });
  await writeFile(`${aqua}.swift`, aquaSource, { flag: 'wx' });
  await commands.checked('compile-launchd-reader', '/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-framework',
    'Foundation',
    '-framework',
    'ServiceManagement',
    `${job}.m`,
    '-o',
    job,
  ]);
  await commands.checked('compile-aqua-reader', '/usr/bin/xcrun', [
    'swiftc',
    `${aqua}.swift`,
    '-o',
    aqua,
  ]);
  return {
    job,
    aqua,
    jobSha256: digest(await readFile(job)),
    aquaSha256: digest(await readFile(aqua)),
  };
}
interface JobReadback {
  present: boolean;
  job?: {
    Label: string;
    ProgramArguments: string[];
    StandardOutPath: string;
    StandardErrorPath: string;
  };
}
async function jobStatus(commands: MacCommands, binary: string) {
  const status = JSON.parse(
    (await commands.checked('shipit-job-dictionary', binary, ['--job'])).stdout
  ) as JobReadback;
  const uid = process.getuid?.();
  let found = false;
  for (const domain of [`gui/${uid}`, `user/${uid}`, 'system']) {
    const result = await commands.run('shipit-launchd-domain', '/bin/launchctl', [
      'print',
      `${domain}/${label}`,
    ]);
    if (result.exitCode === 0) {
      assert(domain !== 'system', 'TEST app must never create a privileged ShipIt job');
      found = true;
    } else
      assert(
        /Could not find (?:service|domain)/.test(result.stderr),
        `Unknown launchd read failure: ${result.logFile}`
      );
  }
  assert.equal(status.present, found, 'Native launchd dictionary and domain readback disagree');
  return status;
}
export async function oldShipItBaseline(commands: MacCommands, binary: string) {
  await commands.checked('aqua-launchd-domain', '/bin/launchctl', [
    'print',
    `gui/${process.getuid?.()}`,
  ]);
  const status = await jobStatus(commands, binary);
  assert.equal(status.present, false, 'Fresh Aqua account must have no previous ShipIt job');
  return status;
}
interface Receipt {
  toolingSha: string;
  uid: number;
  app: string;
  home: string;
  earliest: number;
  native: Awaited<ReturnType<typeof prepareOldMacNative>>;
  attempts: { attempted: true; pid?: number; owner?: MacIdentity }[];
  originalRulesSha256: string;
  originalNatSha256: string;
  originalPolicySha256: string;
  restored: boolean;
  baselineDisabled: true;
  shipItAbsentBefore: true;
}
async function receipt(commands: MacCommands) {
  oldMacCiOnly();
  const value = JSON.parse(
    await readFile(path.join(commands.output, 'pf-owned.json'), 'utf8')
  ) as Receipt;
  const runner = await realpath(process.env.RUNNER_TEMP ?? '');
  assert(
    value.app.startsWith(`${runner}/TEST-mac-old-`) &&
      value.app.endsWith('/TEST-Applications/Agent Teams AI.app')
  );
  assert.equal(await realpath(value.app), value.app);
  assert.equal(value.uid, process.getuid?.());
  assert(
    value.baselineDisabled &&
      value.shipItAbsentBefore &&
      value.toolingSha === process.env.GITHUB_SHA
  );
  assert.equal(await realpath(os.homedir()), value.home);
  assert.equal(value.native.job, path.join(commands.output, 'TEST-launchd-reader'));
  assert.equal(digest(await readFile(value.native.job)), value.native.jobSha256);
  return value;
}
async function save(commands: MacCommands, value: Receipt) {
  await writeFile(path.join(commands.output, 'pf-owned.json'), `${canonical(value)}\n`);
}
export async function oldMacLaunch(
  commands: MacCommands,
  index?: number,
  pid?: number,
  owner?: MacIdentity
) {
  const value = await receipt(commands);
  assert(!value.restored);
  if (index === undefined) {
    value.attempts.push({ attempted: true });
    index = value.attempts.length - 1;
  }
  const attempt = value.attempts[index];
  assert(attempt);
  if (pid !== undefined) {
    assert(Number.isSafeInteger(pid) && pid > 0);
    assert(attempt.pid === undefined || attempt.pid === pid);
    attempt.pid = pid;
  }
  if (owner) {
    assert.equal(attempt.pid, owner.pid);
    assert.equal(owner.command, executable(value.app));
    assert.equal(owner.uid, value.uid);
    attempt.owner = owner;
  }
  await save(commands, value);
  return index;
}
function owns(value: Receipt, entry: MacIdentity) {
  assert.equal(entry.uid, value.uid, 'TEST bundle process has foreign UID');
  assert(entry.command.startsWith(`${value.app}/Contents/`));
  assert(Date.parse(entry.start) >= value.earliest, 'TEST bundle process predates owned install');
  return entry;
}
export async function oldMacAdopt(commands: MacCommands, pid: number) {
  const value = await receipt(commands);
  const entry = (await macProcesses(commands)).find((item) => item.pid === pid);
  assert(entry);
  owns(value, entry);
  assert.equal(entry.command, executable(value.app));
  await oldMacLaunch(commands, undefined, pid, entry);
  return entry;
}
async function validatedJob(commands: MacCommands, value: Receipt, requireState: boolean) {
  const status = await jobStatus(commands, value.native.job);
  if (!status.present) {
    assert(!requireState, 'Native Squirrel completion must have a real ShipIt job');
    return status;
  }
  const job = status.job;
  assert(job);
  assert.equal(job.Label, label);
  assert.equal(job.ProgramArguments.length, 3);
  const [program, actualLabel, state] = job.ProgramArguments;
  assert(program && state);
  assert.equal(actualLabel, label);
  assert(program.startsWith(`${value.app}/Contents/Frameworks/Squirrel.framework/`));
  const expectedProgram = await realpath(
    path.join(value.app, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt')
  );
  assert.equal(await realpath(program), expectedProgram);
  assert.equal((await stat(expectedProgram)).uid, value.uid);
  const cache = path.join(value.home, 'Library', 'Caches', label);
  assert.equal(await realpath(cache), cache);
  assert.equal((await stat(cache)).uid, value.uid);
  assert.equal(state, path.join(cache, 'ShipItState.plist'));
  for (const log of [job.StandardOutPath, job.StandardErrorPath])
    assert(log.startsWith(`${cache}/ShipIt_`) && path.dirname(log) === cache);
  if (await absent(state)) {
    assert(!requireState, 'Downloaded native update has no request state');
    return { ...status, stateMissing: true };
  }
  assert.equal(await realpath(state), state);
  assert.equal((await stat(state)).uid, value.uid);
  const bytes = await readFile(state);
  const request = JSON.parse(bytes.toString()) as {
    targetBundleURL: string;
    updateBundleURL: string;
    launchAfterInstallation: boolean;
  };
  assert.equal(path.resolve(fileURLToPath(request.targetBundleURL)), value.app);
  const update = path.resolve(fileURLToPath(request.updateBundleURL));
  assert(update.startsWith(`${cache}/`));
  const updateConsumed = await absent(update);
  assert(!requireState || !updateConsumed, 'Native downloaded update bundle disappeared');
  if (!updateConsumed) {
    assert.equal(await realpath(update), update);
    assert.equal((await stat(update)).uid, value.uid);
  }
  const proof = {
    ...status,
    request,
    state,
    stateSha256: digest(bytes),
    updateBundle: update,
    updateConsumed,
    uid: value.uid,
    program: expectedProgram,
  };
  await writeFile(
    path.join(commands.output, `shipit-request-${commands.commands.length}.json`),
    `${canonical(proof)}\n`
  );
  return proof;
}
export async function oldMacDownloadedState(commands: MacCommands) {
  return validatedJob(commands, await receipt(commands), true);
}
async function safeSignal(commands: MacCommands, owner: MacIdentity, signal: NodeJS.Signals) {
  const current = (await macProcesses(commands)).find((entry) => entry.pid === owner.pid);
  if (!current) return;
  assert.deepEqual(current, owner, 'PID identity changed; no signal is safe');
  try {
    process.kill(owner.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    assert(
      !(await macProcesses(commands)).some((entry) => entry.pid === owner.pid),
      'Signal raced a reused PID'
    );
  }
}
export async function oldMacStopApps(commands: MacCommands) {
  const value = await receipt(commands);
  assert(
    value.attempts.every((attempt) => attempt.pid !== undefined && attempt.owner),
    'Interrupted launch ownership registration; retain PF without signalling unknown PIDs'
  );
  const before = (await macProcesses(commands)).filter(
    (entry) =>
      entry.command.startsWith(`${value.app}/Contents/`) && !entry.command.endsWith('/ShipIt')
  );
  for (const entry of before) {
    owns(value, entry);
    await safeSignal(commands, entry, 'SIGTERM');
  }
  await pause(1000);
  for (const entry of (await macProcesses(commands)).filter((item) =>
    before.some((owner) => owner.pid === item.pid)
  )) {
    const owner = before.find((item) => item.pid === entry.pid);
    assert(owner);
    assert.deepEqual(entry, owner);
    await safeSignal(commands, owner, 'SIGKILL');
  }
  await waitFor(
    async () =>
      (await macProcesses(commands)).some(
        (entry) =>
          entry.command.startsWith(`${value.app}/Contents/`) && !entry.command.endsWith('/ShipIt')
      )
        ? null
        : true,
    'TEST Mac applications exited',
    5000
  );
  return { before, stopped: true };
}
export async function restoreOldMacNetwork(commands: MacCommands) {
  const value = await receipt(commands);
  assert(
    value.attempts.every((attempt) => attempt.pid !== undefined && attempt.owner),
    'Unresolved spawn ownership; retain PF until VM teardown'
  );
  const job = await validatedJob(commands, value, false);
  if (job.present)
    await commands.checked('remove-owned-shipit-job', value.native.job, ['--remove-job']);
  await oldMacStopApps(commands);
  // No unknown group members are signalled. They block restoration even if the original main exited.
  let since: number | undefined;
  const scans: unknown[] = [];
  await waitFor(
    async () => {
      const processes = await macProcesses(commands);
      const remaining = processes.filter(
        (entry) =>
          entry.command.startsWith(`${value.app}/Contents/`) ||
          value.attempts.some(
            (attempt) =>
              entry.pid === attempt.pid ||
              entry.group === attempt.pid ||
              (attempt.owner &&
                attempt.owner.group === attempt.pid &&
                entry.group === attempt.owner.group)
          )
      );
      const currentJob = await jobStatus(commands, value.native.job);
      scans.push({ at: new Date().toISOString(), remaining, job: currentJob });
      if (remaining.length || currentJob.present) {
        since = undefined;
        return null;
      }
      since ??= Date.now();
      return Date.now() - since >= 3000 ? true : null;
    },
    'all TEST app/ShipIt processes and launchd jobs absent without respawn',
    12_000
  );
  await writeFile(
    path.join(commands.output, `native-cleanup-${process.pid}.json`),
    `${canonical({ job, scans, noRespawnProved: true })}\n`
  );
  if (value.restored) return value;
  const baseline = path.join(commands.output, 'pf-baseline-active.conf');
  assert.equal(digest(await readFile(baseline)), value.originalPolicySha256);
  const status = await pf(commands, 'pf-cleanup-status', ['-s', 'info']);
  if (!status.stdout.includes('Status: Disabled')) await pf(commands, 'pf-disable-owned', ['-d']);
  await pf(commands, 'pf-restore-active-baseline', ['-f', baseline]);
  assert(
    (await pf(commands, 'pf-restored-status', ['-s', 'info'])).stdout.includes('Status: Disabled')
  );
  assert.equal(
    digest((await pf(commands, 'pf-restored-rules', ['-sr'])).stdout),
    value.originalRulesSha256
  );
  assert.equal(
    digest((await pf(commands, 'pf-restored-nat', ['-sn'])).stdout),
    value.originalNatSha256
  );
  value.restored = true;
  await save(commands, value);
  return value;
}
async function tcp(address: string) {
  return new Promise<{ connected: boolean; error?: string }>((resolve) => {
    const socket = connect({ host: address, port: 443 });
    let done = false;
    const finish = (value: { connected: boolean; error?: string }) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2500, () => finish({ connected: false, error: 'timeout' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (error) => finish({ connected: false, error: error.message }));
  });
}
export async function containOldMacNetwork(
  commands: MacCommands,
  app: string,
  home: string,
  native: Awaited<ReturnType<typeof prepareOldMacNative>>
) {
  oldMacCiOnly();
  assert(
    (await pf(commands, 'pf-baseline-status', ['-s', 'info'])).stdout.includes('Status: Disabled')
  );
  const rules = await pf(commands, 'pf-baseline-rules', ['-sr']);
  const nat = await pf(commands, 'pf-baseline-nat', ['-sn']);
  const originalPolicy = `${nat.stdout}\n${rules.stdout}`;
  await writeFile(path.join(commands.output, 'pf-baseline-active.conf'), originalPolicy, {
    flag: 'wx',
  });
  await writeFile(path.join(commands.output, 'pf-original.conf'), await readFile('/etc/pf.conf'), {
    flag: 'wx',
  });
  const [[ipv4Address], [ipv6Address]] = await Promise.all([
    resolve4('one.one.one.one'),
    resolve6('one.one.one.one'),
  ]);
  assert(ipv4Address && isIP(ipv4Address) === 4);
  assert(ipv6Address && isIP(ipv6Address) === 6);
  const [before4, before6] = await Promise.all([tcp(ipv4Address), tcp(ipv6Address)]);
  await writeFile(
    path.join(commands.output, 'network-baseline.json'),
    `${canonical({ ipv4Address, ipv6Address, before4, before6 })}\n`
  );
  assert(before4.connected, 'Reachable IPv4 baseline required');
  if (!before6.connected) {
    await commands.checked('ipv6-interfaces', '/sbin/ifconfig', ['-a']);
    await commands.run('ipv6-route', '/sbin/route', ['-n', 'get', '-inet6', ipv6Address]);
  }
  const ruleFile = path.join(commands.output, 'pf-loopback.conf');
  const policy =
    'set block-policy drop\nset skip on lo0\nblock drop quick inet all\nblock drop quick inet6 all\n';
  await writeFile(ruleFile, policy, { flag: 'wx' });
  const uid = process.getuid?.();
  assert(uid !== undefined);
  const value: Receipt = {
    toolingSha: process.env.GITHUB_SHA ?? '',
    uid,
    app,
    home,
    earliest: Math.floor(Date.now() / 1000) * 1000,
    native,
    attempts: [],
    originalRulesSha256: digest(rules.stdout),
    originalNatSha256: digest(nat.stdout),
    originalPolicySha256: digest(originalPolicy),
    baselineDisabled: true,
    shipItAbsentBefore: true,
    restored: false,
  };
  await writeFile(path.join(commands.output, 'pf-owned.json'), `${canonical(value)}\n`, {
    flag: 'wx',
  });
  await pf(commands, 'pf-parse-policy', ['-n', '-f', ruleFile]);
  await pf(commands, 'pf-load-policy', ['-f', ruleFile]);
  await pf(commands, 'pf-enable-owned', ['-e']);
  await pf(commands, 'pf-flush-disposable-states', ['-F', 'states']);
  const active = await pf(commands, 'pf-active-rules', ['-sr']);
  assert.deepEqual(active.stdout.trim().split(/\r?\n/), [
    'block drop quick inet all',
    'block drop quick inet6 all',
  ]);
  assert(
    (await pf(commands, 'pf-active-status', ['-s', 'info'])).stdout.includes('Status: Enabled')
  );
  const [after4, after6] = await Promise.all([tcp(ipv4Address), tcp(ipv6Address)]);
  assert(!after4.connected && !after6.connected);
  return {
    policy,
    rulesSha256: digest(active.stdout),
    allProcessesAndSuccessorsContained: true,
    ipv4: {
      address: ipv4Address,
      before: before4,
      after: after4,
      policyEnforced: true,
      activeDenialProved: true,
    },
    ipv6: {
      address: ipv6Address,
      before: before6,
      after: after6,
      policyEnforced: true,
      activeDenialProved: before6.connected,
      limitation: before6.connected
        ? null
        : 'Runner had no reachable IPv6 baseline; empirical IPv6 denial is unproven',
    },
  };
}
export async function oldMacContainmentReadback(commands: MacCommands) {
  const rules = await pf(commands, 'pf-successor-rules', ['-sr']);
  const status = await pf(commands, 'pf-successor-status', ['-s', 'info']);
  assert(status.stdout.includes('Status: Enabled'));
  assert.deepEqual(rules.stdout.trim().split(/\r?\n/), [
    'block drop quick inet all',
    'block drop quick inet6 all',
  ]);
  return {
    enabled: true,
    dualStackPolicyEnforced: true,
    rulesSha256: digest(rules.stdout),
    statusSha256: digest(status.stdout),
  };
}
export async function macBundleSignature(
  commands: MacCommands,
  app: string,
  architecture: string,
  version: string,
  label: string
) {
  await commands.checked(`${label}-codesign`, '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    app,
  ]);
  const identity = await commands.checked(`${label}-identity`, '/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    app,
  ]);
  assert(
    identity.stderr.includes('TeamIdentifier=6C84CW694S') &&
      identity.stderr.includes('Identifier=com.agent-teams.app')
  );
  const codeDirectoryHash = /(?:^|\n)CDHash=([a-f0-9]{40})(?:\n|$)/.exec(identity.stderr)?.[1];
  assert(codeDirectoryHash, 'Original bundle CodeDirectory hash must be observable');
  for (const [key, expected] of [
    ['CFBundleShortVersionString', version],
    ['CFBundleIdentifier', 'com.agent-teams.app'],
    ['LSMinimumSystemVersion', '12.0'],
  ])
    assert.equal(
      (
        await commands.checked(`${label}-plist`, '/usr/libexec/PlistBuddy', [
          '-c',
          `Print :${key}`,
          path.join(app, 'Contents', 'Info.plist'),
        ])
      ).stdout.trim(),
      expected
    );
  for (const binary of [
    executable(app),
    path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  ])
    assert.equal(
      (await commands.checked(`${label}-lipo`, '/usr/bin/lipo', ['-archs', binary])).stdout.trim(),
      architecture === 'arm64' ? 'arm64' : 'x86_64'
    );
  return {
    version,
    architecture,
    codeDirectoryHash,
    teamIdentifier: '6C84CW694S',
    productMinimum: '12.0',
  };
}
export async function macDmgInstall(
  commands: MacCommands,
  dmg: string,
  app: string,
  mount: string
) {
  await mkdir(mount);
  await commands.checked('dmg-verify', '/usr/bin/hdiutil', ['verify', dmg]);
  await commands.checked('dmg-readonly-mount', '/usr/bin/hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    dmg,
  ]);
  try {
    await commands.checked('copy-original-signed-app', '/usr/bin/ditto', [
      path.join(mount, 'Agent Teams AI.app'),
      app,
    ]);
  } finally {
    await commands.checked('detach-test-mount', '/usr/bin/hdiutil', ['detach', mount]);
  }
}
interface NativeApplication {
  pid: number;
  bundle: string;
  executable: string;
  launchDate: number;
  finished: boolean;
  terminated: boolean;
  architecture: number;
}
export async function automaticMacApp(
  commands: MacCommands,
  reader: string,
  app: string,
  before: MacIdentity,
  restartTime: number,
  architecture: string
) {
  const apps = JSON.parse(
    (await commands.checked('native-running-applications', reader, ['--apps'])).stdout
  ) as NativeApplication[];
  const candidate = apps.find(
    (item) =>
      item.pid !== before.pid &&
      item.bundle === app &&
      item.executable === executable(app) &&
      item.finished &&
      !item.terminated &&
      item.launchDate * 1000 >= restartTime - 1000
  );
  if (!candidate) return null;
  assert.equal(candidate.architecture, architecture === 'arm64' ? 16777228 : 16777223);
  const processes = await macProcesses(commands);
  assert(
    !processes.some((entry) => entry.pid === before.pid),
    'Old process must exit before automatic successor proof'
  );
  const owner = processes.find((entry) => entry.pid === candidate.pid);
  assert(owner);
  assert.equal(owner.command, executable(app));
  assert.equal(owner.uid, process.getuid?.());
  assert(Date.parse(owner.start) >= Math.floor(restartTime / 1000) * 1000);
  return { native: candidate, owner };
}
export async function paintedMacDesktop(
  commands: MacCommands,
  reader: string,
  owner: MacIdentity,
  name: string,
  light: boolean
) {
  assert.deepEqual(
    (await macProcesses(commands)).find((entry) => entry.pid === owner.pid),
    owner
  );
  const windows = JSON.parse(
    (await commands.checked('aqua-window-owner', reader, ['--windows', String(owner.pid)])).stdout
  ) as {
    kCGWindowNumber: number;
    kCGWindowOwnerPID: number;
    kCGWindowBounds: { Width: number; Height: number };
  }[];
  const window = windows.find(
    (item) => item.kCGWindowBounds.Width >= 300 && item.kCGWindowBounds.Height >= 200
  );
  if (!window) return null;
  assert.equal(window.kCGWindowOwnerPID, owner.pid);
  const screenshot = path.join(commands.output, `${name}.png`);
  await commands.checked('capture-native-aqua', '/usr/sbin/screencapture', [
    '-x',
    '-l',
    String(window.kCGWindowNumber),
    screenshot,
  ]);
  assert((await stat(screenshot)).size > 1000);
  const pixels = JSON.parse(
    (await commands.checked('read-painted-aqua-ocr', reader, ['--image', screenshot])).stdout
  ) as { width: number; height: number; distinctColors: number; meanRgb: number; text: string };
  assert(pixels.width >= 300 && pixels.height >= 200 && pixels.distinctColors >= 32);
  if (
    /Preparing (?:your )?workspace/i.test(pixels.text) ||
    !/Providers\s*[&+]\s*plans/i.test(pixels.text) ||
    !/Tasks/i.test(pixels.text)
  )
    return null;
  if (light)
    assert(pixels.meanRgb > 128, 'Automatic successor did not paint the persisted Light theme');
  assert.deepEqual(
    (await macProcesses(commands)).find((entry) => entry.pid === owner.pid),
    owner
  );
  return { window, owner, screenshot, sha256: digest(await readFile(screenshot)), pixels };
}
