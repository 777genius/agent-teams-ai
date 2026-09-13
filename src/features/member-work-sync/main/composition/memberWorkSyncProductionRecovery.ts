/**
 * Qualified D0 stays on. Protocol 2 is declared so early continuation can
 * run only when a ticket port admits; the desktop default port returns
 * `not_early` until the runtime advertises ticket/generation admission.
 */
export const MEMBER_WORK_SYNC_PRODUCTION_RECOVERY = {
  recoveryAllocation: { enabled: true },
  recoveryProtocol: { version: 2 },
} as const;
