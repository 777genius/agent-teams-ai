import { desktopJsLiteral } from './desktop-ui-controls.ts';
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fileDigest } from "./desktop-backend-fixture.ts";
import { createDesktopUiControls } from "./desktop-ui-controls.ts";
import {
  extensionMcpName,
  extensionMcpUrl,
  extensionNativeCli,
  extensionPlugin,
} from "./desktop-native-extensions-fixture.ts";
import type { McpCatalogItem } from "../../src/shared/types/extensions/mcp.ts";
import type { NativeExtensionProofSelection } from "./desktop-native-extensions-fixture.ts";
import type { UiCdpPort } from "./desktop-ui-controls.ts";

const json = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** Real existing controls. One labeled TEST metadata setup; all user actions use trusted CDP input. */
export async function runDesktopNativeExtensionsUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  },
) {
  const selected = JSON.parse(
    await readFile(
      join(options.root, "native-extensions-selection.json"),
      "utf8",
    ),
  ) as NativeExtensionProofSelection;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    scope:
      "Existing Settings Advanced → Extensions; ordinary Plugin install/uninstall and Add Custom MCP config/diagnose/list/uninstall through actual pinned native CLI",
    excluded: [
      "vendor inference",
      "new disable controls",
      "real user projects/config",
      "UI lost-ACK transport injection",
      "second actual workspace context",
      "live MCP registry catalog/search qualification",
    ],
    nativeSetup: selected.setup,
    nativeExecutableSha256: selected.profile.executable.sha256,
    publicNetwork: [
      "official public plugin marketplace registration/catalog",
      "incidental ordinary MCP browse (not required for config-only proof)",
    ],
    steps,
  };
  options.evidence.nativeExtensionsUi = proof;
  const screenshots: string[] = [];
  proof.screenshots = screenshots;
  const screenshot = async (name: string) => {
    options.assertOwnedRenderer();
    const image = record(
      await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      }),
    );
    assert.equal(typeof image.data, "string");
    await writeFile(
      join(options.root, name),
      Buffer.from(String(image.data), "base64"),
      { mode: 0o600, flag: "wx" },
    );
    screenshots.push(name);
  };
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (step) => steps.push(step),
  });
  const stateExpression = `(() => {
    const s=window.__agentTeamsDevStore?.getState();if(!s)return {storePresent:false};
    const provider=s.cliStatus?.providers?.find(p=>p.providerId==='anthropic');
    return {storePresent:true,contextSwitching:Boolean(s.isContextSwitching),
      pluginLoading:Boolean(s.pluginCatalogLoading),pluginError:Boolean(s.pluginCatalogError),pluginErrorText:s.pluginCatalogError?.slice(0,300)??null,pluginCount:s.pluginCatalog.length,
      expectedPlugin:s.pluginCatalog.some(p=>p.pluginId===${desktopJsLiteral(extensionPlugin)}),
      pluginNames:s.pluginCatalog.slice(0,16).map(p=>({id:p.pluginId,name:p.name})),
      pluginQuery:document.querySelector('input[placeholder="Search plugins..."]')?.value??null,
      checkedFilterCount:document.querySelectorAll('[role="checkbox"][data-state="checked"]').length,
      mcpQuery:document.querySelector('input[placeholder="Search MCP servers..."]')?.value??null,
      cliLoading:Boolean(s.cliStatusLoading),anthropicLoading:Boolean(s.cliProviderStatusLoading?.anthropic),
      installed:s.cliStatus?.installed??null,flavor:s.cliStatus?.flavor??null,authenticated:provider?.authenticated??null,
      pluginCapability:provider?.capabilities?.extensions?.plugins?.status??null,
      pluginCardNames:[...document.querySelectorAll('.plugins-grid [role="button"] h3')].slice(0,16).map(e=>e.textContent),
      mcpCardNames:[...document.querySelectorAll('.mcp-servers-grid [role="button"] h3')].slice(0,16).map(e=>e.textContent)};
  })()`;
  const click = async (selector: string, label: string, text?: string) => {
    await ui.scrollTo(selector, label, text);
    await ui.click(selector, label, text);
  };
  // Passive bounded DOM evidence retains a transient pending button even if CDP replies late.
  await cdp.evaluate(`(() => {
    window.__TEST_extensionPending=[];
    const sample=()=>{for(const b of document.querySelectorAll('[role="dialog"] button')){
      const text=b.textContent.trim();if(/^(Installing|Removing)/.test(text)&&window.__TEST_extensionPending.length<16)
        window.__TEST_extensionPending.push({text,disabled:b.disabled,timeMs:Math.round(performance.now())});}};
    window.__TEST_extensionPendingObserver=new MutationObserver(sample);
    window.__TEST_extensionPendingObserver.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled']});return true;
  })()`);
  try {
  await ui.observeInput();
  const fill = async (selector: string, text: string) => {
    await click(selector, "focus original input " + selector);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      commands: ["selectAll"],
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 4,
    });
    await cdp.send("Input.insertText", { text });
    await ui.waitRead(`document.querySelector(${desktopJsLiteral(selector)})?.value===${desktopJsLiteral(text)}`, "original input retained " + selector);
  };
  const testMcpCard = async () =>
    String(await ui.waitRead(`(() => {
      const cards=[...document.querySelectorAll('.mcp-servers-grid > [role="button"]')];
      const match=cards.filter(e=>e.querySelector('h3')?.textContent.trim().toLowerCase()===${desktopJsLiteral(extensionMcpName)});
      return match.length===1?'.mcp-servers-grid > [role="button"]:nth-child('+(cards.indexOf(match[0])+1)+')':null;
    })()`, "one exact TEST metadata MCP card"));
  const disk = async (
    read: () => Promise<boolean>,
    label: string,
    budget = 120_000,
  ) => {
    const until = Date.now() + budget;
    while (Date.now() < until) {
      options.assertOwnedRenderer();
      if (await read()) return;
      await new Promise<void>((done) => setTimeout(done, 150));
    }
    throw new Error(label + "; no effect retry");
  };
  const settings = join(
    selected.profile.environment.CLAUDE_CONFIG_DIR!,
    "settings.json",
  );
  const enabled = async () => {
    try {
      return (
        record((await json(settings)).enabledPlugins ?? {})[extensionPlugin] ===
        true
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const configured = async () => {
    try {
      return record((await json(selected.nativeConfig)).mcpServers ?? {})[
        extensionMcpName
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  assert.equal(await enabled(), false);
  assert.equal(await configured(), undefined);
  await click(
    'button[aria-label="More actions"]',
    "open existing More menu",
  );
  await click("button", "open existing Settings", "Settings");
  await click("button", "open existing Advanced settings", "Advanced");
  await ui.scrollTo(
    "button",
    "original Settings Extensions action",
    "Extensions",
  );
  await click("button", "open Extensions from Settings", "Extensions");
  await ui.waitRead(
    `Boolean(document.querySelector('input[placeholder="Search plugins..."]'))`,
    "original Plugins panel",
  );
  proof.preCatalogRead = await cdp.evaluate(stateExpression);
  await ui.waitRead(`(() => {const s=window.__agentTeamsDevStore?.getState();return s&&!s.pluginCatalogLoading&&!s.pluginCatalogError&&s.pluginCatalog.some(p=>p.pluginId===${desktopJsLiteral(extensionPlugin)})})()`, "original official plugin catalog hydrated");
  proof.catalogHydration = await cdp.evaluate(stateExpression);
  await fill('input[placeholder="Search plugins..."]', "frontend-design");
  const pluginCard = String(await ui.waitRead(`(() => {
    const s=window.__agentTeamsDevStore?.getState();if(!s||s.pluginCatalogLoading)return null;
    const selected=s.pluginCatalog.filter(p=>p.pluginId===${desktopJsLiteral(extensionPlugin)}&&p.source==='official');
    if(selected.length!==1||s.pluginCatalog.filter(p=>p.name===selected[0].name).length!==1)return null;
    const cards=[...document.querySelectorAll('.plugins-grid > [role="button"]')],match=cards.filter(e=>e.querySelector('h3')?.textContent.trim()===selected[0].name);
    return match.length===1?'.plugins-grid > [role="button"]:nth-child('+(cards.indexOf(match[0])+1)+')':null;
  })()`, "one exact frontend-design public identity and card"));
  await click(pluginCard, "open official frontend-design plugin card");
  proof.publicPluginCatalog = await cdp.evaluate(`(() => {
    const plugin=window.__agentTeamsDevStore?.getState().pluginCatalog.find(p=>p.pluginId===${desktopJsLiteral(extensionPlugin)});
    return plugin?{pluginId:plugin.pluginId,qualifiedName:plugin.qualifiedName,source:plugin.source,version:plugin.version??null}:null;
  })()`);
  assert.equal(record(proof.publicPluginCatalog).pluginId, extensionPlugin);
  assert.equal(record(proof.publicPluginCatalog).source, "official");
  await ui.waitRead(`window.__agentTeamsDevStore?.getState().cliStatus?.providers?.some(p=>p.providerId==='anthropic'&&p.authenticated===true)`, "original native API-key status permits plugin install");
  proof.installReadiness = await cdp.evaluate(stateExpression);
  await click(
    '[role="dialog"] button',
    "native plugin install once",
    "Install",
  );
  proof.pluginPendingDisabled = await ui.waitRead(
    `window.__TEST_extensionPending.some(row=>row.text.startsWith('Installing')&&row.disabled===true)`,
    "native pending install control disabled",
  );
  await disk(enabled, "native settings did not record selected plugin");
  // Native settings are written before installation finishes. Observe the
  // original completed UI operation before querying the installed inventory.
  await ui.waitRead(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).some(e=>e.textContent.trim()==='Uninstall'&&!e.disabled)`,
    "native plugin installed control",
  );
  const nativePluginList = extensionNativeCli(selected.profile, [
    "plugin",
    "list",
  ]);
  assert.ok(
    nativePluginList.includes("frontend-design"),
    "actual CLI lists UI-installed plugin",
  );
  proof.nativePluginListObserved = true;
  await screenshot("native-extensions-plugin-installed.png");
  await click(
    '[role="dialog"] button',
    "native plugin uninstall once",
    "Uninstall",
  );
  await disk(
    async () => !(await enabled()),
    "native settings still enable removed plugin",
  );
  await ui.waitRead(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).some(e=>e.textContent.trim()==='Install'&&!e.disabled)`,
    "native plugin removal completed",
  );
  await click(
    '[role="dialog"] button',
    "close original Plugin detail",
    "Close",
  );
  await click(
    '[role="tab"]',
    "open original MCP Servers tab",
    "MCP Servers",
  );
  await click("button", "open original Add Custom dialog", "Add Custom");
  await ui.waitRead(`document.querySelector('[role="dialog"] #custom-name')?.value===''&&Boolean(document.querySelector('[role="dialog"] #custom-npm'))`, "original Custom MCP defaults hydrated");
  await fill("#custom-name", extensionMcpName);
  await click(
    '[role="dialog"] button',
    "original HTTP transport choice",
    "HTTP / SSE",
  );
  await fill("#custom-url", extensionMcpUrl);
  await click(
    '[role="dialog"] button',
    "native MCP install once",
    "Install",
  );
  await disk(
    async () => Boolean(await configured()),
    "selected native MCP config was not written",
  );
  assert.equal(record(await configured()).url, extensionMcpUrl);
  const rawNativeConfig = await readFile(selected.nativeConfig, "utf8");
  proof.nativeMcpConfigSha256 = await fileDigest(selected.nativeConfig);
  assert.ok(rawNativeConfig.includes("TEST-native-extension-config-only"));
  await ui.waitRead(`!document.querySelector('[role="dialog"] #custom-name')`, "original custom install and automatic diagnostics finish", 120_000);
  await click(
    "button",
    "run original MCP diagnostic control",
    "Check status",
  );
  await ui.waitRead(
    `(() => {const s=window.__agentTeamsDevStore?.getState(),b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Check status');return b&&!b.disabled&&!s.mcpDiagnosticsError&&Object.values(s.mcpDiagnosticsErrorByProjectPath??{}).every(value=>!value)&&document.querySelector('.mcp-diagnostics-list')?.textContent.includes(${desktopJsLiteral(extensionMcpName)})})()`,
    "original native CLI diagnostics expose configured TEST server",
    60_000,
  );
  // Catalog metadata only. Installed inventory, diagnostics, native config, API methods,
  // capability/admission state and mutation receipts are never seeded or replaced.
  await ui.waitRead(
    `(() => {const s=window.__agentTeamsDevStore?.getState();return s&&!s.isContextSwitching&&!s.mcpBrowseLoading&&document.querySelector('input[placeholder="Search MCP servers..."]')?.value==='';})()`,
    "ordinary MCP browse settled before TEST metadata setup",
  );
  const metadata = {
    id: "test.local/native-extension-config-only",
    name: extensionMcpName,
    description: "TEST metadata only; not a public registry entry or connectivity proof",
    source: "official",
    installSpec: { type: "http", url: extensionMcpUrl, transportType: "http" },
    envVars: [],
    tools: [],
    requiresAuth: false,
  } satisfies McpCatalogItem;
  proof.mcpMetadataFixture = await cdp.evaluate(`(() => {
    const store=window.__agentTeamsDevStore,s=store?.getState();
    const row=${desktopJsLiteral(metadata)};
    if(!store||!s||s.isContextSwitching||s.mcpBrowseLoading||s.mcpBrowseCatalog.some(e=>e.id===row.id||e.name===row.name))
      throw new Error('TEST MCP metadata setup refused');
    store.setState({mcpBrowseCatalog:[...s.mcpBrowseCatalog,row]});
    return {id:row.id,name:row.name,synthetic:true,sourceField:'schema-required display value only',
      claim:'catalog metadata only; native state and operation outcomes untouched'};
  })()`);
  proof.nativeMcpInventory = await ui.waitRead(`(() => {
    const s=window.__agentTeamsDevStore?.getState(),name=${desktopJsLiteral(extensionMcpName)};
    const entries=[...(s?.mcpInstalledServers??[]),...Object.values(s?.mcpInstalledServersByProjectPath??{}).flat()];
    const matches=entries.filter(e=>e.name===name);
    return matches.length?matches.map(e=>({name:e.name,scope:e.scope,targetKey:e.targetKey??null})):null;
  })()`, "actual native installed inventory contains exact TEST name");
  await click(
    await testMcpCard(),
    "open existing detail for exact TEST metadata and native installed MCP",
  );
  await screenshot("native-extensions-mcp-installed.png");
  await click(
    '[role="dialog"] button',
    "native MCP uninstall once",
    "Uninstall",
  );
  await disk(
    async () => !(await configured()),
    "selected native MCP config was not removed",
  );
  await ui.waitRead(
    `Array.from(document.querySelectorAll('[role="dialog"] button')).some(e=>e.textContent.trim()==='Install'&&!e.disabled)`,
    "native MCP removal completed",
  );
  await click(
    '[role="dialog"] button',
    "close original MCP detail",
    "Close",
  );
  proof.pendingObservations = await cdp.evaluate(`(() => {window.__TEST_extensionPendingObserver?.disconnect();return window.__TEST_extensionPending??[]})()`);
  const beforeReload = await cdp.evaluate("performance.timeOrigin");
  await cdp.send("Page.reload", { ignoreCache: true });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(beforeReload)}&&document.readyState==='complete'&&window.electronAPI&&!document.getElementById('splash')`,
    "ordinary renderer reload",
    90_000,
  );
  assert.equal(await enabled(), false);
  assert.equal(await configured(), undefined);
  assert.equal(
    await fileDigest(selected.neighborPath),
    selected.neighborSha256,
    "neighbor TEST native namespace unchanged",
  );
  const directory = join(options.root, "hoststore", "management-commands");
  const rows = await Promise.all(
    (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => json(join(directory, name))),
  );
  const mutations = rows.filter((row) => row.kind === "extension.mutation");
  assert.equal(
    mutations.length,
    4,
    "one original durable Host record per explicit UI mutation",
  );
  assert.equal(new Set(mutations.map((row) => row.commandId)).size, 4);
  assert.ok(
    mutations.every(
      (row) =>
        row.phase === "completed" &&
        row.profileId === selected.profile.profileId,
    ),
  );
  proof.completedOriginalCommandIds = mutations.map((row) => row.commandId);
  proof.reloadObserved = true;
  proof.neighborUnchanged = true;
  proof.status = "PASS";
  } finally {
    proof.finalReadState = await cdp.evaluate(stateExpression).catch(() => ({ observation: 'renderer-unavailable' }));
    proof.pendingObservations ??= await cdp.evaluate(`(() => {window.__TEST_extensionPendingObserver?.disconnect();return window.__TEST_extensionPending??[]})()`).catch(() => []);
  }
}
