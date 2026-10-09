// Closed reviewed Windows E14 executor; complete records include all ancestor trees.
// Original E10 plan, application and release payloads remain unchanged.
export const RELEASE220_WINDOWS_RESUME_EXECUTION = {
  repository: '777genius/agent-teams-ai',
  base: 'a0a8c4d895cfcbe3c790507fe9938b02e4464706',
  head: '16735a2080027972b69fbaa60043a8d92580d048',
  baseTree: '10161f3b743d2d2835c4327db40c719522743fa8',
  tree: 'cb267995755ce02414a4931ad6f2cfc1d79c09db',
  baseRecords: 'd17b72d441f412f846d6e484def89679b4bfec799a627250692d1f20cf70ebdd',
  records: '9453dc3e23b688b3ef95ecbfdc94afcc692583656f41667ad3f67b358ce5836c',
  delta: '070996eb429f832eb9167838f3acfc7111221cceaf2720e5d36af2852bebdb49',
  preparation: 'Authenticate the closed original P10 resume sources without downloading payloads',
  custodyUpload: 'Preserve original resume source custody without relabeling its producer',
  retrieval:
    'Authenticate and hash exact original input and successful fresh ZIPs before named extraction',
} as const;
