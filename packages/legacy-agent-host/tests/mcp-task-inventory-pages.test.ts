import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createFilesystemTeamOwner } from "../dist/adapters/team/createFilesystemTeamOwner.js";
import { createTeamController, createTeamPolicy } from "../dist/adapters/team/ControllerAdapter.js";
import { TeamOwnerStore } from "../dist/adapters/team/TeamOwnerStore.js";
import { TaskEffectPlan } from "../dist/adapters/team/TaskEffectPlan.js";
import { TeamOwner } from "../dist/team/TeamOwner.js";
import { TeamOwnerError } from "../dist/team/contracts.js";
import { pageOwnerReadDetail } from "../dist/team/pageOwnerTaskDetail.js";
import { createTeamMcpTools } from "../dist/mcp/tools.js";
import type { TeamGrant } from "../dist/team/contracts.js";
import type { TeamBoardReadPolicy, TeamTaskInventoryFilters } from "../dist/team/ports.js";

type Task = { id: string; [key: string]: unknown };
type Tools = ReturnType<typeof createTeamMcpTools>;
interface InventoryPage {
  kind: string;
  revision: string;
  part: number;
  total: number;
  chunk: string;
  nextCursor: string | null;
}
const taskStore = createRequire(import.meta.url)("agent-teams-controller/src/internal/taskStore.js") as {
  createTask(paths: Record<string, string>, input: Record<string, unknown>): Task;
  updateTask(paths: Record<string, string>, id: string, update: (task: Task) => Task): Task;
  addTaskComment(paths: Record<string, string>, id: string, text: string,
    options: { id: string; author: string }): unknown;
};
const held = (error: unknown) => error instanceof TeamOwnerError && error.code === "hold";

function fixture(t: TestContext, inventory?: TeamBoardReadPolicy["listTaskInventory"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-task-inventory-pages-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: "TEST-backend", teamId: "TEST-team", teamName: "test-inventory" };
  const members = [
    { name: "lead", memberId: "lead-id", role: "lead" as const },
    { name: "alice", memberId: "alice-id", role: "member" as const },
  ];
  const grants: TeamGrant[] = [
    { principalId: "user", memberName: "user", permissions: ["read", "task.write", "admin"] },
    { principalId: "alice", memberName: "alice", permissions: ["read", "task.write"] },
  ];
  const options = { root, binding, members, grants };
  let owner = createFilesystemTeamOwner(options);
  const policy = createTeamPolicy(root, binding.teamName);
  if (inventory) {
    policy.reads = { ...policy.reads!, listTaskInventory: inventory };
    const store = new TeamOwnerStore(root, binding.teamName);
    owner = new TeamOwner({
      binding, members, grants, store, policy,
      taskMutations: new TaskEffectPlan(root, binding.teamName, store),
    });
  }
  const paths = createTeamController(root, binding.teamName).context.paths;
  const commands = () => {
    try { return readdirSync(join(root, "teams", binding.teamName, ".host-owner", "commands")).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const sourceFiles = () => readdirSync(paths.tasksDir!).filter((name) => name.endsWith(".json"))
    .sort().map((name) => [name, readFileSync(join(paths.tasksDir!, name), "utf8")]);
  const seed = (count: number, subject = "Canonical inventory task") => {
    // Canonical controller storage fixtures avoid creating an unrelated command
    // ledger for every graph edge; all MCP reads still use the real Owner policy.
    return Array.from({ length: count }, (_, index) => taskStore.createTask(paths, {
      id: (index + 1).toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000",
      subject, owner: "alice", status: "pending",
      createdAt: new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString(),
    }).id);
  };
  const relate = (ids: string[]) => {
    for (const id of ids)
      taskStore.updateTask(paths, id, (task) => ({ ...task, related: ids.filter((other) => other !== id) }));
  };
  return { root, binding, options, owner, policy, paths, commands, sourceFiles, seed, relate,
    tools: createTeamMcpTools(owner.connect("alice")) };
}

function collect(tools: Tools, filters: TeamTaskInventoryFilters = {}) {
  const chunks: string[] = [];
  let cursor: string | null = null;
  let revision: string | undefined;
  let total: number | undefined;
  do {
    const response = tools.call("task_list", { ...filters, ...(cursor === null ? {} : { cursor }) });
    const page = response.structuredContent?.result as InventoryPage;
    assert.equal(page.kind, "task-inventory-chunk");
    assert.equal(page.part, chunks.length);
    revision ??= page.revision;
    total ??= page.total;
    assert.equal(page.revision, revision);
    assert.equal(page.total, total);
    assert.equal("taskId" in page, false);
    assert.equal("commentId" in page, false);
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
  const result: unknown = JSON.parse(chunks.join(""));
  assert.ok(Array.isArray(result));
  return result;
}

test("task_list reads the selected window of 150 mutually related canonical tasks within MCP bounds", (t) => {
  const f = fixture(t);
  const ids = f.seed(150);
  f.relate(ids);
  const original = f.policy.reads!.listTaskInventory({ limit: 50 });
  assert.ok(Array.isArray(original));
  assert.equal(original.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 256 * 1024);
  const files = f.sourceFiles(), commands = f.commands();
  assert.deepEqual(collect(f.tools), original);
  const all = f.policy.reads!.listTaskInventory({ limit: 200 });
  assert.ok(Array.isArray(all));
  assert.equal(all.length, 150);
  assert.deepEqual(collect(f.tools, { limit: 200 }), all);
  assert.deepEqual(f.sourceFiles(), files);
  assert.deepEqual(f.commands(), commands);
});

test("task_list budgets JSON escaping and Unicode even without relationship arrays", (t) => {
  const f = fixture(t);
  const subject = "\u0001".repeat(232) + '漢😀"\\abc';
  assert.equal(subject.length, 240);
  f.seed(200, subject);
  const expected = f.policy.reads!.listTaskInventory({ limit: 200 });
  assert.ok(Array.isArray(expected));
  assert.ok(expected.every((row) => !row.related && !row.blockedBy && !row.blocks));
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 256 * 1024);
  const files = f.sourceFiles();
  assert.deepEqual(collect(f.tools, { limit: 200 }), expected);
  assert.deepEqual(f.sourceFiles(), files);
  assert.deepEqual(f.commands(), []);
});

test("task_list continuations keep the original query, owner, revision and read kind", (t) => {
  const f = fixture(t);
  const ids = f.seed(150);
  f.relate(ids);
  const taskId = ids[0]!;
  taskStore.updateTask(f.paths, taskId, (task) => ({ ...task, description: "漢".repeat(90_000) }));
  taskStore.addTaskComment(f.paths, taskId, "界".repeat(90_000), { id: "TEST-comment", author: "user" });
  const result = (args: unknown) => f.tools.call("task_list", args).structuredContent?.result as InventoryPage;
  const first = result({});
  assert.ok(first.nextCursor);
  const cursor = first.nextCursor;
  assert.deepEqual(result({ cursor }), result({ limit: 50, cursor }));
  assert.throws(() => result({ owner: "alice", cursor }), held);
  assert.throws(() => result({ status: "pending", cursor }), held);
  const full = result({ limit: 200 });
  assert.throws(() => result({ limit: 199, cursor: full.nextCursor }), held);
  const scoped = result({ owner: "alice", status: "pending", limit: 50 });
  assert.deepEqual(
    result({ owner: "alice", status: "pending", limit: 50, cursor: scoped.nextCursor }),
    result({ limit: 50, status: "pending", owner: "alice", cursor: scoped.nextCursor }),
  );
  assert.throws(() => result({ cursor: "1." + "0".repeat(64) }), held);
  assert.throws(() => result({ cursor: "invalid" }));
  assert.throws(() => result({ cursor, teamName: "foreign" }));
  assert.throws(() => createTeamMcpTools(f.owner.connect("user")).call("task_list", { cursor }), held);
  const reopened = createFilesystemTeamOwner({ ...f.options, members: [], grants: [] });
  assert.throws(() => createTeamMcpTools(reopened.connect("alice")).call("task_list", { cursor }), held);
  for (const [tool, args] of [
    ["task_get", { taskId }],
    ["task_get_comment", { taskId, commentId: "TEST-comment" }],
  ] as const) {
    const page = f.tools.call(tool, args).structuredContent?.result as InventoryPage;
    assert.ok(page.nextCursor);
    assert.throws(() => result({ cursor: page.nextCursor }), held);
    assert.throws(() => f.tools.call(tool, { ...args, cursor }), held);
  }
  taskStore.updateTask(f.paths, taskId, (task) => ({ ...task, subject: "Changed selected inventory" }));
  assert.throws(() => result({ cursor }), held);
  const current = result({});
  f.owner.connect("user").revoke("alice");
  assert.throws(() => result({ cursor: current.nextCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "forbidden");
  assert.deepEqual(f.commands(), []);
});

test("task_list pages a single oversized policy row without passing cursor to canonical filters", (t) => {
  const row = {
    id: "TEST-large", displayId: "1", subject: "Large retained relationship row",
    status: "pending", reviewState: "none", commentCount: 0,
    related: Array.from({ length: 8_000 }, (_, index) =>
      index.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000000"),
  };
  const expected = [row];
  const seen: TeamTaskInventoryFilters[] = [];
  // Policy-boundary fixture: one oversized row exercises a case a prefix-of-rows
  // pager could not serve, independently of controller relationship admission.
  const f = fixture(t, (filters) => { seen.push(structuredClone(filters)); return expected; });
  const before = JSON.stringify(expected);
  assert.ok(Buffer.byteLength(before) > 256 * 1024);
  assert.deepEqual(collect(f.tools, { owner: "alice", limit: 1 }), expected);
  assert.ok(seen.length > 1);
  assert.ok(seen.every((filters) => JSON.stringify(filters) === JSON.stringify({ owner: "alice", limit: 1 })));
  assert.equal(JSON.stringify(expected), before);
  assert.deepEqual(f.commands(), []);
});

test("task_list preserves small arrays exactly and rejects malformed policy results", (t) => {
  let current: unknown = [];
  const f = fixture(t, () => current);
  for (const expected of [[], [{ id: "TEST-small", subject: "Small inventory", related: ["TEST-other"] }]]) {
    current = expected;
    const response = f.tools.call("task_list", {});
    assert.equal(JSON.stringify(response.structuredContent?.result), JSON.stringify(expected));
    const content = response.content[0];
    assert.ok(content?.type === "text");
    assert.equal(content.text, JSON.stringify(expected));
    assert.throws(() => f.tools.call("task_list", { cursor: "1." + "0".repeat(64) }), held);
  }
  for (const malformed of [null, undefined, {}, "not an inventory"]) {
    current = malformed;
    assert.throws(() => f.tools.call("task_list", {}), held);
  }
  assert.deepEqual(f.commands(), []);
});

test("inventory chunk cursors bind current full grant, Team and key independently of identical data", () => {
  const grant: TeamGrant = { principalId: "alice", memberName: "alice", permissions: ["read", "task.write"] };
  const original = {
    principalId: "alice", grant, key: "TEST-owner-key", teamName: "test-inventory",
    inventoryFilters: { limit: 50 },
    value: [{ id: "TEST-large", subject: "漢".repeat(90_000) }],
  };
  const first = pageOwnerReadDetail(original);
  assert.ok(first && typeof first === "object" && !Array.isArray(first));
  const cursor = first.nextCursor;
  assert.ok(typeof cursor === "string");
  const changedGrant: TeamGrant = { ...grant, permissions: ["read"] };
  const changes: Partial<Pick<typeof original, "principalId" | "grant" | "key" | "teamName">>[] = [
    { principalId: "user" },
    { key: "TEST-other-key" },
    { teamName: "test-other" },
    { grant: changedGrant },
    { grant: { ...grant, memberName: "bob" } },
    { grant: { ...grant, revision: 2 } },
  ];
  for (const changed of changes)
    assert.throws(() => pageOwnerReadDetail({ ...original, ...changed, cursor }), held);
});
