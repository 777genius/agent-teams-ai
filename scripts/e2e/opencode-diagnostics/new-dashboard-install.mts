import assert from 'node:assert/strict';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

interface Fingerprint { path: string; sha256: string }
interface ProcessIdentity { pid: number; birth: string; executable: string }
interface RuntimeStatus {
  installed: boolean; source: string; state: string; binaryPath?: string; version?: string;
  progress?: { phase: string; percent?: number };
}
interface Catalog { state: string; models: string[]; diagnostics?: { message?: string } }
interface ModelOrigin { launchModel: string; source: string;
  metadata?: { opencode?: { providerId: string | null; routeKind: string; accessKind: string } } }
interface UiSnapshot {
  runtime: RuntimeStatus | null; gate: string | null;
  cards: { id: string; blocked: boolean }[]; catalog: Catalog | null;
  modelBadges: { modelId: string; label: string }[]; inventory: ModelOrigin[];
}
interface Artifact {
  app: Fingerprint; archive: Fingerprint; orchestrator: Fingerprint; rendererArtifact: Fingerprint;
}
interface Profile {
  userData: string; home: string; project: string; run: string; artifact: Artifact;
}
interface Receipt {
  schemaVersion: 1; sourceCommit: string; runtimeVersion: string;
  buildRunId: string; buildJobId: string; artifactId: string; buildAttempt: number;
  originalArchivePath: string; originalArchiveSha256: string; artifact: Artifact;
}
interface Ports {
  root: string; data: Profile;
  evaluate: <T>(expression: string) => Promise<T>;
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  mainIdentity: () => ProcessIdentity;
  catalogExpression: string;
  fingerprint: (file: string) => Promise<Fingerprint>;
  provenance: (status: RuntimeStatus) => Promise<Fingerprint>;
  versionProbe: (binary: string) => Promise<{ passed: boolean; stdout: string; [key: string]: unknown }>;
}

// The operator verifies the official build run before writing this receipt. Hashes
// bind that already qualified payload to seed-packaged's own byte fingerprints.
export function assertQualifiedPayload(artifact: Artifact, receipt: Receipt): void {
  assert.equal(receipt.schemaVersion, 1);
  assert(/^[a-f0-9]{40}$/.test(receipt.sourceCommit), 'Product source must be a complete 40-character commit SHA');
  assert.equal(receipt.sourceCommit, 'b54020c17cc2624668fed77d5c8e98698866da59');
  assert.equal(receipt.runtimeVersion, '0.0.105');
  assert.equal(receipt.buildRunId, '37577692624', 'Qualified official build run differs');
  assert.equal(receipt.buildJobId, '112650170287', 'Qualified Windows x64 producer differs');
  assert.equal(receipt.artifactId, '11462824999', 'Qualified official Windows payload differs');
  assert.equal(receipt.buildAttempt, 1);
  assert.equal(receipt.originalArchiveSha256, '92a6b30ec214240df1f2742060cfe993d858526b11c42f0ef51b0ac6b3a2ea91');
  assert(path.isAbsolute(receipt.originalArchivePath), 'Actual downloaded official full ZIP required');
  for (const key of ['app', 'archive', 'orchestrator', 'rendererArtifact'] as const) {
    assert(/^[a-f0-9]{64}$/.test(receipt.artifact[key].sha256), 'Invalid qualified hash');
    assert.equal(artifact[key].sha256, receipt.artifact[key].sha256, `Qualified ${key} bytes differ`);
  }
}

// Read committed React props, following child/sibling links from FiberRoot.current.
// No bridge call, store write, hook replacement, or application sentinel is needed.
function readRuntimeUi(document: Document, catalog: Catalog | null): UiSnapshot {
  interface Fiber {
    key?: string; return?: Fiber; child?: Fiber; sibling?: Fiber; stateNode?: { current?: Fiber };
    memoizedProps?: { openCodeRuntimeStatus?: RuntimeStatus; runtimeStatus?: RuntimeStatus; gate?: string; cliStatus?: { providers?: { providerId: string; modelCatalogRefreshState?: string; modelCatalog?: { models: ModelOrigin[] } }[] } };
  }
  const committedRoots = (): Set<Fiber> => {
    const roots = new Set<Fiber>();
    for (const element of document.querySelectorAll('*')) {
      const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
      let top = key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
      const ancestry = new Set<Fiber>();
      while (top?.return && !ancestry.has(top)) { ancestry.add(top); top = top.return; }
      if (top?.stateNode?.current) roots.add(top.stateNode.current);
    }
    return roots;
  };
  let runtime: RuntimeStatus | null = null;
  let gate: string | null = null;
  let inventory: ModelOrigin[] = [];
  const seen = new Set<Fiber>();
  const pending: (Fiber | undefined)[] = [...committedRoots()];
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    const provider = props?.cliStatus?.providers?.find((item) => item.providerId === 'opencode' && item.modelCatalogRefreshState);
    if (provider?.modelCatalog) inventory = provider.modelCatalog.models;
    const status = props?.openCodeRuntimeStatus ?? props?.runtimeStatus;
    if (status && typeof status.installed === 'boolean' && typeof status.source === 'string') {
      runtime = { installed: status.installed, source: status.source, state: status.state,
        binaryPath: status.binaryPath, version: status.version,
        progress: status.progress && { phase: status.progress.phase, percent: status.progress.percent } };
      if (props?.gate) gate = props.gate;
    }
    pending.push(fiber.child, fiber.sibling);
  }
  const cards = [...document.querySelectorAll('[data-testid^="provider-quick-card-"]')]
    .filter((element) => element.getBoundingClientRect().height > 0)
    .map((element) => ({ id: element.getAttribute('data-testid') ?? '',
      blocked: element.getAttribute('data-disabled') === 'true' }));
  const modelBadges = [...document.querySelectorAll('span')].flatMap((element) => {
    const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
    const fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
    const modelId = fiber?.key?.replace(/-\d+$/, '');
    const box = element.getBoundingClientRect();
    return modelId && catalog?.models.includes(modelId) && box.height > 0 && box.bottom > 0 && box.top < innerHeight
      ? [{ modelId, label: element.textContent?.trim() ?? '' }] : [];
  });
  return { runtime, gate, cards, catalog, modelBadges, inventory };
}

interface SessionIdentity {
  main: ProcessIdentity; targetId: string; frameId: string; loaderId: string; url: string; timeOrigin: number;
}
export function assertSameSession(before: SessionIdentity, after: SessionIdentity): void {
  assert.deepEqual(after, before, 'Main process or renderer document changed during installation');
}
export function assertRecoveredUi(ui: UiSnapshot): void {
  assert(ui.runtime?.installed && ui.runtime.source === 'app-managed' && ui.runtime.state === 'ready',
    'Dashboard did not observe the installed app-managed runtime');
  assert.equal(ui.gate, 'ready', 'Dashboard still blocks OpenCode runtime');
  assert(ui.cards.length > 0 && ui.cards.every((card) => !card.blocked), 'Quick providers remain blocked');
  assert.equal(ui.catalog?.state, 'ready', 'Automatic dashboard catalog did not settle');
  assert(!ui.catalog?.diagnostics?.message, 'Dashboard catalog reports an error');
  assert(ui.catalog.models.length > 0 && ui.catalog.models.every((id) => typeof id === 'string' && id.length > 0),
    'Nonempty real dashboard model inventory required; transport-only is a failure');
  assert(ui.modelBadges.length > 0 && ui.modelBadges.every((badge) => badge.label && ui.catalog?.models.includes(badge.modelId)),
    'Actual visible dashboard model badges required');
  assert(ui.inventory.some((model) => model.source === 'app-server' &&
    model.metadata?.opencode?.providerId === 'opencode' && model.metadata.opencode.routeKind === 'builtin_free' &&
    model.metadata.opencode.accessKind === 'builtin_free' && ui.modelBadges.some((badge) => badge.modelId === model.launchModel)),
    'Visible catalog must contain runtime OpenCode built-in-free routes, not static/fallback directory rows');
}

const installControl = `(() => {
  const quick = document.querySelector('[data-testid="provider-quick-opencode-prerequisite"] button');
  if (quick) return quick;
  const manage = document.querySelector('[data-testid="runtime-manage-opencode"]');
  return [...(manage?.parentElement?.querySelectorAll('button') || [])].find(button =>
    button !== manage && /install/i.test(button.textContent || '') && /opencode/i.test(button.title));
})()`;

async function waitForRecovery(
  snapshot: () => Promise<UiSnapshot>, shot: (name: string) => Promise<void>, reveal: () => Promise<unknown>, transitions: UiSnapshot[]
): Promise<{ recovered: UiSnapshot; readyAt: number | null; recoveredAt: number }> {
  let progressObserved = false;
  let readyAt: number | null = null;
  let recovered: UiSnapshot | null = null;
  const deadline = Date.now() + 720000;
  while (Date.now() < deadline) {
    const current = await snapshot();
    if (JSON.stringify(current) !== JSON.stringify(transitions.at(-1))) transitions.push(current);
    assert.notEqual(current.runtime?.state, 'failed', 'App-managed installer failed');
    if (!progressObserved && ['downloading', 'installing'].includes(current.runtime?.state ?? '')) {
      progressObserved = true; await shot('dashboard-install-progress');
    }
    if (current.runtime?.installed && current.runtime.state === 'ready') readyAt ??= Date.now();
    if (readyAt !== null) {
      assert(Date.now() - readyAt < 120000, 'Natural recovery missed the two-minute boundary');
      if (current.gate === 'ready' && current.catalog?.state === 'ready' && current.catalog.models.length > 0) {
        await reveal(); recovered = await snapshot(); assertRecoveredUi(recovered); break;
      }
    }
    await pause(250);
  }
  assert(progressObserved, 'Real installer download/install progress was not observed');
  assert(recovered, 'No automatic nonempty provider/model recovery after the dashboard click');
  return { recovered, readyAt, recoveredAt: Date.now() };
}

export async function verifyDashboardInstall(ports: Ports): Promise<void> {
  const { root, data, evaluate, send } = ports;
  assert.equal(data.run, 'cold', 'Install recovery requires a new cold TEST profile');
  const evidence: Record<string, unknown> = { passed: false, mode: 'dashboard-install', artifact: data.artifact };
  const save = (name: string, value: string | Buffer): Promise<void> => writeFile(path.join(root, data.run, name), value);
  const shot = async (name: string): Promise<void> => {
    const image = await send<{ data: string }>('Page.captureScreenshot');
    await save(`${name}.png`, Buffer.from(image.data, 'base64'));
  };
  const snapshot = (): Promise<UiSnapshot> => evaluate(`(${readRuntimeUi.toString()})(document, ${ports.catalogExpression})`);
  const identity = async (): Promise<SessionIdentity> => {
    const target = await send<{ targetInfo: { targetId: string } }>('Target.getTargetInfo');
    const frames = await send<{ frameTree: { frame: { id: string; loaderId: string; url: string } } }>('Page.getFrameTree');
    const frame = frames.frameTree.frame;
    return { main: ports.mainIdentity(), targetId: target.targetInfo.targetId, frameId: frame.id,
      loaderId: frame.loaderId, url: frame.url, timeOrigin: await evaluate<number>('performance.timeOrigin') };
  };
  const click = async (control: string): Promise<void> => {
    // Fail before mousePressed if another element covers the actual control.
    const point = await evaluate<{ x: number; y: number; label: string }>(`(() => {
      const button = ${control};
      if (!button || button.disabled) throw new Error('Required enabled UI control missing');
      button.scrollIntoView({block:'center'});
      const box = button.getBoundingClientRect(), x = box.left + box.width/2, y = box.top + box.height/2;
      const hit = document.elementFromPoint(x,y);
      if (!(box.width > 0 && box.height > 0 && hit && (hit === button || button.contains(hit))))
        throw new Error('UI control failed hit test');
      return {x,y,label:button.textContent.trim()};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y });
    evidence[control === installControl ? 'installClick' : 'manageClick'] = point;
  };
  try {
    const receiptPath = process.env.TEST_OPENCODE_QUALIFIED_PAYLOAD_RECEIPT;
    assert(receiptPath, 'Qualified official payload receipt required');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
    assertQualifiedPayload(data.artifact, receipt);
    evidence.originalArchive = await ports.fingerprint(receipt.originalArchivePath);
    assert.equal((evidence.originalArchive as Fingerprint).sha256, receipt.originalArchiveSha256, 'Official full ZIP bytes differ');
    evidence.qualifiedPayload = receipt;
    evidence.scenario = await ports.fingerprint(fileURLToPath(import.meta.url));
    const managedRoot = path.join(data.userData, 'data/runtimes/opencode');
    const manifestPath = path.join(managedRoot, 'current.json');
    await assert.rejects(access(manifestPath), { code: 'ENOENT' }, 'TEST runtime already installed');
    let before = await snapshot();
    const settle = Date.now() + 60000;
    while ((!before.runtime || before.gate === 'checking') && Date.now() < settle) {
      await pause(250); before = await snapshot();
    }
    assert.equal(before.runtime?.installed, false, 'OpenCode must initially be absent');
    assert.equal(before.runtime.source, 'missing');
    assert.equal(before.gate, 'missing');
    assert(before.cards.length > 0 && before.cards.every((card) => card.blocked));
    evidence.before = before;
    const session = await identity();
    evidence.sessionBefore = session;
    await shot('dashboard-before-install');
    await click(installControl); // Exactly one install click. No retries or direct IPC.
    const transitions: UiSnapshot[] = [];
    evidence.transitions = transitions;
    const { recovered, readyAt, recoveredAt } = await waitForRecovery(snapshot, shot, () => evaluate(`document.querySelector('[data-testid="runtime-manage-opencode"]')?.scrollIntoView({block:'center'})`), transitions);
    evidence.recoveryTiming = { readyAt, recoveredAt };
    evidence.recovered = recovered;
    evidence.sessionRecovered = await identity();
    assertSameSession(session, evidence.sessionRecovered as SessionIdentity);
    await shot('dashboard-after-install');
    const resolvedRoot = await realpath(managedRoot);
    const resolvedManifest = await realpath(manifestPath);
    const contained = (file: string): boolean => {
      const relative = path.relative(resolvedRoot, file);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    assert(contained(resolvedManifest), 'Manifest escapes TEST runtime');
    const manifest = JSON.parse(await readFile(resolvedManifest, 'utf8')) as {
      schemaVersion: number; binaryPath: string; version: string; integrity: string; platformPackage: string;
    };
    assert.equal(manifest.schemaVersion, 1);
    assert(manifest.integrity && manifest.platformPackage !== 'diagnostics-fixture');
    assert.equal(manifest.version, recovered.runtime?.version);
    assert(recovered.runtime?.binaryPath);
    const installedBinary = await realpath(manifest.binaryPath);
    const statusBinary = await realpath(recovered.runtime.binaryPath);
    assert(contained(installedBinary) && contained(statusBinary), 'OpenCode binary escapes TEST runtime');
    assert.equal(installedBinary, statusBinary);
    const runtime = await ports.provenance(recovered.runtime);
    assert.equal(installedBinary, runtime.path);
    evidence.managedManifest = { ...manifest, sha256: (await ports.fingerprint(manifestPath)).sha256 };
    evidence.runtime = runtime;
    const version = await ports.versionProbe(runtime.path);
    evidence.versionProbe = version;
    assert(version.passed && version.stdout.trim() === manifest.version, 'Actual OpenCode --version differs');
    await click(`document.querySelector('[data-testid="runtime-manage-opencode"]')`);
    const catalogDeadline = Date.now() + 90000;
    let visible: { providerIds: string[]; modelIds: string[] } = { providerIds: [], modelIds: [] };
    do {
      visible = await evaluate(`(() => {
        const shown = e => e.getBoundingClientRect().height > 0;
        const list = document.querySelector('[role="dialog"] [data-testid="runtime-provider-catalog-list"]');
        return { providerIds: [...(list?.querySelectorAll('[data-testid^="runtime-provider-row-"], [data-testid^="runtime-provider-directory-row-"]') || [])].filter(e=>shown(e) && !/-header$|-content$/.test(e.getAttribute('data-testid'))).map(e=>e.getAttribute('data-testid').replace(/^runtime-provider-(directory-)?row-/, '')),
          modelIds: [...document.querySelectorAll('[role="dialog"] [data-testid^="runtime-provider-model-row-"]')].filter(shown).map(e=>e.getAttribute('data-testid')) };
      })()`);
      if (visible.providerIds.length) break;
      await pause(250);
    } while (Date.now() < catalogDeadline);
    assert(visible.providerIds.length > 0, 'Actual provider directory did not become visible');
    evidence.visibleCatalog = visible;
    await shot('provider-directory-after-install');
    const after = await identity();
    assertSameSession(session, after);
    Object.assign(evidence, { sessionAfter: after, passed: true, providerQualified: true, qualification: 'dashboard-install-provider-inventory' });
  } catch (error) {
    evidence.error = String(error); await shot('dashboard-install-failure').catch(() => undefined); throw error;
  } finally {
    await save('evidence.json', JSON.stringify(evidence, null, 2));
  }
}
