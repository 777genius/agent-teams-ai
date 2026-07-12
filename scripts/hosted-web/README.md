# Hosted-web scripts

Hosted-web scripts are evidence producers, validators, and test probes. They are not general-purpose
permission to run agent teams or runtime smoke against a user project. All live behavior must use a
new sandbox/test project or an explicitly test-only existing project.

Existing phase scripts and their outputs are retained as agent evidence. Do not delete, move,
truncate, or rewrite them while organizing newer evidence. Record authority, hashes, regeneration,
review disposition, and supersession under
`docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`.

Hosted-worker orchestration is not implemented in this repository. Admission and launch use
subscription-runtime's builtin `worker-start-v1` boundary; scripts retained here are product evidence
producers and probes only.
