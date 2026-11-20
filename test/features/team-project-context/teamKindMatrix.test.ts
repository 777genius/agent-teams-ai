import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyDefinitionTarget as classifyTeamKind,
  createTeamTargetPorts,
  projectTeamSummaries,
  resolveTeamTarget,
  TeamProjectContextRegistry,
  TeamProjectContextRuntimeResolver,
} from '../../../src/features/team-project-context/main';
import { stopLogicalTeam } from '../../../src/main/ipc/teams/teamContextLifecycle';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';
import type { TeamSummary } from '../../../src/shared/types/team';

/**
 * Behaviour matrix of "what kind of team is this name" over the same on-disk
 * states, through every consumer that classifies a name. It pins what the
 * consumers answer today (including what they refuse on unreadable state) so a
 * consolidation of the classification code cannot change an answer unnoticed.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Mode = 'shared' | 'per_project';

interface Spec {
  name: string;
  /** What the metadata store returns; 'unreadable' = file exists but cannot be parsed. */
  meta: Mode | 'none' | 'unreadable';
  /** Project contexts to materialize through the real registry. */
  contexts: ('ready' | 'reserved')[];
}

const SPECS: Spec[] = [
  { name: 'plain', meta: 'shared', contexts: [] },
  { name: 'nometa', meta: 'none', contexts: [] },
  { name: 'builders', meta: 'per_project', contexts: ['ready', 'reserved'] },
  { name: 'builders-empty', meta: 'per_project', contexts: [] },
  { name: 'retained', meta: 'shared', contexts: ['ready'] },
  { name: 'unread-noindex', meta: 'unreadable', contexts: [] },
  { name: 'unread-index', meta: 'unreadable', contexts: ['ready'] },
];

async function world() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-kind-matrix-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const workspace = path.join(root, 'ws');
  await Promise.all([mkdir(teamsBasePath, { recursive: true }), mkdir(tasksBasePath, { recursive: true })]);
  const registry = new TeamProjectContextRegistry({
    teamsBasePath, tasksBasePath, profileScope: 'matrix-profile',
  });
  const claim = (teamName: string) =>
    claimTeamForThisProfile({ teamsBasePath, teamName, reason: 'create', profileScope: 'matrix-profile' });
  const metas = new Map<string, Spec['meta']>();
  const labels = new Map<string, string>();
  for (const spec of SPECS) {
    metas.set(spec.name, spec.meta);
    await mkdir(path.join(teamsBasePath, spec.name), { recursive: true });
    await claim(spec.name);
    for (const [index, state] of spec.contexts.entries()) {
      const project = path.join(workspace, `${spec.name}-${index}`);
      await mkdir(project, { recursive: true });
      const reserved = await registry.reserve(spec.name, project);
      labels.set(reserved.executionTeamName, `<${spec.name}#${index}>`);
      labels.set(reserved.id, `<id:${spec.name}#${index}>`);
      if (state === 'ready') {
        await mkdir(path.join(teamsBasePath, reserved.executionTeamName), { recursive: true });
        await mkdir(path.join(tasksBasePath, reserved.executionTeamName), { recursive: true });
        await writeFile(
          path.join(teamsBasePath, reserved.executionTeamName, 'config.json'),
          JSON.stringify({ name: reserved.executionTeamName })
        );
        await claim(reserved.executionTeamName);
        await registry.confirmReady(spec.name, project, reserved.executionTeamName);
      }
    }
  }
  // An alias-looking directory that no index owns.
  await mkdir(path.join(teamsBasePath, 'ptc-aaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
  await claim('ptc-aaaaaaaaaaaaaaaaaaaaaaaa');
  labels.set(root, '<root>');
  labels.set(await realpath(root), '<root>');
  const meta = {
    getMeta: async (name: string): Promise<TeamMetaFile | null> => {
      const kind = metas.get(name);
      if (kind === 'shared' || kind === 'per_project') {
        return { version: 1, cwd: '/x', createdAt: 1, projectContextMode: kind };
      }
      return null;
    },
    metadataFileExists: async (name: string) => metas.get(name) === 'unreadable',
  };
  return { registry, meta, labels, root, tasksBasePath };
}

type World = Awaited<ReturnType<typeof world>>;

/** Stable text of an answer: aliases, ids and paths replaced by labels. */
function render(w: World, value: unknown): unknown {
  let text = JSON.stringify(value);
  for (const [raw, label] of [...w.labels].sort((a, b) => b[0].length - a[0].length)) {
    text = text.split(raw).join(label);
  }
  return JSON.parse(text);
}

async function outcome(w: World, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return render(w, { ok: await run() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return render(w, { throws: message });
  }
}

const NAMES = [...SPECS.map((spec) => spec.name), 'ptc-aaaaaaaaaaaaaaaaaaaaaaaa'];

async function aliasOf(w: World, logical: string, index: number): Promise<string> {
  for (const [raw, label] of w.labels) if (label === `<${logical}#${index}>`) return raw;
  throw new Error('no alias');
}

describe('team kind matrix (characterization)', () => {
  it('classifyTeamKind: edit / schedule / launch kind of every name', async () => {
    const w = await world();
    const resolver = new TeamProjectContextRuntimeResolver(w.meta, w.registry);
    const ownedAlias = await aliasOf(w, 'builders', 0);
    const rows: Record<string, unknown> = {};
    for (const name of [...NAMES, ownedAlias]) {
      rows[render(w, name) as string] = await outcome(w, () =>
        classifyTeamKind(
          {
            getMode: (n) => resolver.getMode(n),
            isOwnedExecutionAlias: (n) => w.registry.isOwnedExecutionAlias(n),
          },
          name
        )
      );
    }
    expect(rows).toMatchInlineSnapshot(`
      {
        "<builders#0>": {
          "ok": "alias",
        },
        "builders": {
          "ok": "logical",
        },
        "builders-empty": {
          "ok": "logical",
        },
        "nometa": {
          "ok": "native",
        },
        "plain": {
          "ok": "native",
        },
        "ptc-aaaaaaaaaaaaaaaaaaaaaaaa": {
          "ok": "native",
        },
        "retained": {
          "ok": "native",
        },
        "unread-index": {
          "throws": "Team metadata is unreadable; refusing shared-history fallback",
        },
        "unread-noindex": {
          "throws": "Team metadata is unreadable; refusing shared-history fallback",
        },
      }
    `);
  });

  it('resolveTeamTarget: HTTP stop / runtime / list target of every name', async () => {
    const w = await world();
    const ports = createTeamTargetPorts(w.meta, w.registry);
    const ownedAlias = await aliasOf(w, 'builders', 0);
    const rows: Record<string, unknown> = {};
    for (const name of [...NAMES, ownedAlias]) {
      rows[render(w, name) as string] = await outcome(w, () => resolveTeamTarget(ports, name));
    }
    expect(rows).toMatchInlineSnapshot(`
      {
        "<builders#0>": {
          "ok": {
            "kind": "native",
            "retained": [],
            "team": "<builders#0>",
          },
        },
        "builders": {
          "ok": {
            "contexts": [
              {
                "executionTeamName": "<builders#0>",
                "id": "<id:builders#0>",
                "projectKey": "<root>/ws/builders-0",
                "projectPath": "<root>/ws/builders-0",
                "state": "ready",
              },
              {
                "executionTeamName": "<builders#1>",
                "id": "<id:builders#1>",
                "projectKey": "<root>/ws/builders-1",
                "projectPath": "<root>/ws/builders-1",
                "state": "reserved",
              },
            ],
            "kind": "logical",
            "logical": "builders",
          },
        },
        "builders-empty": {
          "ok": {
            "contexts": [],
            "kind": "logical",
            "logical": "builders-empty",
          },
        },
        "nometa": {
          "ok": {
            "kind": "native",
            "retained": [],
            "team": "nometa",
          },
        },
        "plain": {
          "ok": {
            "kind": "native",
            "retained": [],
            "team": "plain",
          },
        },
        "ptc-aaaaaaaaaaaaaaaaaaaaaaaa": {
          "ok": {
            "kind": "native",
            "retained": [],
            "team": "ptc-aaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
        "retained": {
          "ok": {
            "kind": "native",
            "retained": [
              {
                "executionTeamName": "<retained#0>",
                "id": "<id:retained#0>",
                "projectKey": "<root>/ws/retained-0",
                "projectPath": "<root>/ws/retained-0",
                "state": "ready",
              },
            ],
            "team": "retained",
          },
        },
        "unread-index": {
          "throws": "Cannot resolve the project contexts of team "unread-index": Team metadata is unreadable; refusing shared-history fallback",
        },
        "unread-noindex": {
          "ok": {
            "kind": "native",
            "projectContextUnresolved": true,
            "retained": [],
            "team": "unread-noindex",
          },
        },
      }
    `);
  });

  it('stopLogicalTeam: which runtimes a desktop stop touches for every name', async () => {
    const w = await world();
    const rows: Record<string, unknown> = {};
    for (const name of NAMES) {
      const stopped: string[] = [];
      rows[name] = await outcome(w, async () => {
        const result = await stopLogicalTeam(
          name,
          async (team) => {
            stopped.push(team);
            return { success: true, data: undefined };
          },
          w.meta,
          w.registry
        );
        return { result, stopped };
      });
    }
    expect(rows).toMatchInlineSnapshot(`
      {
        "builders": {
          "ok": {
            "result": {
              "error": "ENOENT: no such file or directory, lstat '<root>/teams/<builders#1>'",
              "success": false,
            },
            "stopped": [],
          },
        },
        "builders-empty": {
          "ok": {
            "result": {
              "success": true,
            },
            "stopped": [
              "builders-empty",
            ],
          },
        },
        "nometa": {
          "ok": {
            "result": {
              "success": true,
            },
            "stopped": [
              "nometa",
            ],
          },
        },
        "plain": {
          "ok": {
            "result": {
              "success": true,
            },
            "stopped": [
              "plain",
            ],
          },
        },
        "ptc-aaaaaaaaaaaaaaaaaaaaaaaa": {
          "ok": {
            "result": {
              "success": true,
            },
            "stopped": [
              "ptc-aaaaaaaaaaaaaaaaaaaaaaaa",
            ],
          },
        },
        "retained": {
          "ok": {
            "result": {
              "success": true,
            },
            "stopped": [
              "<retained#0>",
              "retained",
            ],
          },
        },
        "unread-index": {
          "ok": {
            "result": {
              "error": "Team metadata is unreadable; refusing shared-history fallback",
              "success": false,
            },
            "stopped": [],
          },
        },
        "unread-noindex": {
          "ok": {
            "result": {
              "error": "Team metadata is unreadable; refusing shared-history fallback",
              "success": false,
            },
            "stopped": [],
          },
        },
      }
    `);
  });

  it('projectTeamSummaries: which rows the team list shows and folds for every name', async () => {
    const w = await world();
    const aliases = [...w.labels.keys()].filter((key) => key.startsWith('ptc-'));
    const summary = (teamName: string): TeamSummary => ({
      teamName, displayName: teamName, description: '', memberCount: 1, taskCount: 1, lastActivity: null,
    });
    const teams = [...NAMES, ...aliases].map(summary);
    const visible = await projectTeamSummaries(teams, w.meta, w.registry);
    expect(
      render(w, visible.map((team) => ({
        name: team.teamName,
        mode: team.projectContextMode ?? null,
        folded: team.projectHistoryContexts?.map((c) => c.executionTeamName) ?? null,
        tasks: team.taskCount,
      })))
    ).toMatchInlineSnapshot(`
      [
        {
          "folded": null,
          "mode": "shared",
          "name": "plain",
          "tasks": 1,
        },
        {
          "folded": null,
          "mode": null,
          "name": "nometa",
          "tasks": 1,
        },
        {
          "folded": [
            "<builders#0>",
          ],
          "mode": "per_project",
          "name": "builders",
          "tasks": 2,
        },
        {
          "folded": null,
          "mode": "per_project",
          "name": "builders-empty",
          "tasks": 1,
        },
        {
          "folded": [
            "<retained#0>",
          ],
          "mode": "shared",
          "name": "retained",
          "tasks": 2,
        },
        {
          "folded": null,
          "mode": null,
          "name": "unread-noindex",
          "tasks": 1,
        },
        {
          "folded": null,
          "mode": null,
          "name": "unread-index",
          "tasks": 1,
        },
        {
          "folded": null,
          "mode": null,
          "name": "ptc-aaaaaaaaaaaaaaaaaaaaaaaa",
          "tasks": 1,
        },
        {
          "folded": null,
          "mode": null,
          "name": "<builders#1>",
          "tasks": 1,
        },
        {
          "folded": null,
          "mode": null,
          "name": "<unread-index#0>",
          "tasks": 1,
        },
      ]
    `);
  });
});
