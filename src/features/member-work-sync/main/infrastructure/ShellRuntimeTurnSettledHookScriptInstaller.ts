import fs from 'fs/promises';

import type { RuntimeTurnSettledSpoolPaths } from './RuntimeTurnSettledSpoolPaths';

const HOOK_SCRIPT_CONTENT = `#!/bin/sh
set +e

spool_root="$1"
provider="$2"
max_bytes="\${3:-262144}"

if [ -z "$spool_root" ] || [ -z "$provider" ]; then
  exit 0
fi

case "$provider" in
  claude|codex) ;;
  *) exit 0 ;;
esac

incoming="$spool_root/incoming"
mkdir -p "$incoming" 2>/dev/null || exit 0

stamp="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown-time)"
tmp="$(mktemp "$incoming/.turn-settled.XXXXXX" 2>/dev/null)" || exit 0
suffix="$(basename "$tmp" | sed 's/^\\.turn-settled\\.//')"
final="$incoming/$stamp-$$-$suffix.$provider.json"

dd bs="$max_bytes" count=1 of="$tmp" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  exit 0
}

if [ ! -s "$tmp" ]; then
  rm -f "$tmp" 2>/dev/null
  exit 0
fi

mv "$tmp" "$final" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  exit 0
}

exit 0
`;

export class ShellRuntimeTurnSettledHookScriptInstaller {
  constructor(private readonly paths: RuntimeTurnSettledSpoolPaths) {}

  async install(): Promise<{ scriptPath: string; spoolRoot: string }> {
    await Promise.all([
      fs.mkdir(this.paths.getBinDir(), { recursive: true }),
      fs.mkdir(this.paths.getIncomingDir(), { recursive: true }),
      fs.mkdir(this.paths.getProcessingDir(), { recursive: true }),
      fs.mkdir(this.paths.getProcessedDir(), { recursive: true }),
      fs.mkdir(this.paths.getInvalidDir(), { recursive: true }),
    ]);

    const scriptPath = this.paths.getHookScriptPath();
    await fs.writeFile(scriptPath, HOOK_SCRIPT_CONTENT, 'utf8');
    // eslint-disable-next-line sonarjs/file-permissions -- the hook script must be executable on POSIX hosts.
    await fs.chmod(scriptPath, 0o755);

    return {
      scriptPath,
      spoolRoot: this.paths.getRootDir(),
    };
  }
}
