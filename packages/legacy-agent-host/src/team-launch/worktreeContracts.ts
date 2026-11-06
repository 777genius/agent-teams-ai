import { TeamLaunchError } from './contracts.js';

/** Private launch capture facts. Persist the plan in definition.capture before any Git effect. */
export interface WorktreePathIdentity {
  path: string;
  device: number;
  inode: number;
}
export interface WorktreeProof {
  head: string;
  dirtyDigest: string;
}
export interface WorktreeGitStatus {
  projectPath: string;
  isGitRepo: boolean;
  hasHead: boolean;
  canUseWorktrees: boolean;
  rootPath?: string;
  branch?: string;
  reason?:
    | 'invalid_project_path'
    | 'not_git_repo'
    | 'missing_head'
    | 'git_unavailable'
    | 'git_error';
  message?: string;
}
export interface OwnedWorktreeBinding {
  slotId: string;
  target: WorktreePathIdentity;
  commonDirectory: WorktreePathIdentity;
  branch: string;
  createdCommit: string;
}
export interface LaunchWorktreePlan {
  version: 1;
  slotId: string;
  repository: WorktreePathIdentity;
  commonDirectory: WorktreePathIdentity;
  targetPath: string;
  branch: string;
  capturedCommit: string;
  /** Reuse is admissible only from an existing completed owned launch record. */
  reuse?: OwnedWorktreeBinding | undefined;
  proof: WorktreeProof;
}
/** Stored only inside the original TeamLaunchRecord, alongside its immutable capture plan. */
export interface LaunchWorktreeReceipt {
  planDigest: string;
  state: 'reserved' | 'attempted' | 'completed';
  target: WorktreePathIdentity;
  binding?: OwnedWorktreeBinding | undefined;
}
export interface LaunchWorktreePort {
  digest(plan: LaunchWorktreePlan): string;
  reserve(plan: LaunchWorktreePlan): WorktreePathIdentity;
  inspect(plan: LaunchWorktreePlan, binding: OwnedWorktreeBinding): Promise<WorktreeProof>;
  create(
    plan: LaunchWorktreePlan,
    target: WorktreePathIdentity,
    assertCurrent: () => void
  ): Promise<OwnedWorktreeBinding>;
}
export interface LaunchWorktreeCapturePort {
  /** These callbacks use the existing Team/launch fence and record writer, never a second journal. */
  read(): { plan: LaunchWorktreePlan; receipt?: LaunchWorktreeReceipt };
  /** Compare the expected previous receipt inside that same fence; reject concurrent transitions. */
  write(receipt: LaunchWorktreeReceipt, expected?: LaunchWorktreeReceipt): void;
  assertCurrent(): void;
}
export class LaunchWorktreeError extends TeamLaunchError {
  constructor(reason: string) {
    super('hold', reason);
    this.message = `Worktree launch hold: ${reason}`;
  }
}
