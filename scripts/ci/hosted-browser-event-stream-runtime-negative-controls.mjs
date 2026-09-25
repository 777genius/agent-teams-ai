/* global document, window */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

import { sha256 } from './hosted-browser-event-stream-proof.mjs';
import { HOSTED_RENDERER_GRAPH_MANIFEST } from './hosted-browser-event-stream-proof-graph.mjs';
import { verifyHostedRendererGraph } from './verify-hosted-no-terminal-artifact.mjs';

const sourceRoot = resolve(process.argv[2] ?? process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), 'hosted-browser-proof-controls-'));

function copiedRenderer(name) {
  const root = join(tempRoot, name);
  mkdirSync(join(root, 'out'), { recursive: true });
  cpSync(join(sourceRoot, 'out', 'renderer'), join(root, 'out', 'renderer'), { recursive: true });
  return root;
}

function updateGraph(root, fileName, source) {
  const renderer = join(root, 'out', 'renderer');
  writeFileSync(join(renderer, fileName), source);
  const graphPath = join(renderer, HOSTED_RENDERER_GRAPH_MANIFEST);
  const manifest = JSON.parse(readFileSync(graphPath, 'utf8'));
  if (fileName === 'index.html') manifest.entryHtmlSha256 = sha256(source);
  else {
    const chunk = manifest.chunks.find((item) => item.fileName === fileName);
    if (!chunk) throw new Error(`control_chunk_missing:${fileName}`);
    chunk.sha256 = sha256(source);
  }
  delete manifest.graphSha256;
  manifest.graphSha256 = sha256(JSON.stringify(manifest));
  writeFileSync(graphPath, `${JSON.stringify(manifest)}\n`);
}

function mainChunk(root) {
  const renderer = join(root, 'out', 'renderer');
  const graph = JSON.parse(readFileSync(join(renderer, HOSTED_RENDERER_GRAPH_MANIFEST), 'utf8'));
  const row = graph.chunks.find((chunk) => chunk.moduleIds.includes('src/renderer/hosted/main.tsx'));
  if (!row) throw new Error('control_main_chunk_missing');
  return { fileName: row.fileName, source: readFileSync(join(renderer, row.fileName), 'utf8') };
}

function assertBrowserRejects(root, expected) {
  const proof = spawnSync(process.execPath, [
    'scripts/ci/hosted-browser-event-stream-runtime-proof.mjs', '--root', root,
  ], { cwd: sourceRoot, encoding: 'utf8', timeout: 45_000 });
  if (proof.error || proof.status === 0 || !proof.stderr.includes(expected)) {
    throw new Error(`browser_negative_control_failed:${expected}:${JSON.stringify(proof)}`);
  }
}

async function assertBrowserIgnoresMovedCsp(html) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.HOSTED_RENDERER_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium',
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    const observed = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'globalThis.__movedCspControlRan = true;';
      document.head.appendChild(script);
      return {
        cspInHead: document.head.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
        inlineRan: window.__movedCspControlRan === true,
      };
    });
    if (observed.cspInHead || !observed.inlineRan) {
      throw new Error(`moved_csp_browser_control_failed:${JSON.stringify(observed)}`);
    }
  } finally {
    await browser?.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

try {
  const mapRoot = copiedRenderer('map');
  const mapMain = mainChunk(mapRoot);
  updateGraph(mapRoot, mapMain.fileName, `${mapMain.source}\n{
    const api = globalThis.__agentTeamsHostedCoordinationEventStream;
    api.createHostedCoordinationEventTransport = 0;
    const originalMap = Array.prototype.map;
    Array.prototype.map = function (callback, thisArg) {
      if (this[0] === 'createHostedCoordinationEventBootstrapTransport') return ['function', 'function'];
      return originalMap.call(this, callback, thisArg);
    };
  }\n`);
  if (!verifyHostedRendererGraph(mapRoot).ok) throw new Error('map_control_static_unexpected_rejection');
  assertBrowserRejects(mapRoot, 'api_callable_data_descriptor');

  const getterRoot = copiedRenderer('getter');
  const getterMain = mainChunk(getterRoot);
  updateGraph(getterRoot, getterMain.fileName, `${getterMain.source}\nObject.defineProperty(
    globalThis.__agentTeamsHostedCoordinationEventStream,
    'createHostedCoordinationEventTransport',
    { get() { throw new Error('getter_was_invoked'); } }
  );
  Object.prototype.value = function spoof() {};\n`);
  if (!verifyHostedRendererGraph(getterRoot).ok) throw new Error('getter_control_static_unexpected_rejection');
  assertBrowserRejects(getterRoot, 'api_callable_data_descriptor');

  const awaitRoot = copiedRenderer('await');
  const awaitMain = mainChunk(awaitRoot);
  updateGraph(awaitRoot, awaitMain.fileName, `${awaitMain.source}\nawait new Promise(resolve => setTimeout(resolve, 1000));
  globalThis.__agentTeamsHostedCoordinationEventStream.createHostedCoordinationEventTransport = 0;
  throw new Error('late_failure_control');\n`);
  if (!verifyHostedRendererGraph(awaitRoot).ok) throw new Error('await_control_static_unexpected_rejection');
  assertBrowserRejects(awaitRoot, 'late_failure_control');

  const cspRoot = copiedRenderer('csp');
  const html = readFileSync(join(cspRoot, 'out', 'renderer', 'index.html'), 'utf8');
  const movedCsp = html.replace('<head>', '<head>unexpected-text');
  if (movedCsp === html) throw new Error('csp_control_mutation_failed');
  updateGraph(cspRoot, 'index.html', movedCsp);
  if (!verifyHostedRendererGraph(cspRoot).violations.includes('hosted_renderer_graph_entry_html_invalid')) {
    throw new Error('csp_control_static_unexpected_acceptance');
  }
  assertBrowserRejects(cspRoot, 'renderer_html_invalid');
  await assertBrowserIgnoresMovedCsp(movedCsp);

  const symlinkRoot = copiedRenderer('symlink');
  const symlinkMain = mainChunk(symlinkRoot);
  const mainPath = join(symlinkRoot, 'out', 'renderer', symlinkMain.fileName);
  const outside = join(tempRoot, 'outside-main.js');
  writeFileSync(outside, symlinkMain.source);
  rmSync(mainPath);
  symlinkSync(outside, mainPath);
  assertBrowserRejects(symlinkRoot, 'renderer_symlink');

  process.stdout.write('hosted_browser_runtime_negative_controls_ok\n');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
