export interface TeamTemplateV1 {
  schemaVersion: 1;
  id: 'feature' | 'bug' | 'review' | 'research';
  version: 1;
  name: string;
  description: string;
  teamPrompt: string;
  members: readonly {
    name: string;
    role: string;
    workflow: string;
    isolation?: 'worktree';
  }[];
}
