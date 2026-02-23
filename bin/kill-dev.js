#!/usr/bin/env node
import { spawnSync } from 'child_process';

const isWindows = process.platform === 'win32';

if (isWindows) {
  const r = spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], {
    stdio: 'inherit',
    shell: true,
  });
  if (r.status != null && r.status !== 0 && r.status !== 128 && r.signal == null) {
    process.exitCode = 1;
  }
} else {
  const r = spawnSync('pkill', ['-f', 'electron-vite|electron \\.'], { stdio: 'inherit' });
  if (r.status != null && r.status !== 0 && r.status !== 1 && r.signal == null) {
    process.exitCode = 1;
  }
}
console.log('Done');
