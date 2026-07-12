import { AgentProvider } from "../domain/enums";
import type { AccountSlot } from "../domain/model";

export type ObservationStep =
  | "auth"
  | "quota_snapshot"
  | "exec_probe_fallback";

export class AccountObservationPlanner {
  plan(account: AccountSlot): readonly ObservationStep[] {
    switch (account.provider) {
      case AgentProvider.Codex:
        return ["auth", "quota_snapshot", "exec_probe_fallback"];
      case AgentProvider.ClaudeCode:
        return ["auth", "quota_snapshot"];
    }
  }
}
