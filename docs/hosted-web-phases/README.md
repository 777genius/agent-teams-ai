# Hosted-web execution packets

The current candidate is the [Phase 2 JIT packet](phase-02/README.md). It is documentation authority
only. Phase 2 product work remains blocked until an independent root review accepts the exact router
and the broker integrates and activates the reviewed bytes.

Start with [START_HERE.md](START_HERE.md) and use
[EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the machine-readable authority. The frozen
[Phase 1 packet](phase-01/README.md) is historical predecessor material.

## Ownership boundary

This repository owns product architecture, controller and lane packets, execution DAGs and frozen
evidence. The subscription runtime owns only execution, materialization, admission, evidence and
integration primitives. It does not choose DAG order, capacity, dependencies, reviewers, retries or
successors; those orchestration decisions remain in controller documents.

## Phase 2 shape

The candidate DAG has one short serial product-source identity foundation. Only after that node is
accepted and integrated may exactly five disjoint product lanes A-E run. The lanes own no barrel,
index or composition file. Producers self-review; separate reviewers are used only for architecture,
security, integration and milestone decisions. Documentation, research and evidence work never counts
as product capacity.

Every node ends in `HOLD`. This router neither launches product work nor claims review, integration,
push, product behavior or milestone acceptance.
