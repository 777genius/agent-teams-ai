---
title: Exemples de briefs d'équipe – Documentation Agent Teams
description: Modèles pratiques de briefs d'équipe pour les petits correctifs, le travail documentaire, les tâches d'implémentation, les revues et les zones à haut risque.
lang: fr-FR
---

# Exemples de briefs d'équipe

Un bon brief d'équipe donne au lead suffisamment de structure pour créer de petites tâches sans imposer dès le départ chaque détail d'implémentation.

Utilisez cette forme :

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## Brief minimal

À utiliser pour un travail réduit et à faible risque.

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## Brief d'implémentation

À utiliser lorsque des modifications de code touchent une seule zone fonctionnelle.

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## Brief documentaire

À utiliser pour le travail de documentation et de guides.

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## Brief à forte composante de revue

À utiliser pour les zones risquées telles que l'IPC, l'authentification des fournisseurs, la persistance, Git ou la logique du cycle de vie des tâches.

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## Brief multifournisseur

À utiliser lorsque les coéquipiers s'exécutent sur des lanes fournisseur/modèle différentes.

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## Blocs d'agent dans les briefs

Les blocs d'agent sont des textes destinés uniquement aux agents, masqués et encadrés par des marqueurs tels que `<info_for_agent>...</info_for_agent>`. L'application les supprime de l'affichage normal mais les conserve disponibles pour la coordination entre agents. Utilisez-les lorsque le brief doit dire quelque chose aux agents qui serait du bruit pour un lecteur humain.

Exemple - un brief qui indique au lead comment répartir le travail sans exposer les instructions de coordination à l'utilisateur :

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

Le bloc garde le brief destiné aux humains propre tout en donnant au lead des indications structurées pour découper les tâches.

## Ce qu'il faut éviter

| Brief faible | Meilleure formulation |
| --- | --- |
| « Améliorer l'application » | Nommez le flux de travail, les fichiers et le contrôle de réussite |
| « Corriger toute la doc » | Choisissez un seul groupe de guides et une seule commande de build |
| « Utiliser le meilleur modèle » | Nommez les choix de fournisseur/modèle ou laissez les valeurs par défaut de l'application en place |
| « Refactoriser au besoin » | Indiquez quels modules ont le droit de changer |
| « Le rendre prêt pour la production » | Définissez la revue, les tests et les contrôles de déploiement |

## Avant le lancement

Vérifiez ces points avant de démarrer l'équipe :

1. Le brief nomme un résultat concret.
2. Les limites de risque sont explicites.
3. Le lead peut découper le travail en tâches révisables.
4. Les commandes de vérification sont incluses lorsqu'elles sont connues.
5. Les zones sensibles exigent une revue avant approbation.

Si le brief reste trop large, lancez d'abord une équipe solo ou réduite et demandez-lui de produire un plan de tâches plutôt qu'une implémentation.

## Guides associés

- [Créer une équipe](/fr/guide/create-team)
- [Intégration MCP](/fr/guide/mcp-integration)
- [Stratégie Git et worktree](/fr/guide/git-worktree-strategy)
