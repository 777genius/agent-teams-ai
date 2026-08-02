/* global console, module */

const PLATFORM_FLAGS = new Map([
  ['--mac', 'mac'],
  ['-m', 'mac'],
  ['--win', 'win'],
  ['-w', 'win'],
  ['--linux', 'linux'],
  ['-l', 'linux'],
]);

const PLATFORM_ARGS = {
  mac: '--mac',
  win: '--win',
  linux: '--linux',
};

const LINUX_PACKAGE_NAME_OVERRIDES = [
  '--config.productName=Agent-Teams-AI',
  '--config.linux.desktop.entry.Name=Agent Teams AI',
];

const WINDOWS_ARM64_ARTIFACT_NAME_OVERRIDE =
  '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}';

const ARCH_FLAGS = new Map([
  ['--x64', 'x64'],
  ['--ia32', 'ia32'],
  ['--armv7l', 'armv7l'],
  ['--arm64', 'arm64'],
  ['--universal', 'universal'],
]);
const ARCH_NAMES = new Set(ARCH_FLAGS.values());

function resolveTargetArch(args, hostArch) {
  const targetArchs = new Set();

  for (const arg of args) {
    const flagArch = ARCH_FLAGS.get(arg);
    if (flagArch) {
      targetArchs.add(flagArch);
      continue;
    }

    const suffixPos = arg.lastIndexOf(':');
    if (suffixPos > 0) {
      const suffixArch = arg.slice(suffixPos + 1);
      if (ARCH_NAMES.has(suffixArch)) {
        targetArchs.add(suffixArch);
      }
    }
  }

  if (targetArchs.size > 1) {
    throw new Error(
      '[electron-builder] multiple architectures in one invocation are unsupported; run one architecture per command'
    );
  }

  return targetArchs.values().next().value ?? hostArch;
}

function addWindowsArm64ArtifactName(args, isWindowsTarget, hostArch) {
  if (
    !isWindowsTarget ||
    resolveTargetArch(args, hostArch) !== 'arm64' ||
    args.some((arg) => arg.startsWith('--config.nsis.artifactName='))
  ) {
    return args;
  }

  return [...args, WINDOWS_ARM64_ARTIFACT_NAME_OVERRIDE];
}

function buildElectronBuilderInvocations(argv, hostPlatform, hostArch) {
  const targets = [];
  const sharedArgs = [];

  for (const arg of argv) {
    const target = PLATFORM_FLAGS.get(arg);
    if (target) {
      if (!targets.includes(target)) {
        targets.push(target);
      }
      continue;
    }
    sharedArgs.push(arg);
  }

  if (targets.length === 0) {
    return [{ args: addWindowsArm64ArtifactName(sharedArgs, hostPlatform === 'win32', hostArch) }];
  }

  return targets.map((target) => {
    const args = [
      PLATFORM_ARGS[target],
      ...sharedArgs,
      ...(target === 'linux' ? LINUX_PACKAGE_NAME_OVERRIDES : []),
    ];

    return {
      args: addWindowsArm64ArtifactName(args, target === 'win', hostArch),
    };
  });
}

function buildNativeRebuildPlan(args, hostPlatform, hostArch) {
  const isWindowsTarget = args.includes('--win') || args.includes('-w');
  const targetArch = resolveTargetArch(args, hostArch);

  if (
    !isWindowsTarget ||
    !['arm64', 'x64'].includes(targetArch) ||
    (hostPlatform === 'win32' && targetArch === hostArch)
  ) {
    return null;
  }

  return {
    platform: 'win32',
    arch: targetArch,
    modules: ['better-sqlite3'],
  };
}

function buildNativeRestorePlan(targetPlan, hostPlatform, hostArch) {
  if (!targetPlan || (targetPlan.platform === hostPlatform && targetPlan.arch === hostArch)) {
    return null;
  }

  return {
    platform: hostPlatform,
    arch: hostArch,
    modules: [...targetPlan.modules],
  };
}

async function runWithNativeDependencyRestore({ targetPlan, restorePlan, rebuild, packageTarget }) {
  let primaryError;

  try {
    await rebuild(targetPlan, 'target');
    await packageTarget();
  } catch (error) {
    primaryError = error;
  }

  if (restorePlan) {
    try {
      await rebuild(restorePlan, 'restore');
    } catch (restoreError) {
      if (!primaryError) {
        throw restoreError;
      }

      console.error(
        '[electron-builder] failed to restore host native dependencies after build failure',
        restoreError
      );
    }
  }

  if (primaryError) {
    throw primaryError;
  }
}

module.exports = {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  runWithNativeDependencyRestore,
};
