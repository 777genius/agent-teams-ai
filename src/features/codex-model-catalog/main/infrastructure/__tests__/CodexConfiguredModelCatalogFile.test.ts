import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadConfiguredCodexCatalogExtras,
  resolveConfiguredCodexCatalogFingerprint,
} from '../CodexConfiguredModelCatalogFile';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfiguredCodexCatalogExtras', () => {
  it('loads slug models from the configured Codex catalog JSON', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    createdDirs.push(home);
    const catalogPath = path.join(home, 'models.json');
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: 'composer-2.5-fast-cursor',
            display_name: 'Composer 2.5 Fast · Cursor',
            visibility: 'list',
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `model_provider = "codex-mixin"\nmodel_catalog_json = "${catalogPath}"\n`
    );

    const result = await loadConfiguredCodexCatalogExtras({
      env: { ...process.env, CODEX_HOME: home },
    });

    expect(result.models.map((model) => model.id)).toEqual(['composer-2.5-fast-cursor']);
    expect(result.diagnostic).toContain('Merged 1 models');
  });

  it('changes the extra-catalog fingerprint when the JSON file changes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    createdDirs.push(home);
    const catalogPath = path.join(home, 'models.json');
    fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: 'auto-cursor' }] }));
    fs.writeFileSync(path.join(home, 'config.toml'), `model_catalog_json = "${catalogPath}"\n`);

    const env = { ...process.env, CODEX_HOME: home };
    const before = await resolveConfiguredCodexCatalogFingerprint(env);
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ models: [{ slug: 'auto-cursor' }, { slug: 'composer-2.5-fast-cursor' }] })
    );
    const after = await resolveConfiguredCodexCatalogFingerprint(env);

    expect(before).toContain(catalogPath);
    expect(after).not.toBe(before);
  });
});
