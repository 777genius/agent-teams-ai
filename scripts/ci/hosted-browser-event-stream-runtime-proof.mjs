/* global window */

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

import {
  HOSTED_BROWSER_EVENT_STREAM_API,
  HOSTED_BROWSER_EVENT_STREAM_GLOBAL,
} from './hosted-browser-event-stream-proof.mjs';
import { installHostedProofInspector } from './hosted-browser-event-stream-runtime-inspector.mjs';
import {
  buildHostedRendererInventory,
  inventoriedRendererPath,
} from './hosted-browser-event-stream-runtime-inventory.mjs';

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

async function withDeadline(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const root = resolve(argumentValue(process.argv.slice(2), '--root', process.cwd()));
  const executablePath = argumentValue(
    process.argv.slice(2),
    '--executable',
    process.env.HOSTED_RENDERER_CHROMIUM_EXECUTABLE ?? '/usr/bin/chromium'
  );
  const inventory = buildHostedRendererInventory(join(root, 'out', 'renderer'));
  const server = createServer((request, response) => {
    const file = inventoriedRendererPath(inventory, request.url ?? '/');
    if (file === null) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': file.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(file.bytes);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  let browser;
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('proof_server_address');
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(installHostedProofInspector, {
      apiKeys: HOSTED_BROWSER_EVENT_STREAM_API.map(({ globalKey }) => globalKey),
      globalName: HOSTED_BROWSER_EVENT_STREAM_GLOBAL,
    });
    const response = await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (response?.status() !== 200) throw new Error('proof_document_load_failed');
    // Dynamic import joins the browser module map and settles only after each
    // actual HTML entry (including its top-level await) has finished evaluating.
    await withDeadline(
      () => page.evaluate(async (paths) => {
        for (let index = 0; index < paths.length; index += 1) {
          await import(`/${paths[index]}`);
        }
      }, inventory.entryPaths),
      30_000,
      'hosted_module_evaluation'
    );
    const proof = await withDeadline(
      () => page.evaluate(() => window.__hostedProofInspect()),
      10_000,
      'hosted_runtime_inspection'
    );
    if (pageErrors.length > 0 || proof?.ok !== true) {
      throw new Error(
        `hosted_browser_event_stream_runtime_proof_failed:${JSON.stringify({ pageErrors, proof })}`
      );
    }
    process.stdout.write(`${JSON.stringify({ ok: true, proof })}\n`);
  } finally {
    await browser?.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

await main();
