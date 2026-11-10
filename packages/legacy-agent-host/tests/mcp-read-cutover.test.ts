import assert from "node:assert/strict";
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
import { createTeamPolicy } from "../dist/adapters/team/ControllerAdapter.js";
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
