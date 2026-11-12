import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { assertNativeV1Build, assertNativeV1Source, buildNativeV1Host } from './opencode-v1-version-source.ts';

async function fixture() {
  const repo=await mkdtemp(join(tmpdir(),'TEST-v1-source-build-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',timeout:5000}).trim();
  await writeFile(join(repo,'.gitignore'),'**/dist/\n**/node_modules/\n');
  const archive='vendor/provider-migration/TEST-provider/provider.tgz';
  await mkdir(join(repo,'vendor/provider-migration/TEST-provider'),{recursive:true});
  await writeFile(join(repo,archive),'TEST-pinned-provider');
  const compiler=await realpath(resolve(import.meta.dirname,'../node_modules/@typescript/native'));
  for(const name of ['task-change-ledger','legacy-agent-host']) {
    const pkg=join(repo,'packages',name);
    await mkdir(join(pkg,'src'),{recursive:true});
    await mkdir(join(pkg,'node_modules/@typescript'),{recursive:true});
    await symlink(compiler,join(pkg,'node_modules/@typescript/native'),'dir');
    await writeFile(join(pkg,'src/index.ts'),'export const value = 1;\n');
    await writeFile(join(pkg,'package.json'),JSON.stringify({type:'module',dependencies:{
      '@agent-teams/provider-implementations':'file:../../'+archive,
    }}));
    await writeFile(join(pkg,'tsconfig.json'),JSON.stringify({compilerOptions:{
      target:'ES2024',module:'NodeNext',outDir:'dist',rootDir:'src',skipLibCheck:true,
    },include:['src/**/*.ts']}));
  }
  git('init','-q');git('add','.');
  git('-c','user.name=TEST','-c','user.email=test@example.invalid','-c','commit.gpgsign=false',
    'commit','-qm','TEST owned source fixture');
  return {repo,git,head:git('rev-parse','HEAD')};
}

test('native V1 source admission rejects changed, staged and untracked relevant inputs',async()=>{
  const {repo,git,head}=await fixture();
  const source=join(repo,'packages/legacy-agent-host/src/index.ts');
  try {
    assert.doesNotThrow(()=>assertNativeV1Source(repo,head));
    assert.throws(()=>assertNativeV1Source(repo,'0'.repeat(40)),/requested HEAD/);
    await writeFile(source,'export const value = 2;\n');
    assert.throws(()=>assertNativeV1Source(repo,head),/must be clean/);
    git('add','packages/legacy-agent-host/src/index.ts');
    assert.throws(()=>assertNativeV1Source(repo,head),/must be clean/);
    git('restore','--staged','--worktree','packages/legacy-agent-host/src/index.ts');
    const extra=join(repo,'packages/legacy-agent-host/src/untracked.ts');
    await writeFile(extra,'export const unknown = true;\n');
    assert.throws(()=>assertNativeV1Source(repo,head),/untracked native source/);
    await rm(extra);
    await writeFile(join(repo,'TEST-unrelated-notes.txt'),'unrelated');
    assert.doesNotThrow(()=>assertNativeV1Source(repo,head));
  } finally {await rm(repo,{recursive:true,force:true});}
});

test('native V1 rebuild removes stale outputs and binds later execution to the emitted bytes',async()=>{
  const {repo,head}=await fixture();
  try {
    for(const name of ['task-change-ledger','legacy-agent-host']) {
      const dist=join(repo,'packages',name,'dist');
      await mkdir(dist);
      await writeFile(join(dist,'stale.js'),'throw Error("TEST stale output");\n');
      await writeFile(join(dist,'index.js'),'export const value = 999;\n');
    }
    const built=await buildNativeV1Host(repo,head);
    await assertNativeV1Build(repo,head,built);
    for(const name of ['task-change-ledger','legacy-agent-host']) {
      const dist=join(repo,'packages',name,'dist');
      assert.match(await readFile(join(dist,'index.js'),'utf8'),/value = 1/);
      await assert.rejects(readFile(join(dist,'stale.js')),{code:'ENOENT'});
    }
    await writeFile(join(repo,'packages/legacy-agent-host/dist/index.js'),'export const value = 999;\n');
    assert.doesNotThrow(()=>assertNativeV1Source(repo,head),'ignored output does not affect source cleanliness');
    await assert.rejects(assertNativeV1Build(repo,head,built),/freshly built Host/);
  } finally {await rm(repo,{recursive:true,force:true});}
});
