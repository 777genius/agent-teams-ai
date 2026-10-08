export interface TeamTemplateV1 {
  schemaVersion: 1;
  id:
    | 'software-product'
    | 'marketing'
    | 'content'
    | 'research'
    | 'sales'
    | 'customer-support'
    | 'operations'
    | 'learning';
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
