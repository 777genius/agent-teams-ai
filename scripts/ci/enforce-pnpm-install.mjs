const userAgent = process.env.npm_config_user_agent ?? '';

if (userAgent.startsWith('pnpm/')) {
  process.exit(0);
}

console.error(
  [
    'Use pnpm install for this project.',
    'npm and yarn do not apply pnpm patchedDependencies, including the Radix React 19 patches.',
  ].join('\n')
);
process.exit(1);
