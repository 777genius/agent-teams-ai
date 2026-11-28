import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFilesystemTeamOwner } from "../dist/adapters/team/createFilesystemTeamOwner.js";
import { createTeamController, createTeamPolicy } from "../dist/adapters/team/ControllerAdapter.js";
import { TeamOwnerStore } from "../dist/adapters/team/TeamOwnerStore.js";
import { TaskEffectPlan } from "../dist/adapters/team/TaskEffectPlan.js";
import { TeamOwner } from "../dist/team/TeamOwner.js";
import { TeamOwnerError } from "../dist/team/contracts.js";
import { pageOwnerReadDetail } from "../dist/team/pageOwnerTaskDetail.js";
import { createTeamMcpTools } from "../dist/mcp/tools.js";
import { startTeamMcpEndpoint } from "../dist/mcp/endpoint.js";
import type { TeamGrant } from "../dist/team/contracts.js";
import type { TeamBoardReadPolicy } from "../dist/team/ports.js";

type Tools = ReturnType<typeof createTeamMcpTools>;
type BriefingName = "task_briefing" | "lead_briefing" | "member_briefing";
interface BriefingPage {
  kind: string;
  revision: string;
  part: number;
  total: number;
  chunk: string;
  nextCursor: string | null;
}
const taskStore = createRequire(import.meta.url)("agent-teams-controller/src/internal/taskStore.js") as {
  createTask(paths: Record<string, string>, input: Record<string, unknown>): { id: string };
};
const held = (error: unknown) => error instanceof TeamOwnerError && error.code === "hold";
const forbidden = (error: unknown) => error instanceof TeamOwnerError && error.code === "forbidden";
const largeText = "Required first instruction.\n" + '漢😀"\u0001\\'.repeat(25_000) +
  "\nRequired final instruction: retain every rule.";

function fixture(t: TestContext, overrides: Partial<TeamBoardReadPolicy> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-mcp-briefing-pages-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: "TEST-backend", teamId: "TEST-team", teamName: "test-briefing" };
  const members = ["lead", "alice", "bob"].map((name) => ({
    name, memberId: name + "-id", role: name === "lead" ? "lead" as const : "member" as const,
  }));
  const grants: TeamGrant[] = ["user", "lead", "alice", "bob"].map((name) => ({
    principalId: name, memberName: name,
    permissions: name === "user" ? ["read", "task.write", "message.write", "admin"] :
      ["read", "task.write", "message.write"],
  }));
  createFilesystemTeamOwner({ root, binding, members, grants });
  const store = new TeamOwnerStore(root, binding.teamName);
  const policy = createTeamPolicy(root, binding.teamName);
  policy.reads = { ...policy.reads!, ...overrides };
  const reopen = () => new TeamOwner({
    binding, members, grants, store, policy,
    taskMutations: new TaskEffectPlan(root, binding.teamName, store),
  });
  const owner = reopen(), user = owner.connect("user");
  const paths = createTeamController(root, binding.teamName).context.paths;
  const files = (directory: string) => {
    try {
      return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
        .map((name) => [name, readFileSync(join(directory, name), "utf8")]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const source = () => ({
    tasks: files(paths.tasksDir!),
    receipts: files(join(store.directory, "commands")),
  });
  return { root, binding, owner, user, policy, paths, source, reopen,
    tools: createTeamMcpTools(owner.connect("alice")) };
}

async function collect(tools: Pick<Tools, "callAsync">, name: BriefingName, args: Record<string, unknown> = {}) {
  const chunks: string[] = [];
  let cursor: string | null = null, revision: string | undefined, total: number | undefined;
  do {
    const response = await tools.callAsync(name, { ...args, ...(cursor === null ? {} : { cursor }) });
    const page = response.structuredContent?.result as BriefingPage;
    assert.equal(page.kind, "briefing-chunk");
    assert.equal(page.part, chunks.length);
    revision ??= page.revision;
    total ??= page.total;
    assert.equal(page.revision, revision);
    assert.equal(page.total, total);
    const content = response.content[0];
    assert.ok(content?.type === "text");
    assert.equal(content.text, JSON.stringify(page));
    assert.ok(Buffer.byteLength(content.text) <= 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 256 * 1024);
    assert.doesNotMatch(page.chunk, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(page.chunk, /^[\uDC00-\uDFFF]/);
    chunks.push(page.chunk);
    cursor = page.nextCursor;
    assert.ok(cursor === null || typeof cursor === "string");
    assert.ok(chunks.length < 128);
  } while (cursor !== null);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.length, total);
  const restored: unknown = JSON.parse(chunks.join(""));
  assert.equal(typeof restored, "string");
  return restored;
}
async function page(tools: Tools, name: BriefingName, args: Record<string, unknown> = {}) {
  return (await tools.callAsync(name, args)).structuredContent?.result as BriefingPage;
}

test("canonical task and member briefings retain bounded previews and all rules within MCP pages", async (t) => {
  const f = fixture(t), ids: string[] = [];
  const subject = "\u0001".repeat(240), description = "\u0001".repeat(1200);
  for (let index = 0; index < 60; index++) {
    if (index === 49) {
      const response = createTeamMcpTools(f.user).call("task_create", {
        commandId: "TEST-admitted-preview", subject, description, owner: "alice", startImmediately: false,
      });
      const taskId = (response.structuredContent?.result as { effects: { taskId: string } }).effects.taskId;
      assert.equal(typeof taskId, "string");
      ids.push(taskId);
    } else ids.push(taskStore.createTask(f.paths, {
      id: (index + 1).toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000",
      subject, description, owner: "alice", from: "alice",
      status: index < 8 ? "in_progress" : "pending",
      createdAt: new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString(),
      ...(index >= 50 ? { needsClarification: "user" } : {}),
    }).id);
  }
  for (let index = 0; index < 8; index++)
    for (let part = 0; part < 5; part++) {
      const response = f.tools.call("task_add_comment", {
        commandId: "TEST-preview-comment-" + index + "-" + part,
        taskId: ids[index], text: "\u0001".repeat(500),
      });
      assert.equal((response.structuredContent?.result as { phase: string }).phase, "completed");
    }
  const before = f.source();
  const expected = await f.policy.reads!.taskBriefing("alice");
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 256 * 1024);
  assert.equal(await collect(f.tools, "task_briefing"), expected);
  const member = await f.policy.reads!.memberBriefing!("alice", { includeActiveProcesses: false });
  assert.ok(Buffer.byteLength(JSON.stringify(member)) > 256 * 1024);
  assert.equal(await collect(f.tools, "member_briefing", { includeActiveProcesses: false }), member);
  assert.deepEqual(f.source(), before);
});

test("canonical lead briefing retains every selected section within MCP pages", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 200; index++) {
    const section = Math.floor(index / 50);
    taskStore.createTask(f.paths, {
      id: (index + 1).toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000",
      subject: "\u0001".repeat(240), status: "pending", from: "lead",
      createdAt: new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString(),
      ...(section === 0 ? {} : { owner: section === 2 ? "lead" : "alice" }),
      ...(section === 1 ? { needsClarification: "lead" } : {}),
      ...(section === 3 ? { needsClarification: "user" } : {}),
    });
  }
  const before = f.source(), expected = await f.policy.reads!.leadBriefing();
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 256 * 1024);
  assert.equal(await collect(createTeamMcpTools(f.owner.connect("lead")), "lead_briefing"), expected);
  assert.deepEqual(f.source(), before);
});

test("briefing cursors bind effective member, settings, read kind, authority and current source", async (t) => {
  let text = largeText;
  const read = async () => text;
  const f = fixture(t, { taskBriefing: read, leadBriefing: read, memberBriefing: read });
  const first = await page(f.tools, "task_briefing");
  assert.ok(first.nextCursor);
  const cursor = first.nextCursor;
  assert.deepEqual(await page(f.tools, "task_briefing", { cursor }),
    await page(f.tools, "task_briefing", { memberName: "alice", cursor }));
  await assert.rejects(page(f.tools, "task_briefing", { memberName: "bob", cursor }), held);
  await assert.rejects(page(f.tools, "lead_briefing", { cursor }), held);
  await assert.rejects(page(f.tools, "member_briefing", { cursor }), held);
  await assert.rejects(page(f.tools, "task_briefing", { cursor: "1." + "0".repeat(64) }), held);
  await assert.rejects(page(f.tools, "task_briefing", { cursor: "invalid" }));
  await assert.rejects(page(f.tools, "task_briefing", { cursor, teamName: "foreign" }));
  await assert.rejects(page(createTeamMcpTools(f.owner.connect("bob")), "task_briefing", { cursor }), held);
  await assert.rejects(page(createTeamMcpTools(f.reopen().connect("alice")), "task_briefing", { cursor }), held);
  const member = await page(f.tools, "member_briefing");
  assert.ok(member.nextCursor);
  assert.deepEqual(await page(f.tools, "member_briefing", { cursor: member.nextCursor }),
    await page(f.tools, "member_briefing", { includeActiveProcesses: true, cursor: member.nextCursor }));
  await assert.rejects(page(f.tools, "member_briefing",
    { includeActiveProcesses: false, cursor: member.nextCursor }), held);
  text += "Changed required instruction.";
  await assert.rejects(page(f.tools, "task_briefing", { cursor }), held);
  const current = await page(f.tools, "task_briefing");
  f.user.replaceRoster({ commandId: "TEST-roster-change", expectedRevision: f.user.readRoster().revision,
    members: [{ name: "alice" }, { name: "bob", role: "Changed peer role" }] });
  await assert.rejects(page(f.tools, "task_briefing", { cursor: current.nextCursor }), held);
  const afterRoster = await page(f.tools, "task_briefing");
  f.user.revoke("alice");
  await assert.rejects(page(f.tools, "task_briefing", { cursor: afterRoster.nextCursor }), forbidden);
});

test("small MCP briefings and direct Owner string contracts stay unchanged", async (t) => {
  let text = 'Small canonical rules 😀 "exact".';
  const read = async () => text;
  const f = fixture(t, { taskBriefing: read, leadBriefing: read, memberBriefing: read });
  const reads = f.owner.connect("alice").readQueries!;
  for (const expected of [text, largeText]) {
    text = expected;
    const rawTask: Promise<string> = reads.taskBriefing();
    const rawLead: Promise<string> = reads.leadBriefing();
    const rawMember: Promise<string> = reads.memberBriefing!({ includeActiveProcesses: false });
    assert.deepEqual(await Promise.all([rawTask, rawLead, rawMember]), [expected, expected, expected]);
    for (const name of ["task_briefing", "lead_briefing", "member_briefing"] as const) {
      if (text === largeText) {
        assert.equal(await collect(f.tools, name), expected);
      } else {
        const result = await f.tools.callAsync(name, {});
        assert.equal(result.structuredContent?.result, expected);
        assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
        await assert.rejects(page(f.tools, name, { cursor: "1." + "0".repeat(64) }), held);
      }
      const definition = f.tools.list().find((tool) => tool.name === name)!;
      assert.match(definition.description ?? "", /all pages/);
      assert.match(definition.description ?? "", /JSON\.parse/);
    }
  }
  assert.deepEqual(f.source(), { tasks: [], receipts: [] });
});

test("briefing continuations reject changed full Team, key and grant even with identical text", () => {
  const grant: TeamGrant = { principalId: "alice", memberName: "alice", permissions: ["read", "task.write"] };
  const original = {
    principalId: "alice", grant, key: "TEST-owner-key", teamName: "test-briefing", value: largeText,
    briefingScope: { kind: "task" as const, memberName: "alice", authorityFingerprint: "TEST-authority" },
  };
  const first = pageOwnerReadDetail(original);
  assert.ok(first && typeof first === "object" && !Array.isArray(first));
  const cursor = first.nextCursor;
  assert.ok(typeof cursor === "string");
  const { briefingScope, ...common } = original;
  for (const scope of [{ taskId: "TEST-task" }, { taskId: "TEST-task", commentId: "TEST-comment" },
    { inventoryFilters: { limit: 50 } }] as const) {
    const old = pageOwnerReadDetail({ ...common, ...scope });
    assert.ok(old && typeof old === "object" && !Array.isArray(old));
    const oldCursor = old.nextCursor;
    assert.ok(typeof oldCursor === "string");
    assert.throws(() => pageOwnerReadDetail({ ...common, briefingScope, cursor: oldCursor }), held);
    assert.throws(() => pageOwnerReadDetail({ ...common, ...scope, cursor }), held);
  }
  const readOnlyGrant: TeamGrant = { ...grant, permissions: ["read"] };
  for (const changed of [
    { key: "TEST-new-key" }, { teamName: "test-other" }, { principalId: "bob" },
    { grant: readOnlyGrant },
    { grant: { ...grant, revision: 2 } },
    { briefingScope: { ...original.briefingScope, authorityFingerprint: "TEST-new-authority" } },
  ]) assert.throws(() => pageOwnerReadDetail({ ...original, ...changed, cursor }), held);
});

test("async briefing pages recheck authority after policy resolution", async (t) => {
  for (const name of ["task_briefing", "lead_briefing", "member_briefing"] as const) {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observed = new Promise<void>((resolve) => { reached = resolve; });
    const read = async () => { reached(); await gate; return largeText; };
    const f = fixture(t, { taskBriefing: read, leadBriefing: read, memberBriefing: read });
    const pending = f.tools.callAsync(name, {});
    await observed;
    if (name === "lead_briefing")
      f.user.replaceRoster({ commandId: "TEST-await-roster", expectedRevision: f.user.readRoster().revision,
        members: [{ name: "alice" }, { name: "bob", role: "Changed while awaiting" }] });
    else f.user.revoke("alice");
    release();
    await assert.rejects(pending, forbidden);
  }
});

test("member page options and cursor are captured before awaiting the canonical read", async (t) => {
  let release!: () => void, reached!: () => void, delayed = true;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed = new Promise<void>((resolve) => { reached = resolve; });
  const seen: boolean[] = [];
  const f = fixture(t, { memberBriefing: async (_member, settings) => {
    if (delayed) { delayed = false; reached(); await gate; }
    seen.push(settings.includeActiveProcesses);
    return largeText;
  } });
  const settings = { includeActiveProcesses: false }, options: { cursor?: string } = {};
  const pending = f.owner.connect("alice").readQueries!.memberBriefing!(settings, options);
  await observed;
  settings.includeActiveProcesses = true;
  options.cursor = "1." + "0".repeat(64);
  release();
  const first = await pending;
  assert.ok(first && typeof first === "object" && !Array.isArray(first));
  assert.equal(first.kind, "briefing-chunk");
  assert.equal(first.part, 0);
  assert.ok(first.nextCursor);
  await page(f.tools, "member_briefing", { includeActiveProcesses: false, cursor: first.nextCursor });
  assert.deepEqual(seen, [false, false]);
});

test("paged briefings reject malformed policy output instead of exporting arbitrary JSON", async (t) => {
  let malformed = "{}";
  // An intentionally hostile runtime policy violates its declared string return.
  const read = async () => JSON.parse(malformed);
  const f = fixture(t, { taskBriefing: read, leadBriefing: read, memberBriefing: read });
  for (malformed of ["{}", "null", "1"])
    for (const name of ["task_briefing", "lead_briefing", "member_briefing"] as const)
      await assert.rejects(page(f.tools, name), held);
});

test("HTTP SDK preserves all briefing pages and rejects a changed canonical revision", async (t) => {
  let text = largeText;
  const read = async () => text;
  const f = fixture(t, { taskBriefing: read, leadBriefing: read, memberBriefing: read });
  const binding = { ...f.binding, runId: "TEST-http-run", memberId: "alice-id", generation: "1" };
  const endpoint = await startTeamMcpEndpoint({
    connection: f.owner.connect("alice"), binding, expiresAtMs: 2000, now: () => 1000,
    isCurrentBinding: (captured) => Object.entries(binding).every(
      ([key, value]) => captured[key as keyof typeof binding] === value),
  });
  const client = new Client({ name: "TEST-briefing-http-client", version: "1" });
  t.after(async () => {
    try { await client.close(); } finally { await endpoint.close(); }
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.bearerToken}` } },
  });
  await client.connect(transport as Transport);
  const tools: Pick<Tools, "callAsync"> = {
    async callAsync(name, args) {
      assert.ok(args && typeof args === "object" && !Array.isArray(args));
      return CallToolResultSchema.parse(await client.callTool({ name, arguments: args as Record<string, unknown> }));
    },
  };
  const before = f.source();
  for (const name of ["task_briefing", "lead_briefing", "member_briefing"] as const)
    assert.equal(await collect(tools, name), text);
  const first = (await tools.callAsync("task_briefing", {})).structuredContent?.result as BriefingPage;
  assert.ok(first.nextCursor);
  text += "Changed mandatory instruction.";
  const refused = await tools.callAsync("task_briefing", { cursor: first.nextCursor });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.structuredContent, { error: { code: "hold" } });
  assert.deepEqual(refused.content, [{ type: "text", text: JSON.stringify({ error: { code: "hold" } }) }]);
  assert.deepEqual(f.source(), before);
});
