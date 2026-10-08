import type { TeamTemplateV1 } from '../contracts';
import type { TeamCreateConfigRequest } from '@shared/types';

export const TEAM_TEMPLATES: readonly TeamTemplateV1[] = [
  {
    schemaVersion: 1,
    id: 'software-product',
    version: 1,
    name: 'Software Product Team',
    description: 'Design, build and validate apps, websites and digital products.',
    teamPrompt:
      'Coordinate a small software product team. Clarify the user problem, scope and acceptance criteria, connect design with implementation, and arrange independent validation. Keep ownership clear and report working outcomes, evidence and remaining risks.',
    members: [
      {
        name: 'designer',
        role: 'Product Designer',
        workflow:
          'Turn user needs into clear flows, interface proposals and acceptance criteria. Check the existing product and discuss feasibility with the engineer.',
      },
      {
        name: 'engineer',
        role: 'Software Engineer',
        workflow:
          'Build the agreed product using existing patterns. Respect ownership, preserve unrelated changes and verify working behavior.',
      },
      {
        name: 'qa',
        role: 'QA Engineer',
        workflow:
          'Independently check user journeys, edge cases and regressions against the agreed acceptance criteria. Report reproducible defects and verification gaps.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'marketing',
    version: 1,
    name: 'Marketing Team',
    description: 'Develop campaigns and messaging for a product or small business.',
    teamPrompt:
      'Coordinate a marketing team around the business goal and audience. Connect positioning, campaign copy and measurement, keep deliverables consistent across channels, and report recommendations with supporting evidence and assumptions.',
    members: [
      {
        name: 'strategist',
        role: 'Marketing Strategist',
        workflow:
          'Define the audience, positioning, campaign channels and measurable goals. Use market evidence to turn the business brief into a focused campaign plan.',
      },
      {
        name: 'copywriter',
        role: 'Copywriter',
        workflow:
          'Create campaign copy and messaging for the agreed audience and channels. Keep claims accurate, voice consistent and calls to action clear.',
      },
      {
        name: 'analyst',
        role: 'Marketing Analyst',
        workflow:
          'Examine available market and performance data, challenge campaign assumptions and recommend improvements. Separate measured results from forecasts and identify missing evidence.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'content',
    version: 1,
    name: 'Content Studio',
    description: 'Create clear articles, newsletters, educational content and scripts.',
    teamPrompt:
      'Coordinate a content studio. Clarify the audience, purpose, format and voice, connect research with writing and editing, and deliver a coherent finished draft with supported claims and any unresolved questions.',
    members: [
      {
        name: 'researcher',
        role: 'Researcher',
        workflow:
          'Collect relevant sources and verify factual claims for the content brief. Give the writer useful findings, source references and any uncertainty.',
      },
      {
        name: 'writer',
        role: 'Writer',
        workflow:
          'Turn the brief and research into clear content for the intended audience and format. Keep the agreed voice and link factual claims to supporting sources.',
      },
      {
        name: 'editor',
        role: 'Editor',
        workflow:
          'Improve structure, clarity and consistency. Check claims against the supplied sources, flag gaps and refine the draft without changing its intended meaning.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'research',
    version: 1,
    name: 'Research Team',
    description: 'Investigate markets, topics and practical decisions using evidence.',
    teamPrompt:
      'Coordinate a research team. Define the question, scope and decision criteria, connect source gathering with analysis, and present useful findings and recommendations with citations, uncertainty and next verification steps.',
    members: [
      {
        name: 'researcher',
        role: 'Researcher',
        workflow:
          'Gather relevant sources and data, recording provenance and uncertainty. Check source quality and distinguish established facts from unsupported claims.',
      },
      {
        name: 'analyst',
        role: 'Analyst',
        workflow:
          'Compare the collected evidence against the research question and decision criteria. Challenge assumptions and produce findings and practical recommendations, explaining limitations.',
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
