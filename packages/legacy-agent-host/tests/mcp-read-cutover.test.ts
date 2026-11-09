import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createFilesystemTeamOwner } from "../dist/adapters/team/createFilesystemTeamOwner.js";
import { createTeamController, createTeamPolicy } from "../dist/adapters/team/ControllerAdapter.js";
import { TeamOwnerStore } from "../dist/adapters/team/TeamOwnerStore.js";
import { TaskEffectPlan } from "../dist/adapters/team/TaskEffectPlan.js";
import { TeamOwner } from "../dist/team/TeamOwner.js";
import { createTeamMcpTools } from "../dist/mcp/tools.js";
import { TeamOwnerError } from "../dist/team/contracts.js";
import type { TeamGrant } from "../dist/team/contracts.js";

function fixture(t: TestContext, deferred = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "TEST-mcp-bound-reads-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = {
    backendId: "TEST-backend",
    teamId: "TEST-team",
    teamName: "test-mcp-reads",
  };
  const members = ["lead", "alice", "bob"].map((name) => ({
    name,
    memberId: `${name}-id`,
    role: name === "lead" ? ("lead" as const) : ("member" as const),
  }));
  const grants: TeamGrant[] = ["user", "alice", "bob"].map((name) => ({
    principalId: name,
    memberName: name,
    permissions:
      name === "user"
        ? ["read", "task.write", "message.write", "admin"]
        : ["read", "task.write", "message.write"],
  }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const observed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const options = { root, binding, members, grants };
  let owner: TeamOwner;
  if (deferred) {
    // Same original policy/authority, with only its async read return delayed.
    createFilesystemTeamOwner(options);
    const store = new TeamOwnerStore(root, binding.teamName);
    const policy = createTeamPolicy(root, binding.teamName);
    const original = policy.reads!;
    policy.reads = {
      ...original,
      taskBriefing: async (member) => {
        const result = await original.taskBriefing(member);
        reached();
        await gate;
        return result;
      },
    };
    owner = new TeamOwner({
      binding,
      members,
      grants,
      store,
      policy,
      taskMutations: new TaskEffectPlan(root, binding.teamName, store),
    });
  } else owner = createFilesystemTeamOwner(options);
  const user = owner.connect("user");
  const commandDir = join(
    root,
    "teams",
    binding.teamName,
    ".host-owner",
    "commands",
  );
  const commands = () => {
    try {
      return readdirSync(commandDir).sort();
    } catch {
      return [];
    }
  };
  return {
    root,
    binding,
    owner,
    user,
    commands,
    release,
    observed,
    policy: createTeamPolicy(root, binding.teamName),
  };
}
const value = (response: ReturnType<ReturnType<typeof createTeamMcpTools>['call']>) => response.structuredContent?.result;

test("bound canonical queues/comments/board reads survive reopen and produce no command or file effects", async (t) => {
  const f = fixture(t);
  const tools = createTeamMcpTools(f.owner.connect("alice"));
  const task = f.user.execute({
    commandId: "TEST-create",
    operation: "task.create",
    payload: { subject: "Canonical queue proof", owner: "alice" },
  }).effects.taskId;
  const comment = f.user.execute({
    commandId: "TEST-comment",
    operation: "task.comment",
    payload: { taskId: task, text: "Actual canonical comment" },
  }).effects.commentId;
  const beforeCommands = f.commands();
  const taskPath = join(f.root, "tasks", f.binding.teamName, `${task}.json`);
  const beforeBytes = readFileSync(taskPath, "utf8");
  const queue = value(await tools.callAsync("task_briefing", {}));
  const canonical = await f.policy.reads!.taskBriefing("alice");
  assert.equal(queue, canonical);
  assert.match(canonical, /Canonical queue proof/);
  assert.equal(
    value(await tools.callAsync("lead_briefing", {})),
    await f.policy.reads!.leadBriefing(),
  );
  const read = value(
    tools.call("task_get_comment", {
      taskId: task,
      commentId: comment.slice(0, 8),
    }),
  ) as { comment: { id: string; text: string }; task: { id: string } };
  assert.equal(read.comment.id, comment);
  assert.equal(read.task.id, task);
  assert.deepEqual(
    value(tools.call("kanban_get", {})),
    f.policy.reads!.getKanbanState(),
  );
  assert.deepEqual(
    value(tools.call("kanban_list_reviewers", {})),
    f.policy.reads!.listReviewers(),
  );
  assert.equal(
    (value(tools.call("team_get", {})) as { teamName: string }).teamName,
    f.binding.teamName,
  );
  assert.deepEqual(f.commands(), beforeCommands);
  assert.equal(readFileSync(taskPath, "utf8"), beforeBytes);
  for (const tool of [
    "task_briefing",
    "lead_briefing",
    "team_get",
    "kanban_get",
    "task_get_comment",
  ]) {
    await assert.rejects(
      tools.callAsync(tool, {
        teamName: "foreign",
        claudeDir: "/foreign",
        from: "bob",
      }),
    );
  }
  await assert.rejects(
    tools.callAsync("task_briefing", { memberName: "removed" }),
  );
  const reopened = createFilesystemTeamOwner({
    root: f.root,
    binding: f.binding,
    members: [],
    grants: [],
  }).connect("alice");
  assert.equal(
    value(await createTeamMcpTools(reopened).callAsync("task_briefing", {})),
    canonical,
  );
  f.user.revoke("alice");
  assert.throws(
    () => tools.call("team_get", {}),
    (error) => error instanceof TeamOwnerError && error.code === "forbidden",
  );
});


test("team_get keeps canonical 90-comment task readable with taskParts continuations", (t) => {
  const f = fixture(t);
  const taskId = f.user.execute({
    commandId: "TEST-huge-task", operation: "task.create",
    payload: { subject: "Large task history", owner: "alice" },
  }).effects.taskId;
  for (let index = 0; index < 90; index++)
    f.user.execute({
      commandId: "TEST-huge-comment-" + index,
      operation: "task.comment",
      payload: { taskId, text: "comment-" + index + "-" + "x".repeat(6000) },
    });
  const expected = f.user.getTask(taskId).comments as { text: string }[];
  assert.equal(expected.length, 90);
  const tools = createTeamMcpTools(f.owner.connect("alice"));
  const fragments = new Map<number, { total: number; values: Map<number, unknown> }>();
  let cursor: string | null = null;
  let revision: string | undefined;
  let pages = 0;
  do {
    const page = value(tools.call("team_get", cursor ? { cursor } : {})) as {
      revision: string;
      tasks: { id: string; comments?: { text: string }[] }[];
      taskParts: { index: number; part: number; total: number }[];
      nextCursor: string | null;
    };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    assert.equal(revision === undefined || revision === page.revision, true);
    revision = page.revision;
    for (const [position, marker] of page.taskParts.entries()) {
      const group = fragments.get(marker.index) ?? { total: marker.total, values: new Map() };
      assert.equal(group.total, marker.total);
      assert.equal(group.values.has(marker.part), false);
      group.values.set(marker.part, page.tasks[position]);
      fragments.set(marker.index, group);
    }
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 128);
  } while (cursor);
  const group = [...fragments.values()].find((entry) =>
    (entry.values.get(0) as { id?: string } | undefined)?.id === taskId);
  assert.ok(group);
  assert.equal(group.values.size, group.total);
  const comments = [...group.values.entries()].sort(([a], [b]) => a - b)
    .flatMap(([, row]) => (row as { comments?: { text: string }[] }).comments ?? []);
  assert.deepEqual(comments.map((row) => row.text), expected.map((row) => row.text));
  assert.ok(pages > 1);
  // task_get is a separate native read and must return full retained history.
  const chunks: string[] = [];
  let taskCursor: string | null = null;
  let taskRevision: string | undefined;
  let taskPages = 0;
  do {
    const part = value(tools.call("task_get", {
      taskId, ...(taskCursor === null ? {} : { cursor: taskCursor }),
    })) as {
      kind: string; revision: string; part: number; total: number;
      chunk: string; nextCursor: string | null;
    };
    assert.equal(part.kind, "task-detail-chunk");
    assert.equal(part.part, taskPages++);
    assert.equal(taskRevision === undefined || taskRevision === part.revision, true);
    taskRevision = part.revision;
    chunks.push(part.chunk);
    taskCursor = part.nextCursor;
    assert.ok(taskPages < 128);
  } while (taskCursor);
  assert.deepEqual(JSON.parse(chunks.join("")), f.user.getTask(taskId));
  const firstPage = value(tools.call("task_get", { taskId })) as { nextCursor: string };
  assert.throws(
    () => createTeamMcpTools(f.user).call("task_get", { taskId, cursor: firstPage.nextCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold",
  );
  f.user.execute({
    commandId: "TEST-extra-comment", operation: "task.comment",
    payload: { taskId, text: "later canonical edit invalidates task_get cursor" },
  });
  assert.throws(
    () => tools.call("task_get", { taskId, cursor: firstPage.nextCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold",
  );
});

test("team_get retains an accepted oversized Unicode task description with signed fragments", (t) => {
  const f = fixture(t);
  const description = "漢".repeat(140_000);
  const taskId = f.user.execute({
    commandId: "TEST-large-task-description",
    operation: "task.create",
    payload: { subject: "Large valid description", description },
  }).effects.taskId;
  const tool = createTeamMcpTools(f.user);
  let cursor: string | null = null;
  let pageCount = 0;
  const chunks = new Map<number, string>();
  do {
    const page = value(tool.call("team_get", cursor ? { cursor } : {})) as {
      tasks: { id: string; description?: string }[];
      taskParts?: { index: number; part: number; total: number }[];
      nextCursor: string | null;
    };
    assert.ok(page.taskParts);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    for (const [position, fragment] of page.tasks.entries()) {
      if (fragment.id !== taskId || fragment.description === undefined) continue;
      const marker = page.taskParts![position];
      assert.ok(marker);
      assert.equal(marker.index, 0);
      assert.equal(chunks.has(marker.part), false);
      chunks.set(marker.part, fragment.description);
    }
    cursor = page.nextCursor;
    assert.ok(++pageCount < 128);
  } while (cursor);
  assert.ok(pageCount > 1);
  assert.equal([...chunks.entries()].sort(([a], [b]) => a - b)
    .map(([, value]) => value).join(""), description);
  assert.equal(f.user.getTask(taskId).description, description);
});

test("team_get pages retained >256 KiB task history within MCP response limits", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 100; index++) {
    f.user.execute({
      commandId: `TEST-page-task-${index}`,
      operation: "task.create",
      payload: {
        subject: `Retained task ${index}`,
        description: `desc-${index}-${"x".repeat(3500)}`,
      },
    });
  }
  const original = f.user.readSnapshot() as { tasks: unknown[]; nextCursor: string | null };
  // The Owner page may itself have a continuation; MCP must remain smaller.
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 256 * 1024);

  const tools = createTeamMcpTools(f.user);
  const first = value(tools.call("team_get", {})) as {
    tasks: { subject: string }[];
    nextCursor: string | null;
  };
  assert.ok(first.nextCursor, "MCP must expose continuation for large original history");
  const all = [...first.tasks];
  let cursor: string | null = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const page = value(tools.call("team_get", { cursor })) as typeof first;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024);
    all.push(...page.tasks);
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages <= 128);
  }
  assert.ok(pages > 1);
  assert.equal(all.length, 100);
  assert.equal(new Set(all.map((task) => task.subject)).size, 100);
  assert.throws(() => tools.call("team_get", { cursor: "invalid" }));
  const other = createTeamMcpTools(f.owner.connect("alice"));
  assert.throws(() => other.call("team_get", { cursor: first.nextCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold");
  f.user.execute({
    commandId: "TEST-later-task",
    operation: "task.create",
    payload: { subject: "later task invalidates original continuation" },
  });
  assert.throws(() => tools.call("team_get", { cursor: first.nextCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold");
});

test("existing MCP create and owner-clear expose canonical payload and exact conjunctive inventory policy", async (t) => {
  const f = fixture(t);
  const tools = createTeamMcpTools(f.user);
  const first = value(
    tools.call("task_create", {
      commandId: "TEST-first",
      subject: "Dependency",
      owner: "bob",
    }),
  ) as { effects: { taskId: string } };
  const secondArgs = {
    commandId: "TEST-second",
    subject: "Related work",
    owner: "alice",
    related: [first.effects.taskId],
    prompt: "Actual prompt",
    promptTaskRefs: [
      {
        taskId: first.effects.taskId,
        displayId: "1",
        teamName: f.binding.teamName,
      },
    ],
    startImmediately: false,
  };
  const second = value(tools.call("task_create", secondArgs)) as {
    effects: { taskId: string };
    phase: string;
  };
  assert.equal(second.phase, "completed");
  const filters = {
    owner: "alice",
    status: "pending" as const,
    reviewState: "none" as const,
    relatedTo: first.effects.taskId,
    limit: 5,
  };
  const rows = value(tools.call("task_list", filters));
  assert.deepEqual(rows, f.policy.reads!.listTaskInventory(filters));
  assert.equal((rows as unknown[]).length, 1);
  assert.deepEqual(value(tools.call("task_create", secondArgs)), second);
  assert.equal(
    (
      value(
        tools.call("task_set_owner", {
          commandId: "TEST-clear",
          taskId: second.effects.taskId,
          owner: null,
        }),
      ) as { phase: string }
    ).phase,
    "completed",
  );
  assert.equal(f.user.getTask(second.effects.taskId).owner, undefined);
});

const require = createRequire(import.meta.url);
const { writeKanbanState } = require("agent-teams-controller/src/internal/kanbanStore.js") as {
  writeKanbanState(paths: Record<string, string>, teamName: string, state: unknown): void;
};

test("kanban_get pages a valid >256 KiB canonical board without losing order or authority", (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 4_800 }, (_, index) => "TEST-board-" + index);
  const tasks = Object.fromEntries(ids.map((id) => [
    id, { column: "approved", movedAt: "2026-11-09T10:00:00.000Z" },
  ]));
  const board = {
    teamName: f.binding.teamName, reviewers: ["alice"],
    tasks, columnOrder: { approved: ids },
  };
  writeKanbanState(createTeamController(f.root, f.binding.teamName).context.paths,
    f.binding.teamName, board);
  const canonical = f.policy.reads!.getKanbanState({ strict: true });
  assert.ok(Buffer.byteLength(JSON.stringify(canonical)) > 256 * 1024);
  const mcp = createTeamMcpTools(f.owner.connect("alice"));
  const combined = { tasks: {} as Record<string, unknown>, columnOrder: [] as string[] };
  let cursor: string | null = null;
  let firstCursor: string | undefined;
  let revision: string | undefined;
  let pages = 0;
  do {
    const page = value(mcp.call("kanban_get", cursor ? { cursor } : {})) as {
      revision: string; nextCursor: string | null;
      tasks: Record<string, unknown>; columnOrder: { approved?: string[] };
    };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
    revision ??= page.revision;
    assert.equal(page.revision, revision);
    Object.assign(combined.tasks, page.tasks);
    combined.columnOrder.push(...(page.columnOrder.approved ?? []));
    if (pages === 0) firstCursor = page.nextCursor ?? undefined;
    cursor = page.nextCursor;
    assert.ok(++pages < 128);
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(combined.tasks, tasks);
  assert.deepEqual(combined.columnOrder, ids);
  assert.throws(
    () => createTeamMcpTools(f.user).call("kanban_get", { cursor: firstCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold",
  );
  writeKanbanState(createTeamController(f.root, f.binding.teamName).context.paths,
    f.binding.teamName, { ...board, reviewers: ["alice", "bob"] });
  assert.throws(
    () => mcp.call("kanban_get", { cursor: firstCursor }),
    (error) => error instanceof TeamOwnerError && error.code === "hold",
  );
});

test(
  "revocation while canonical briefing is awaited refuses the original read without retargeting",
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t, true);
    const tools = createTeamMcpTools(f.owner.connect("alice"));
    const pending = tools.callAsync("task_briefing", {});
    await f.observed;
    f.user.revoke("alice");
    f.release();
    await assert.rejects(
      pending,
      (error) => error instanceof TeamOwnerError && error.code === "forbidden",
    );
    assert.deepEqual(f.commands(), []);
  },
);
