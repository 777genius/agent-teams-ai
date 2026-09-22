# Hosted-worker orchestration responsibility boundary

Hosted-worker admission, work identity, retries, registry state, and process launch are owned by
`hosting/subscription-runtime`, not by the Agent Teams product repository. Hosting controllers must
use subscription-runtime's builtin `worker-start-v1` boundary.

This repository retains product architecture, controller and lane packets, the execution DAG, and
frozen evidence. It does not implement, generate, validate, test, or execute hosted-worker
orchestration.
