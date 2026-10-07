import type { TeamTemplateV1 } from '../contracts';
import type { TeamCreateConfigRequest } from '@shared/types';

export const TEAM_TEMPLATES: readonly TeamTemplateV1[] = [
  {
    schemaVersion: 1,
    id: 'feature',
    version: 1,
    name: 'Build a feature',
    description: 'Plan, implement and independently review a focused feature.',
    teamPrompt:
      'Coordinate a focused feature delivery. Confirm acceptance and constraints, assign bounded ownership, keep implementation and independent review separate, and report verified behavior and remaining risks. Do not broaden scope without agreement.',
    members: [
      {
        name: 'planner',
        role: 'Architect',
        workflow:
          'Explore the existing architecture. Clarify acceptance and propose the smallest coherent implementation with edge cases and verification.',
      },
      {
        name: 'builder',
        role: 'Developer',
        workflow:
          'Implement the accepted scope. Respect ownership, preserve unrelated changes, and verify observable behavior.',
      },
      {
        name: 'reviewer',
        role: 'Reviewer',
        workflow:
          'Independently review the final change for correctness, security, regressions and acceptance. Report actionable findings with evidence.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'bug',
    version: 1,
    name: 'Fix a bug',
    description: 'Reproduce, repair and verify a concrete regression.',
    teamPrompt:
      'Coordinate a bug fix. Establish the observed failure and expected behavior, identify its cause, assign a bounded repair, and independently verify the regression and nearby risks. Report evidence rather than assumptions.',
    members: [
      {
        name: 'investigator',
        role: 'Researcher',
        workflow:
          'Reproduce the failure safely. Trace the cause and identify a focused regression check that fails on the old behavior.',
      },
      {
        name: 'fixer',
        role: 'Developer',
        workflow:
          'Repair the confirmed cause with a minimal coherent change. Preserve surrounding behavior and run the focused regression check.',
      },
      {
        name: 'verifier',
        role: 'Reviewer',
        workflow:
          'Independently verify the fix against the original failure and likely neighboring regressions.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'review',
    version: 1,
    name: 'Review code',
    description: 'Independent correctness and security review without automatic edits.',
    teamPrompt:
      'Coordinate an evidence-backed review. Agree on the change and base being reviewed, split correctness and security concerns, reconcile overlapping findings, and present only actionable defects with severity, location and impact. Do not modify code unless requested.',
    members: [
      {
        name: 'correctness',
        role: 'Reviewer',
        workflow:
          'Review behavior, edge cases, lifecycle and compatibility. Validate each finding against the actual code and tests.',
      },
      {
        name: 'security',
        role: 'Security reviewer',
        workflow:
          'Review trust boundaries, input validation, permissions and data exposure. Explain a plausible failure or exploit for each finding.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'research',
    version: 1,
    name: 'Research a solution',
    description: 'Investigate evidence and compare practical options before coding.',
    teamPrompt:
      'Coordinate research before implementation. Define the question and decision criteria, collect current primary evidence and repository constraints, compare practical options, and report a recommendation with uncertainty and next verification steps. Do not implement unless requested.',
    members: [
      {
        name: 'researcher',
        role: 'Researcher',
        workflow:
          'Gather relevant current primary sources and concrete repository evidence. Distinguish facts from inference and cite supporting sources.',
      },
      {
        name: 'critic',
        role: 'Architect',
        workflow:
          'Challenge assumptions, compare options against constraints, identify gaps and recommend the smallest reliable solution.',
      },
    ],
  },
];

/** Each application produces an independent editable copy without runtime settings. */
export function applyTeamTemplate(
  template: TeamTemplateV1
): Pick<
  TeamCreateConfigRequest,
  'runtimeSelectionVersion' | 'description' | 'prompt' | 'members' | 'syncModelsWithLead'
> {
  return {
    runtimeSelectionVersion: 1,
    description: template.description,
    prompt: template.teamPrompt,
    members: template.members.map((member) => ({ ...member })),
    syncModelsWithLead: true,
  };
}
