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
  {
    schemaVersion: 1,
    id: 'sales',
    version: 1,
    name: 'Sales Team',
    description: 'Understand customer needs and prepare offers, outreach and follow-ups.',
    teamPrompt:
      'Coordinate a sales team around the offer and intended customers. Connect customer research with useful proposals and outreach drafts. Keep claims and pricing grounded in supplied facts, and present next steps for user approval before contacting customers or making commitments.',
    members: [
      {
        name: 'sales-specialist',
        role: 'Sales Specialist',
        workflow:
          'Turn customer needs into clear offers, outreach drafts and follow-up plans. Address objections using verified product details and flag pricing or commitments that need approval.',
      },
      {
        name: 'customer-researcher',
        role: 'Customer Researcher',
        workflow:
          'Identify relevant customer segments, needs and buying criteria from available evidence. Give the sales specialist useful insights and distinguish confirmed facts from assumptions.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'customer-support',
    version: 1,
    name: 'Customer Support Team',
    description: 'Resolve customer questions and turn recurring issues into useful help content.',
    teamPrompt:
      'Coordinate a customer support team. Clarify each issue, connect accurate response drafts with reusable help content, and identify unresolved cases for escalation. Protect customer information and use supplied policies without inventing promises, refunds or account actions.',
    members: [
      {
        name: 'support-specialist',
        role: 'Support Specialist',
        workflow:
          'Diagnose customer questions from the supplied context and draft clear, empathetic replies. Use documented policies, request missing details and escalate unresolved or sensitive cases.',
      },
      {
        name: 'knowledge-writer',
        role: 'Knowledge Writer',
        workflow:
          'Turn verified resolutions and recurring questions into concise FAQs, troubleshooting steps and help articles. Remove personal details and flag outdated guidance or missing policy.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'operations',
    version: 1,
    name: 'Operations Team',
    description:
      'Organize projects and everyday work with practical plans and process improvements.',
    teamPrompt:
      'Coordinate an operations team around a practical goal, deadline and available resources. Connect a clear plan with process analysis, assign ownership and dependencies, and deliver actionable checklists with risks and decisions that need user input.',
    members: [
      {
        name: 'process-planner',
        role: 'Process Planner',
        workflow:
          'Turn the goal into manageable steps, owners, dependencies and realistic milestones. Produce practical schedules or checklists and adapt the plan to resource limits.',
      },
      {
        name: 'operations-analyst',
        role: 'Operations Analyst',
        workflow:
          'Review the current process and available data for bottlenecks, handoff gaps and avoidable work. Recommend simple improvements and explain tradeoffs, evidence and missing information.',
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'learning',
    version: 1,
    name: 'Learning Team',
    description: 'Learn a topic or skill through clear explanations, practice and feedback.',
    teamPrompt:
      "Coordinate a learning team around the learner's goal, starting level and available time. Connect short explanations with targeted practice and feedback, adjust the pace using demonstrated understanding, and track progress without claiming mastery before it is shown.",
    members: [
      {
        name: 'tutor',
        role: 'Tutor',
        workflow:
          "Explain concepts in small steps with relevant examples. Check understanding, address misconceptions and adapt explanations to the learner's level and goal.",
      },
      {
        name: 'practice-coach',
        role: 'Practice Coach',
        workflow:
          'Create focused exercises and practical challenges based on the learning goal. Give hints before answers, review attempts with specific feedback and recommend what to practice next.',
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
