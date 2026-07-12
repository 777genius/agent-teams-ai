import { inspectTeamFolder } from '../src/main/services/team/TeamImportService';

async function main(): Promise<void> {
  const folder = process.argv[2] ?? '/Users/chenzibo/data/project/my_creation_studio/wechat-agent-team';
  const preview = await inspectTeamFolder(folder);
  console.log('=== Team Import Preview ===');
  console.log('teamName:', preview.teamName);
  console.log('projectPath:', preview.projectPath);
  console.log('members:', preview.members.map((m) => m.name));
  console.log('skillsFound:', preview.skillsFound);
  console.log('warnings:', preview.warnings);
  console.log('--- lead prompt (first 1000 chars) ---');
  console.log(preview.prompt?.slice(0, 1000));
  console.log('--- lead prompt checks ---');
  console.log('has task_create:', preview.prompt?.includes('task_create'));
  console.log('has Task( :', preview.prompt?.includes('Task('));
  console.log('has "用 Task 工具派发":', preview.prompt?.includes('用 Task 工具派发'));
  console.log('has $(date:', preview.prompt?.includes('$(date'));
  console.log('--- member workflow checks (topic-collector) ---');
  const tc = preview.members.find((m) => m.name === 'topic-collector');
  console.log('has task_start:', tc?.workflow.includes('task_start'));
  console.log('has task_add_comment:', tc?.workflow.includes('task_add_comment'));
  console.log('has Skill tool:', tc?.workflow.includes('Skill tool'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
