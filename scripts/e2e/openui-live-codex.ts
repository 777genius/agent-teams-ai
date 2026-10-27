#!/usr/bin/env -S pnpm exec tsx
// Real Codex desktop smoke in a new disposable project/team only.
// Run: pnpm exec tsx scripts/e2e/openui-live-codex.ts
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
// @ts-expect-error Existing runtime resolver is JavaScript.
import { resolveLiveSmokeOrchestratorCliPath } from '../lib/live-smoke-runtime.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser } from '@openuidev/lang-core';
import { readOpenUIReply } from '../lib/openui-chat-reply';
import type { TeamCreateRequest } from '../../src/shared/types/team';
// Existing raw CDP client; all interaction stays in the owned dev:mcp renderer.
// @ts-expect-error Existing JavaScript harness has no declaration file.
import { CdpClient } from './comment-notification/cdp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keep = process.env.OPENUI_LIVE_KEEP === '1';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logs: string[] = [];
const rendererErrors: unknown[] = [];
let app: ChildProcess | undefined;
interface SmokeCdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitFor(expression: string, label: string, timeoutMs?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}
let cdp: SmokeCdp;

async function screenshot(file: string) {
  await delay(250); // Let the Radix opening animation settle before visual evidence.
  await cdp.screenshot(file);
}

// Await the evaluated expression itself: Boolean(Promise) would pass asynchronous
// production IPC checks before their result exists.
async function waitFor(expression: string, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    } catch (error) {
      if (
        !/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
          String(error)
        )
      )
        throw error;
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'openui-live-codex-')));
  const teamName = 'openui-live-' + randomUUID();
  const projectPath = path.join(root, 'TEST-project');
  const claudeRoot = path.join(root, '.claude');
  const shots = process.env.OPENUI_LIVE_OUTPUT_DIR ?? path.join(root, 'evidence');
  const runtime = resolveLiveSmokeOrchestratorCliPath({ repoRoot, env: process.env }) as string;
  const env: Record<string, string> = {
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(root, 'user-data'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS: '120000',
    CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS: '120000',
    CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG: 'true',
  };
  await Promise.all(
    [projectPath, shots, claudeRoot, env.CLAUDE_CONFIG_DIR].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
  await writeFile(
    path.join(projectPath, 'README.md'),
    '# Disposable real Codex visualization test\n'
  );
  await json(path.join(claudeRoot, 'agent-teams-config.json'), {
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
  });
  return {
    root,
    teamName,
    projectPath,
    shots,
    runtime,
    env,
    teamDir: path.join(claudeRoot, 'teams', teamName),
  };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  app = spawn('pnpm', ['dev:mcp', ...(process.getuid?.() === 0 ? ['--noSandbox'] : [])], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...f.env,
      NODE_BINARY: await realpath(process.execPath),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: f.runtime,
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
      SHELL: '/bin/sh',
      AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
      pnpm_config_verify_deps_before_run: 'false',
    },
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      logs.push(chunk.toString());
      if (logs.length > 300) logs.shift();
    });
  // Discover this process's actual port rather than attaching to another app on 9222.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error('Owned dev:mcp exited: ' + app.exitCode);
    const port = logs
      .join('')
      .match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//)?.[1];
    if (port) {
      try {
        const targets = (await fetch('http://127.0.0.1:' + port + '/json/list').then((r) =>
          r.json()
        )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        const renderer = targets.find(
          (target) => target.type === 'page' && target.url.startsWith('http://localhost:')
        );
        if (renderer) {
          cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
          return Number(port);
        }
      } catch {
        /* Electron renderer is still starting. */
      }
    }
    await delay(100);
  }
  throw new Error('Owned dev:mcp renderer did not appear');
}

async function click(expression: string) {
  await cdp.evaluate(
    `(() => { const e = ${expression}; if (e instanceof HTMLElement) e.scrollIntoView({ block: 'center', behavior: 'instant' }); })()`
  );
  await delay(250);
  await waitFor(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return false; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.width > 0 && r.height > 0 && (hit === e || e.contains(hit)); })()`,
    'unobstructed click target: ' + expression
  );
  const point = await cdp.evaluate(
    `(() => { const e = ${expression}; if (!(e instanceof HTMLElement)) return null; const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`
  );
  assert(point && typeof point === 'object', 'Missing click target: ' + expression);
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
const button = (text: string, root = 'document') =>
  `Array.from(${root}.querySelectorAll('button')).find(e => e.textContent?.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)})`;
const openuiArticle = (marker: string) =>
  `Array.from(document.querySelectorAll('article')).find(e => e.textContent.includes(${JSON.stringify(marker)}) && e.querySelector('[data-chat-visualization-kind="openui"]'))`;
const openuiBlock = (marker: string, fenceIndex: number) =>
  `${openuiArticle(marker)}?.querySelectorAll('[data-chat-visualization-kind="openui"]')[${fenceIndex}]`;
async function fill(selector: string, value: string) {
  await click(`document.querySelector(${JSON.stringify(selector)})`);
  await cdp.send('Input.insertText', { text: value });
}
async function key(key: string, code = key) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      ...(key === ' ' ? { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 } : {}),
    });
}

type Message = {
  messageId: string;
  from: string;
  to?: string;
  text: string;
  groupChatId?: string;
  groupMessageId?: string;
};
async function parseGeneratedVisualization(text: string) {
  const protocol = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        'agent-teams-controller/src/internal/generated/chatVisualizationProtocol.json'
      ),
      'utf8'
    )
  );
  const { fences, prose } = readOpenUIReply(text);
  const fenceIndex = fences.findIndex((fence) => fence.state === 'closed');
  const source = fences[fenceIndex]?.source;
  assert(
    source && source.length <= 32_000,
    'Actual Codex visualization needs a bounded closed fence'
  );
  const parsed = createParser(protocol.spec.schema, protocol.spec.root).parse(source);
  assert.equal(parsed.meta.errors.length, 0, 'Actual visualization parser errors');
  assert.equal(parsed.meta.incomplete, false, 'Actual visualization must be complete');
  assert.deepEqual(parsed.meta.unresolved, [], 'Actual visualization references must resolve');
  assert.equal(parsed.root?.typeName, 'Stack', 'Actual visualization root');
  assert.equal(parsed.root?.hasDynamicProps, false, 'Actual visualization must be static');
  const cards = parsed.root?.props.children as {
    props: { children: { typeName: string; props: Record<string, unknown> }[] };
  }[];
  assert(Array.isArray(cards), 'Actual root Stack Cards');
  return { source, parsed, cards, fenceIndex, prose };
}
async function verifyGeneratedCatalog(text: string, output: string) {
  const { source, parsed, cards, fenceIndex } = await parseGeneratedVisualization(text);
  const expected = [
    ['BAR_GROUPED', 'BarChart', 'grouped'],
    ['BAR_STACKED', 'BarChart', 'stacked'],
    ['LINE_LINEAR', 'LineChart', 'linear'],
    ['LINE_NATURAL', 'LineChart', 'natural'],
    ['LINE_STEP', 'LineChart', 'step'],
    ['PIE_PIE_CIRCULAR', 'PieChart', 'pie', 'circular'],
    ['PIE_PIE_SEMI', 'PieChart', 'pie', 'semiCircular'],
    ['PIE_DONUT_CIRCULAR', 'PieChart', 'donut', 'circular'],
    ['PIE_DONUT_SEMI', 'PieChart', 'donut', 'semiCircular'],
  ];
  for (const [title, name, variant, appearance] of expected) {
    const card = cards.find((card) =>
      card.props.children.some(
        (node) => node.typeName === 'CardHeader' && node.props.title === title
      )
    );
    assert(card, 'Actual agent card missing ' + title);
    const chart = card.props.children.find((node) => node.typeName === name);
    assert(chart, 'Actual chart missing ' + title);
    assert.equal(chart.props.variant, variant, 'Actual variant ' + title);
    if (appearance) assert.equal(chart.props.appearance, appearance, 'Actual appearance ' + title);
  }
  const tableCard = cards.find((card) =>
    card.props.children.some(
      (node) => node.typeName === 'CardHeader' && node.props.title === 'TABLE_TEXT'
    )
  );
  assert(tableCard, 'Actual Table/Text card');
  const sizes = tableCard.props.children
    .filter((node) => node.typeName === 'TextContent')
    .map((node) => node.props.size ?? 'default');
  assert.deepEqual(
    sizes.slice().sort(),
    ['small', 'default', 'large', 'small-heavy', 'large-heavy'].sort(),
    'All actual TextContent sizes'
  );
  const table = tableCard.props.children.find((node) => node.typeName === 'Table');
  assert(table, 'Actual Table');
  const columns = table.props.columns as { props: { data: unknown[] } }[];
  assert(
    columns.some((column) => column.props.data.length >= 12),
    'Actual pagination rows'
  );
  const values = columns.flatMap((column) => column.props.data);
  assert(
    ['string', 'number', 'boolean'].every((type) =>
      values.some((value) => typeof value === type)
    ) && values.includes(null),
    'Actual static cell types'
  );
  await json(output, { ok: true, expected, source, root: parsed.root });
  return {
    fenceIndex,
    textExamples: tableCard.props.children
      .filter((node) => node.typeName === 'TextContent')
      .map((node) => ({ text: node.props.text, size: node.props.size ?? 'default' })),
  };
}
async function main() {
  const f = await fixture();
  const token = 'CODEX_LIVE_' + randomUUID();
  let phase = 'desktop startup';
  let created = false;
  const milestones: unknown[] = [];
  const api = (expression: string) => cdp.evaluate(`(async () => await (${expression}))()`);
  const openSurface = async (name: string) => {
    const backButton = `document.querySelector('button[aria-label="Back to chats"]')`;
    if (await cdp.evaluate(`Boolean(${backButton})`)) await click(backButton);
    const target = `Array.from(document.querySelectorAll('button[aria-label]')).find(e => e.getAttribute('aria-label')?.startsWith(${JSON.stringify(name + ',')}))`;
    await waitFor(target, name + ' chat row');
    await click(target);
  };
  const messages = async (): Promise<Message[]> => {
    try {
      return JSON.parse(
        await readFile(path.join(f.teamDir, 'inboxes', 'user.json'), 'utf8')
      ) as Message[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const reply = async (
    marker: string,
    groupId?: string,
    accept: (message: Message) => boolean = () => true
  ) => {
    let result: Message | undefined;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      result = (await messages()).find(
        (message) =>
          message.from === 'visualizer' &&
          readOpenUIReply(message.text).prose.includes(marker) &&
          message.groupChatId === groupId &&
          accept(message)
      );
      if (result) break;
      await delay(500);
    }
    assert(result, 'Real Codex reply did not arrive: ' + marker);
    await json(path.join(f.shots, marker + '-reply.json'), result);
    await waitFor(
      `window.__agentTeamsDevStore.getState().teamMessagesByName[${JSON.stringify(f.teamName)}]?.canonicalMessages.some(m => m.messageId === ${JSON.stringify(result.messageId)} && m.text === ${JSON.stringify(result.text)})`,
      'actual Codex reply cache'
    );
    return result;
  };
  try {
    const port = await start(f);
    cdp.on('Runtime.exceptionThrown', (event) => rendererErrors.push(event));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1050,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      'window.electronAPI?.teams && window.__agentTeamsDevStore',
      'desktop API',
      60_000
    );
    await waitFor(
      '(async () => (await window.electronAPI.startup.getStatus()).ready)()',
      'startup',
      90_000
    );
    const account = (await api('window.electronAPI.refreshCodexAccountSnapshot()')) as Record<
      string,
      unknown
    >;
    await json(path.join(f.shots, 'account-status.json'), {
      launchAllowed: account.launchAllowed,
      launchReadinessState: account.launchReadinessState,
      appServerState: account.appServerState,
      runtimeContext: account.runtimeContext,
      effectiveAuthMode: account.effectiveAuthMode,
    });
    assert.equal(account.launchAllowed, true, 'Configured app Codex account is not launchable');
    phase = 'real Codex team launch';
    const request: TeamCreateRequest = {
      teamName: f.teamName,
      cwd: f.projectPath,
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: process.env.OPENUI_LIVE_MODEL ?? 'gpt-6.1-sol',
      effort: 'low',
      fastMode: 'off',
      skipPermissions: true,
      prompt:
        'This is a disposable visualization smoke. Do not create tasks or edit files. Lead stays idle; visualizer waits for direct user requests. Never start other agents or access real projects.',
      members: [
        {
          name: 'visualizer',
          providerId: 'codex',
          model: process.env.OPENUI_LIVE_MODEL ?? 'gpt-6.1-sol',
          role: 'Visualization test assistant. Respond only to explicit user test requests. Do not edit files or create tasks.',
        },
      ],
    };
    await json(path.join(f.shots, 'launch-request.json'), {
      request,
      port,
      runtime: f.runtime,
      fixtureRoot: f.root,
    });
    const launchCall = `window.electronAPI.teams.createTeam(${JSON.stringify(request)})`;
    await cdp.evaluate(
      `(() => { window.__openuiLiveLaunch = {done:false}; ${launchCall}.then(value => {window.__openuiLiveLaunch={done:true,value};}, error => {window.__openuiLiveLaunch={done:true,error:String(error)};}); })()`
    );
    await waitFor('window.__openuiLiveLaunch?.done', 'real team creation IPC', 240_000);
    const launch = (await cdp.evaluate('window.__openuiLiveLaunch')) as Record<string, unknown>;
    assert(!launch.error, String(launch.error));
    created = true;
    await json(path.join(f.shots, 'launch-result.json'), launch);
    const value = launch.value as { runId: string };
    await waitFor(
      `(async () => { const p = await window.electronAPI.teams.getProvisioningStatus(${JSON.stringify(value.runId)}); if (p.state === 'failed') throw new Error(JSON.stringify(p)); return p.state === 'ready'; })()`,
      'real Codex bootstrap readiness',
      300_000
    );
    const runtime = await api(
      `window.electronAPI.teams.getTeamAgentRuntime(${JSON.stringify(f.teamName)})`
    );
    await json(path.join(f.shots, 'runtime-ready.json'), runtime);
    milestones.push({ phase, ok: true });
    await cdp.evaluate(
      `(async () => { const s=window.__agentTeamsDevStore.getState(); await s.fetchTeams(); s.openTeamTab(${JSON.stringify(f.teamName)},${JSON.stringify(f.projectPath)}); await s.selectTeam(${JSON.stringify(f.teamName)},{skipProjectAutoSelect:true}); s.setMessagesPanelMode('sidebar'); })()`
    );
    phase = 'real Codex OpenUI discovery request';
    const discoveryMarker = token + '_DISCOVERY';
    const discoveryPrompt = `Show a bar chart of Alpha = 10 and Beta = 20 right here in this chat using OpenUI, with a short explanation. Include ${discoveryMarker} in your explanation.`;
    const discoverySent = await api(
      `window.electronAPI.teams.sendMessage(${JSON.stringify(f.teamName)},${JSON.stringify({ member: 'visualizer', text: discoveryPrompt, from: 'user', messageId: randomUUID() })})`
    );
    await json(path.join(f.shots, 'discovery-request-delivery.json'), discoverySent);
    const discovery = await reply(discoveryMarker, undefined, (message) =>
      readOpenUIReply(message.text).fences.some((fence) => fence.state === 'closed')
    );
    const discovered = await parseGeneratedVisualization(discovery.text);
    assert(
      discovered.prose.includes(discoveryMarker),
      'Discovery explanation must accompany the visualization'
    );
    const discoveryChart = discovered.cards
      .flatMap((card) => card.props.children)
      .find((node) => node.typeName === 'BarChart');
    assert(discoveryChart, 'Ordinary OpenUI request must produce a bar chart');
    const discoveryLabels = discoveryChart.props.labels as string[];
    const discoverySeries = discoveryChart.props.series as { props: { values: number[] } }[];
    assert.equal(discoveryLabels.length, 2, 'Discovery chart labels');
    assert.equal(discoverySeries.length, 1, 'Discovery chart series');
    assert.equal(discoverySeries[0].props.values.length, 2, 'Discovery chart values');
    assert.deepEqual(
      Object.fromEntries(
        discoveryLabels.map((label, index) => [label, discoverySeries[0].props.values[index]])
      ),
      { Alpha: 10, Beta: 20 },
      'Discovery chart preserves requested data'
    );
    await json(path.join(f.shots, 'discovery-parser-proof.json'), {
      ok: true,
      source: discovered.source,
      root: discovered.parsed.root,
    });
    await openSurface('visualizer');
    const discoveryBlock = openuiBlock(discoveryMarker, discovered.fenceIndex);
    await waitFor(
      `${discoveryBlock}?.getAttribute('data-chat-visualization-status') === 'content'`,
      'discovered OpenUI reply valid'
    );
    await click(`${discoveryBlock}.querySelector('button')`);
    await waitFor(
      `document.querySelector('[role="dialog"] [data-openui-chart="bar"]')`,
      'discovered OpenUI chart rendered'
    );
    await screenshot(path.join(f.shots, 'discovery-chart.png'));
    await key('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'discovery chart closes');
    milestones.push({ phase, ok: true, messageId: discovery.messageId });
    phase = 'real Codex catalog request';
    const galleryMarker = token + '_CATALOG';
    const galleryPrompt = `${galleryMarker}\nRefresh member_briefing once, then generate a fictional static visualization gallery yourself from the exact enabled OpenUI library. Reply to user via actual MCP message_send from visualizer; include this marker in readable prose outside fences. No task creation or file edits. One fenced openui-lang root Stack with separate Cards titled exactly: BAR_GROUPED, BAR_STACKED, LINE_LINEAR, LINE_NATURAL, LINE_STEP, PIE_PIE_CIRCULAR, PIE_PIE_SEMI, PIE_DONUT_CIRCULAR, PIE_DONUT_SEMI, TABLE_TEXT. Each chart must use its requested variant; Pie appearances circular or semiCircular. Bars need two Series and three labels; Lines need four non-collinear points to distinguish interpolation; all data fictional finite static values. TABLE_TEXT has CardHeader title+subtitle, Table/Col with12rows and cells string/number/boolean/null (column types only string/number or omitted), plus TextContent examples for all5sizes small/default/large/small-heavy/large-heavy. Use real library positional signatures, optional null placeholders only where necessary, one assignment per line. No Query/state/actions/functions. Also include one fenced mermaid flowchart Start-->Done. End with short readable explanation. Do not acknowledge without sending the complete gallery to user.`;
    const sent = await api(
      `window.electronAPI.teams.sendMessage(${JSON.stringify(f.teamName)},${JSON.stringify({ member: 'visualizer', text: galleryPrompt, from: 'user', messageId: randomUUID() })})`
    );
    await json(path.join(f.shots, 'catalog-request-delivery.json'), sent);
    const gallery = await reply(galleryMarker);
    const { textExamples, fenceIndex: galleryFenceIndex } = await verifyGeneratedCatalog(
      gallery.text,
      path.join(f.shots, 'catalog-parser-proof.json')
    );
    assert(
      gallery.text.includes('```openui-lang') && gallery.text.includes('```mermaid'),
      'Agent must generate both formats'
    );
    await openSurface('visualizer');
    const galleryBlock = openuiBlock(galleryMarker, galleryFenceIndex);
    await waitFor(
      `${galleryBlock}?.getAttribute('data-chat-visualization-status') === 'content'`,
      'agent gallery valid'
    );
    const opener = `${galleryBlock}.querySelector('button')`;
    await click(opener);
    await waitFor(
      `document.querySelector('[role="dialog"] [data-openui-chart="bar"]')`,
      'agent chart actual render'
    );
    const titles = [
      'BAR_GROUPED',
      'BAR_STACKED',
      'LINE_LINEAR',
      'LINE_NATURAL',
      'LINE_STEP',
      'PIE_PIE_CIRCULAR',
      'PIE_PIE_SEMI',
      'PIE_DONUT_CIRCULAR',
      'PIE_DONUT_SEMI',
      'TABLE_TEXT',
    ];
    for (const title of titles) {
      await waitFor(
        `document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(title)})`,
        'agent card ' + title
      );
      await cdp.evaluate(
        `(() => { const e=Array.from(document.querySelector('[role="dialog"]').querySelectorAll('*')).find(e=>e.textContent===${JSON.stringify(title)}); e?.scrollIntoView({block:'start',behavior:'instant'}); })()`
      );
      await screenshot(path.join(f.shots, title + '.png'));
    }
    const counts = await cdp.evaluate(
      `({bar:document.querySelectorAll('[role="dialog"] [data-openui-chart="bar"]').length,line:document.querySelectorAll('[role="dialog"] [data-openui-chart="line"]').length,pie:document.querySelectorAll('[role="dialog"] [class$="-pie-chart-svg-wrapper"] svg').length,table:document.querySelectorAll('[role="dialog"] table').length})`
    );
    await json(path.join(f.shots, 'catalog-dom-counts.json'), counts);
    assert.deepEqual(counts, { bar: 2, line: 3, pie: 4, table: 1 });
    const firstPage = await cdp.evaluate(
      `document.querySelector('[role="dialog"] tbody')?.innerText`
    );
    await click(`document.querySelector('[role="dialog"] button[aria-label="Next page"]')`);
    await waitFor(
      `document.querySelector('[role="dialog"] tbody')?.innerText !== ${JSON.stringify(firstPage)}`,
      'actual table next page'
    );
    await screenshot(path.join(f.shots, 'TABLE_PAGE_2.png'));
    await click(`document.querySelector('[role="dialog"] button[aria-label="Previous page"]')`);
    await waitFor(
      `document.querySelector('[role="dialog"] tbody')?.innerText === ${JSON.stringify(firstPage)}`,
      'actual table previous page'
    );
    const textStyles = await cdp.evaluate(
      `(${JSON.stringify(textExamples)}).map(example => {const element=Array.from(document.querySelector('[role="dialog"]').querySelectorAll('span')).find(e=>e.textContent===example.text);if(!element)throw new Error('Actual text style missing '+example.size);const css=getComputedStyle(element);return {...example,fontSize:css.fontSize,fontWeight:css.fontWeight};})`
    );
    await json(path.join(f.shots, 'text-style-proof.json'), textStyles);
    await cdp.evaluate(
      `(() => { const element=Array.from(document.querySelector('[role="dialog"]').querySelectorAll('span')).find(e=>e.textContent===${JSON.stringify(textExamples.at(-1)?.text)}); element?.scrollIntoView({block:'end',behavior:'instant'}); })()`
    );
    await screenshot(path.join(f.shots, 'TEXT_ALL_SIZES.png'));
    await key('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'gallery closes');
    await waitFor(`document.activeElement === ${opener}`, 'live gallery focus restoration');
    await openSurface('Group chat');
    await waitFor(
      `document.body.innerText.includes(${JSON.stringify(galleryMarker)})`,
      'actual same agent delivery main feed'
    );
    await click(`document.querySelector('[role="switch"][aria-label="Full Screen"]')`);
    await waitFor(
      `${galleryBlock}?.getAttribute('data-chat-visualization-presentation') === 'inline' && ${galleryBlock}?.querySelector('[data-openui-chart="line"]')`,
      'main gallery inline'
    );
    await screenshot(path.join(f.shots, 'main-gallery-inline.png'));
    await click(`document.querySelector('[role="switch"][aria-label="Full Screen"]')`);
    milestones.push({ phase, ok: true, messageId: gallery.messageId });
    phase = 'real Codex ordinary answer';
    const plainMarker = token + '_PLAIN';
    await api(
      `window.electronAPI.teams.sendMessage(${JSON.stringify(f.teamName)},${JSON.stringify({ member: 'visualizer', from: 'user', text: plainMarker + ' Reply using actual MCP message_send to user: include this marker and answer 2+2 in ordinary prose. No visualization, code fence, task or file edits.', messageId: randomUUID() })})`
    );
    const plain = await reply(plainMarker);
    assert(
      /(?:four|\b4\b)/i.test(plain.text.replace(plainMarker, '')) && !plain.text.includes('```'),
      'Ordinary answer stays ordinary'
    );
    milestones.push({ phase, ok: true, messageId: plain.messageId });
    phase = 'real Codex group request';
    const group = (await api(
      `window.electronAPI.teamGroupChats.create(${JSON.stringify({ teamName: f.teamName, id: randomUUID(), name: 'Live visualization group', selectedMemberNames: ['team-lead', 'visualizer'], excludedMemberNames: [], autoIncludeNewMembers: true })})`
    )) as { id: string };
    const groupMarker = token + '_GROUP';
    const backButton = `document.querySelector('button[aria-label="Back to chats"]')`;
    if (await cdp.evaluate(`Boolean(${backButton})`)) await click(backButton);
    await waitFor(
      `document.querySelector('[data-group-chat-id="${group.id}"]')`,
      'real group list'
    );
    await click(`document.querySelector('[data-group-chat-id="${group.id}"]')`);
    await waitFor(
      `document.querySelector('[data-testid="group-chat-composer"] textarea:not([disabled]):not([readonly])')`,
      'live group composer'
    );
    await click(
      `document.querySelector('[data-testid="group-chat-composer"] .message-composer-recipient-selector')`
    );
    await click(button('All'));
    await waitFor(
      `document.querySelector('[data-testid="group-chat-composer"] .message-composer-recipient-selector')?.textContent.includes('All')`,
      'group addresses all actual members'
    );
    await fill(
      '[data-testid="group-chat-composer"] textarea',
      `${groupMarker} visualizer only: generate a new tiny fictional Table+BarChart in fenced openui-lang and Mermaid flowchart. Reply via real group_chat_send to this group, preserve incoming physical messageId as relayOfMessageId and canonical groupChatId. New UUID messageId. Include marker in prose. Lead stays silent. No file edits/tasks. Do not send private echo.`
    );
    await click(button('Send', `document.querySelector('[data-testid="group-chat-composer"]')`));
    let groupRequest: Message | undefined;
    const sendDeadline = Date.now() + 30_000;
    while (Date.now() < sendDeadline) {
      groupRequest = (await messages()).find(
        (message) =>
          message.from === 'user' &&
          message.groupChatId === group.id &&
          message.text.includes(groupMarker)
      );
      if (groupRequest) break;
      await delay(100);
    }
    assert(groupRequest, 'Actual group UI request saved');
    assert(
      (groupRequest as Message & { groupRecipientNames: string[] }).groupRecipientNames.includes(
        'visualizer'
      ),
      'Group request actually targets visualizer'
    );
    await json(path.join(f.shots, 'group-request.json'), groupRequest);
    const groupReply = await reply(groupMarker, group.id);
    assert.equal(groupReply.messageId, groupReply.groupMessageId, 'Real group canonical identity');
    const groupArticle = openuiArticle(groupMarker);
    await waitFor(
      `${groupArticle}?.querySelector('[data-chat-visualization-kind="openui"][data-chat-visualization-status="content"]') && ${groupArticle}?.querySelector('[data-chat-visualization-kind="mermaid"]')`,
      'actual new group visual reply'
    );
    await click(`${groupArticle}.querySelector('[data-chat-visualization-kind="openui"] button')`);
    await waitFor(
      `document.querySelector('[role="dialog"] table') && document.querySelector('[role="dialog"] [data-openui-chart="bar"]')`,
      'real group table chart'
    );
    await screenshot(path.join(f.shots, 'actual-group-reply.png'));
    await key('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'new group OpenUI closes');
    const mermaidOpener = `${groupArticle}.querySelector('[data-chat-visualization-kind="mermaid"] button')`;
    await click(mermaidOpener);
    await waitFor(
      `document.querySelector('[role="dialog"] svg[id^="mermaid-"]')`,
      'actual new group Mermaid SVG'
    );
    await screenshot(path.join(f.shots, 'actual-group-mermaid.png'));
    await key('Escape');
    await waitFor(
      `!document.querySelector('[role="dialog"]') && document.activeElement === ${mermaidOpener}`,
      'new group Mermaid Escape focus'
    );
    milestones.push({ phase, ok: true, messageId: groupReply.messageId, groupChatId: group.id });
    assert.deepEqual(rendererErrors, [], 'Renderer exceptions');
    await json(path.join(f.shots, 'result.json'), {
      ok: true,
      teamName: f.teamName,
      projectPath: f.projectPath,
      fixtureRoot: f.root,
      port,
      runtime: f.runtime,
      milestones,
      rendererErrors,
      transport:
        'Actual app IPC sends; real Codex native agent MCP message_send/group_chat_send replies; durable inbox watcher; no synthetic reply injection.',
    });
    console.log(JSON.stringify({ ok: true, evidence: f.shots, teamName: f.teamName }));
  } catch (error) {
    await cdp?.screenshot(path.join(f.shots, 'failure.png')).catch(() => undefined);
    await json(path.join(f.shots, 'failure.json'), {
      phase,
      error: String(error),
      milestones,
      rendererErrors,
      body: await cdp?.evaluate('document.body.innerText').catch(() => null),
      logs,
    });
    throw error;
  } finally {
    if (created)
      await api(`window.electronAPI.teams.stop(${JSON.stringify(f.teamName)})`).catch(
        () => undefined
      );
    if (!keep) await cdp?.send('Browser.close').catch(() => undefined);
    await cdp?.close().catch(() => undefined);
    if (!keep && app?.pid) {
      try {
        process.kill(-app.pid, 'SIGTERM');
      } catch {
        /* Owned launcher already exited. */
      }
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
