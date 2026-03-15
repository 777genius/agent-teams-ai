export const STEP_ORDER = ['validating', 'spawning', 'monitoring', 'verifying', 'ready'] as const;
export type ProvisioningStep = (typeof STEP_ORDER)[number];
export const STEP_LABELS: Record<ProvisioningStep, string> = {
  validating: 'Validate',
  spawning: 'Start CLI',
  monitoring: 'Provisioning',
  verifying: 'Verify',
  ready: 'Ready',
};
