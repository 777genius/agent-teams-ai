import * as path from 'path';

interface AgentTeamsMcpValidationFixture {
  claudeDir: string;
  teamName: string;
  memberName: string;
}

interface McpValidationFixturePorts {
  makeTempDir(prefix: string): Promise<string>;
  tmpdir(): string;
  mkdirRecursive(directoryPath: string): Promise<void>;
  writeFileUtf8(filePath: string, contents: string): Promise<void>;
}

export async function createAgentTeamsMcpValidationFixture({
  projectPath,
  ports,
}: {
  projectPath: string;
  ports: McpValidationFixturePorts;
}): Promise<AgentTeamsMcpValidationFixture> {
  const claudeDir = await ports.makeTempDir(path.join(ports.tmpdir(), 'agent-teams-mcp-validate-'));
  const teamName = 'mcp-validation-team';
  const memberName = 'mcp-validation-member';
  const teamDir = path.join(claudeDir, 'teams', teamName);

  await ports.mkdirRecursive(teamDir);
  await ports.writeFileUtf8(
    path.join(teamDir, 'config.json'),
    JSON.stringify(
      {
        name: teamName,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
          { name: memberName, agentType: 'teammate', role: 'developer' },
        ],
      },
      null,
      2
    )
  );

  return { claudeDir, teamName, memberName };
}
