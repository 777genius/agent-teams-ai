import { FastMCP } from 'fastmcp';
import { TeamctlRunner } from './teamctl-runner.js';
import { registerAllTools } from './tools/index.js';

const server = new FastMCP({
  name: 'claude-team-tools',
  version: '1.0.0',
  instructions: `MCP server for managing Claude Agent Teams kanban board and tasks.

Provides 13 tools for task CRUD, kanban board management, code reviews, and team messaging.
All operations are backed by teamctl.js — the battle-tested CLI tool from Claude Agent Teams UI.

Data is stored as JSON files in ~/.claude/tasks/{teamName}/ and ~/.claude/teams/{teamName}/.`,
});

const runner = new TeamctlRunner();

registerAllTools(server, runner);

server.start({ transportType: 'stdio' });
