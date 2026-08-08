export const coreSideEffectFixtureSource = [
  "import chokidar from 'chokidar';",
  'export function observeCore() {',
  "  return chokidar.watch('fixture-input');",
  '}',
].join('\n');
