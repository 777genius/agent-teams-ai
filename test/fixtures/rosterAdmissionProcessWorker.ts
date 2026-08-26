import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamRosterAuthorizationTransactionService } from '@main/services/team/TeamRosterAuthorizationTransactionService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

const [root, teamName, transactionId] = process.argv.slice(2);

if (!root || !teamName || !transactionId) {
  process.stderr.write('missing worker arguments\n');
  process.exitCode = 2;
} else {
  setClaudeBasePathOverride(root);
  const store = new TeamMembersMetaStore();
  const transactions = new TeamRosterAuthorizationTransactionService(store);
  try {
    const outcome = await transactions.begin(
      teamName,
      transactionId,
      'process-roster-request',
      async () => store.serializeMembers([{ name: 'alice' }]),
      'process-exact-admission'
    );
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    setClaudeBasePathOverride(null);
  }
}
