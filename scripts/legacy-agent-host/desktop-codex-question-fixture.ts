import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  desktopBackendEnvironment,
  digest,
  fileDigest,
} from "./desktop-backend-fixture.ts";
import { readTeamHostProfile } from "../../packages/legacy-agent-host/dist/composition/readProfile.js";
import { readCodexMcpCatalog } from "../../packages/legacy-agent-host/dist/adapters/providers/readCodexMcpCatalog.js";
import {
  assertOwnedCdpListener,
  command,
  processTable,
} from "./desktop-backend-observations.ts";
import type { prepareDesktopBackendFixture } from "./desktop-backend-fixture.ts";
import type { TeamHostProfile } from "../../packages/legacy-agent-host/dist/composition/TeamHost.js";
import { bounded } from "./desktop-proof-bounds.ts";
import { createDesktopUiControls } from "./desktop-ui-controls.ts";
import type { UiCdpPort } from "./desktop-ui-controls.ts";
import type { startDesktopCodexQuestionModel } from "./desktop-codex-question-model.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Row;
};
const CODEX_SHA256 =
  "8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57";

/** After explicit run GO: private TEST recipe plus one real native metadata catalog capture. */
export async function prepareDesktopCodexQuestionFixture(
  base: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>,
  options: {
    executable: string;
    model: Awaited<ReturnType<typeof startDesktopCodexQuestionModel>>;
  },
) {
  assert.match(basename(base.root), /^TEST-desktop-backend-/);
  await options.model.retainEvidenceAt(base.root);
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(
    await fileDigest(base.descriptorPath),
    base.pins.descriptorSha256,
  );
  assert.equal(await realpath(options.executable), options.executable);
  assert.equal(await fileDigest(options.executable), CODEX_SHA256);
  for (const url of [options.model.url, options.model.mcpUrl]) {
    const value = new URL(url);
    assert.equal(value.protocol, "http:");
    assert.equal(value.hostname, "127.0.0.1");
    assert.ok(value.port);
  }
  const profile = JSON.parse(
    await readFile(base.profilePath, "utf8"),
  ) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(base.root, "hoststore"));
  assert.equal(profile.runtime?.members.length, 1);
  const original = profile.runtime!.members[0]!;
  const home = join(base.root, "native-codex/home"),
    config = join(base.root, "native-codex/config");
  const tmp = join(base.root, "native-codex/tmp");
  for (const path of [home, config, tmp])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const configBytes = `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(home)}, TMPDIR = ${JSON.stringify(tmp)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST fixture"
base_url = ${JSON.stringify(options.model.url + "/v1")}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;
  await writeFile(join(config, "config.toml"), configBytes, {
    mode: 0o600,
    flag: "wx",
  });
  profile.runtime = {
    members: [
      {
        provider: "codex",
        protocolRevision: "0.162.0",
        teamId: original.teamId,
        memberId: original.memberId,
        principalId: original.principalId,
        sessionId: "TEST-native-codex-question",
        generation: original.generation,
        configRevision: "TEST-native-codex-question-config",
        cwd: original.cwd,
        accountBinding: "TEST-LOCALHOST-ONLY",
        model: "mock-model",
        executable: { path: options.executable, sha256: CODEX_SHA256 },
        environment: {
          HOME: home,
          CODEX_HOME: config,
          TMPDIR: tmp,
          PATH: dirname(base.node) + ":/usr/bin:/bin",
          SHELL: "/bin/sh",
          TEST_CODEX_FIXTURE_KEY: "TEST-LOCALHOST-ONLY",
        },
        nativeOptions: {
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          modelProvider: "TEST_fixture",
          developerInstructions: "TEST_CODEX_QUESTION_CONTEXT",
        },
        capturedMcpServers: {
          TESTfinite: { type: "http", url: options.model.mcpUrl },
        },
        limits: { ...original.limits, timeoutMs: 120_000 },
      },
    ],
  };
  const selected = profile.runtime.members[0]!;
  assert.equal(selected.provider, "codex");
  if (selected.provider !== "codex")
    throw new Error("TEST expects captured Codex recipe");
  assert.equal(
    process.env.LEGACY_DESKTOP_BACKEND_GO,
    "1",
    "native metadata capture requires original explicit run GO",
  );
  selected.capturedMcpCatalog = await readCodexMcpCatalog(selected, () => {
    assert.match(basename(base.root), /^TEST-desktop-backend-/);
  });
  delete profile.management;
  const profileBytes = JSON.stringify(profile);
  readTeamHostProfile(base.profilePath, base.pins.profileSha256); // Original remains qualified before replacement.
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(base.profilePath, digest(profileBytes));
  const descriptor = row(
    JSON.parse(await readFile(base.descriptorPath, "utf8")),
  );
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  row(
    row(row(descriptor.owners[0]).profile).env,
  ).LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
  // The base descriptor has no management section unless explicitly requested.
  delete descriptor.management;
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 });
  return {
    ...base,
    appEnvironment: desktopBackendEnvironment(
      base.root,
      base.node,
      base.descriptorPath,
      digest(descriptorBytes),
    ),
    pins: {
      ...base.pins,
      profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes),
      codexConfigSha256: digest(configBytes),
      codexExecutableSha256: CODEX_SHA256,
    },
  };
}

/** Explicit TEST setup launch; ordinary Sheet/Composer controls are exercised after this. */
export async function prepareDesktopCodexQuestionLaunch(options: {
  cdp: UiCdpPort;
  fixture: { handleId: string; node: string; hostEntry: string };
  group: number;
  evidence: Row;
  executable: string;
}) {
  const invoke = async (
    operation: string,
    commandId: string,
    payload: unknown,
  ) => {
    assertOwnedCdpListener(options.group);
    return row(
      await options.cdp.evaluate(
        `window.electronAPI.agentBackend.invoke(${JSON.stringify({
          handle: { handleId: options.fixture.handleId },
          commandId,
          operation,
          payload,
        })})`,
      ),
    );
  };
  const read = await invoke("team.launch.read", "TEST-question-setup-read", {});
  assert.equal(read.ok, true);
  const selection = row(read.value);
  assert.ok(Array.isArray(selection.members) && selection.members.length === 1);
  const memberId = row(selection.members[0]).memberId;
  const configuration = { members: [{ memberId, model: "mock-model" }] };
  const started = await invoke(
    "team.launch.start",
    "TEST-question-setup-launch",
    {
      launchId: selection.launchId,
      rosterRevision: selection.rosterRevision,
      configuration,
    },
  );
  options.evidence.nativeLaunchResponse = started;
  assert.equal(started.ok, true, JSON.stringify(started));
  let ready = row(started.value);
  const deadline = Date.now() + 60_000;
  while (ready.status !== "ready" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const current = await invoke(
      "team.launch.read",
      "TEST-question-setup-progress",
      {},
    );
    assert.equal(current.ok, true);
    ready = row(current.value);
  }
  assert.equal(ready.status, "ready");
  assert.equal(ready.ready, 1);
  const table = processTable();
  const hosts = table.filter(
    (item) =>
      item.pgid === options.group &&
      command(item.pid) ===
        `${options.fixture.node} ${options.fixture.hostEntry}`,
  );
  assert.equal(hosts.length, 1);
  const hostPid = hosts[0]!.pid;
  const nativeChildren = table.filter(
    (item) =>
      item.ppid === hostPid && command(item.pid).startsWith(options.executable),
  );
  assert.equal(
    nativeChildren.length,
    1,
    "one captured actual Codex app-server",
  );
  options.evidence.nativeSetup = {
    scope:
      "Explicit TEST IPC setup launch; original Composer/Question Sheet afterward",
    configuration,
    launch: ready,
    nativeChildren,
    nativeExecutableSha256: CODEX_SHA256,
  };
  return { hostPid, nativeChildren };
}

/** A CDP target URL can precede Main startup admission and the first React mount. */
export async function waitDesktopCodexQuestionRenderer(
  cdp: UiCdpPort,
  options: { url: string; remainingStartupMs: number; assertOwnedRenderer(): void; evidence: Row },
): Promise<void> {
  assert.ok(options.remainingStartupMs > 0, "original startup budget remains");
  options.evidence.questionRendererReadiness = { status: "WAITING", remainingStartupMs: options.remainingStartupMs };
  const { waitRead } = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step() {} });
  const ready = await bounded(waitRead(`(() => {
    if(location.origin!==${JSON.stringify(new URL(options.url).origin)})return false;
    if(window.__claudeTeamsUiDidInit!==true||!window.__agentTeamsDevStore)return false;
    const children=document.getElementById('root')?.childElementCount??0;
    return children>0?{uiDidInit:true,rootChildCount:children}:false;
  })()`, "Main-admitted Codex renderer mount", options.remainingStartupMs), options.remainingStartupMs, "Codex renderer startup readiness");
  options.evidence.questionRendererReadiness = { status: "READY", observation: ready };
}
