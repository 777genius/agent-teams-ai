import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Official @openai/codex 0.162.0 native packages, qualified independently per tuple. */
export function desktopCodexSha256(): string {
  if (process.platform === 'linux' && process.arch === 'x64')
    return '50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38';
  if (process.platform === 'darwin' && process.arch === 'arm64')
    return '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57';
  throw new Error('This Desktop Codex TEST tuple has no qualified native binary pin');
}

/** Real Electron openExternal dispatch to a TEST OS opener; no personal browser or retained URL. */
export async function prepareDesktopCodexLoginOpener(root: string, nodeScriptHeader: string) {
  if (process.platform !== 'linux') return;
  await writeFile(join(root, 'bin/xdg-open'), nodeScriptHeader +
    `import {appendFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\n` +
    `const args=process.argv.slice(2);let url;try{url=args.length===1?new URL(args[0]):null}catch{process.exit(78)}\n` +
    `if(!url||url.protocol!=='https:'||url.hostname!=='auth.openai.com'||url.username||url.password)process.exit(78);\n` +
    `appendFileSync(${JSON.stringify(join(root, 'external-open.jsonl'))},JSON.stringify({sha256:createHash('sha256').update(url.href).digest('hex')})+'\\n',{mode:0o600});\n`,
  { mode: 0o700, flag: 'wx' });
}
