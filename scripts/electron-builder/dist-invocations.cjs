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

function buildElectronBuilderInvocations(argv) {
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
    return [{ args: sharedArgs }];
  }

  return targets.map((target) => ({
    args: [
      PLATFORM_ARGS[target],
      ...sharedArgs,
      ...(target === 'linux' ? LINUX_PACKAGE_NAME_OVERRIDES : []),
    ],
  }));
}

module.exports = {
  buildElectronBuilderInvocations,
};
