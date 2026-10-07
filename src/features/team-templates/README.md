# Team templates

Thin browser-safe feature: `contracts` owns `TeamTemplateV1`; `core` supplies four static team compositions and pure draft application; `renderer` exposes the template and unresolved-provider selectors.

Applying a template copies roles, workflows and lead coordination into the existing team editor. The existing team configuration API saves the editable draft. Runtime selection is explicit (`runtimeSelectionVersion: 1`); templates contain no provider, model, workspace or launch flags.
