# Team templates

Thin browser-safe feature: `contracts` owns `TeamTemplateV1`; `core` supplies eight static team compositions and pure draft application; `renderer` exposes the template and unresolved-provider selectors.

The catalogue covers software products, marketing, content, research, sales, customer support, operations and learning. Each has two or three essential teammates; the existing team lead coordinates through `teamPrompt`. Do not duplicate the lead in `members`. The reference view, external-agent prompt and manual picker share this catalogue.

Applying a template copies roles, workflows and lead coordination into the existing team editor. The existing team configuration API saves the editable draft. Runtime selection is explicit (`runtimeSelectionVersion: 1`); templates contain no provider, model, workspace or launch flags.
