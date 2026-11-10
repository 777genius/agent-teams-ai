import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [role, marker, leadPid] = process.argv.slice(2);
if (role === 'lead') {
  const member = spawn(
    process.execPath,
    [import.meta.filename, 'member', marker, String(process.pid)],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  member.unref();
} else if (role === 'member') {
  const provider = spawn(process.execPath, [import.meta.filename, 'provider', marker], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  provider.unref();
  writeFileSync(
    marker,
    JSON.stringify({ leadPid: Number(leadPid), memberPid: process.pid, providerPid: provider.pid })
  );
}
setInterval(() => {}, 1_000);
