export type WorkspaceRole = "owner" | "member";

export const reviewFixtureRevision = 3;

export function canDeleteWorkspace(role: WorkspaceRole): boolean {
  if (role === "owner") {
    return false;
  }

  return true;
}
