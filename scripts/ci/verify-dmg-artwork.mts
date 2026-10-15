// Exercise Finder layout packaging with a disposable .app, without starting the app/runtime.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function iconPosition(store: Buffer, name: string) {
  const filename = Buffer.from(name, 'utf16le');
  filename.swap16();
  const signature = Buffer.concat([filename, Buffer.from('Ilocblob')]);
  const offset = store.indexOf(signature);
  assert.notEqual(offset, -1, `Finder position missing for ${name}`);
  const value = offset + signature.length;
  assert.equal(store.readUInt32BE(value), 16, 'Unexpected Finder icon position record');
  return { x: store.readUInt32BE(value + 4), y: store.readUInt32BE(value + 8) };
}

export async function verifyDmgArtwork(cwd = process.cwd()) {
  assert.equal(process.platform, 'darwin', 'DMG smoke requires macOS');
  const config = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')).build;
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const appRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const { validateConfiguration } = appRequire('app-builder-lib/out/util/config/config');
  const { DmgTarget, customizeDmg } = appRequire('dmg-builder/out/dmgUtil');
  await validateConfiguration(config, { isEnabled: false });
  const root = await mkdtemp(path.join(tmpdir(), 'agent-teams-dmg-smoke-'));
  try {
    const name = `${config.productName}.app`;
    const appPath = path.join(root, name);
    await mkdir(path.join(appPath, 'Contents/Resources'), { recursive: true });
    await copyFile(
      path.resolve(cwd, config.mac.icon),
      path.join(appPath, 'Contents/Resources/icon.icns')
    );
    await writeFile(
      path.join(appPath, 'Contents/Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>DMG smoke fixture</string><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
    );
    const packager = {
      config,
      projectDir: cwd,
      compression: 'normal',
      resourceList: [],
      appInfo: { productFilename: config.productName },
      getIconPath: async () => path.resolve(cwd, config.mac.icon),
      getResource: async (file: string | undefined) => (file ? path.resolve(cwd, file) : null),
      getTempFile: async () => path.join(root, `${randomUUID()}.json`),
      info: {
        getWorkspaceRoot: async () => cwd,
        tempDirManager: { getTempFile: async () => path.join(root, `${randomUUID()}.tiff`) },
      },
      packagerOptions: {} as {
        effectiveOptionComputed?: (input: { volumePath: string }) => Promise<boolean>;
      },
    };
    const target = new DmgTarget(packager, root);
    const specification = await target.computeDmgOptions(appPath);
    let inspected = false;
    packager.packagerOptions.effectiveOptionComputed = async ({ volumePath }) => {
      const contents = await readdir(volumePath);
      assert.ok(contents.includes(name), 'Fixture app missing from mounted DMG');
      assert.equal(await readlink(path.join(volumePath, 'Applications')), '/Applications');
      const store = await readFile(path.join(volumePath, '.DS_Store'));
      for (const item of specification.contents) {
        const itemName = item.name || (item.type === 'link' ? path.basename(item.path) : name);
        assert.deepEqual(iconPosition(store, itemName), { x: item.x, y: item.y });
      }
      if (specification.background) {
        const source = await readFile(specification.background);
        const backgrounds = contents.filter((file) => file.startsWith('.background'));
        const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
        let found = false;
        for (const file of backgrounds) {
          const target = path.join(volumePath, file);
          if ((await stat(target)).isDirectory()) {
            for (const child of await readdir(target)) {
              if (hash(await readFile(path.join(target, child))) === hash(source)) found = true;
            }
          } else if (hash(await readFile(target)) === hash(source)) found = true;
        }
        assert.ok(found, 'Mounted DMG background differs from source asset');
      }
      inspected = true;
      return false;
    };
    await customizeDmg({
      appPath,
      artifactPath: path.join(root, 'fixture.dmg'),
      volumeName: `Agent Teams smoke ${randomUUID()}`,
      specification,
      packager,
    });
    assert.ok(inspected, 'Mounted DMG was not verified');
    console.log(
      'DMG smoke passed: mounted background, Finder icon positions, app and Applications link'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  verifyDmgArtwork().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
