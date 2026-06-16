---
title: Architecture pour les contributeurs – Documentation Agent Teams
description: Guide du contributeur sur l'organisation des fonctionnalités, les frontières runtime/fournisseur, les garde-fous stricts et les documents d'architecture canoniques.
lang: fr-FR
---

# Architecture pour les contributeurs

Cette page est une carte destinée aux contributeurs. Elle pointe vers les directives canoniques du dépôt plutôt que de réénoncer chaque règle d'implémentation.

## Sources canoniques

Utilisez ces fichiers comme source de vérité lorsque vous modifiez l'application :

| Besoin | Source canonique |
| --- | --- |
| Vue d'ensemble du dépôt et commandes | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Conventions de travail locales | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Garde-fous stricts | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Organisation des fonctionnalités moyennes et grandes | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Débogage du lancement des équipes d'agents | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## Organisation des fonctionnalités

Les fonctionnalités moyennes et grandes doivent résider sous `src/features/<feature-name>/` et suivre le standard d'architecture des fonctionnalités. Gardez les éléments internes d'une fonctionnalité derrière des points d'entrée publics, et évitez les imports profonds qui traversent les frontières entre fonctionnalités.

Pour tout nouveau travail, partez de la slice `src/features/recent-projects` existante comme implémentation de référence locale. Les petits correctifs peuvent rester proches du chemin de code existant lorsque créer une slice de fonctionnalité ajouterait plus de structure que de valeur.

## Frontières runtime et fournisseur

Agent Teams possède l'orchestration : équipes, tâches, messages, état de lancement, interface de revue, diagnostics et persistance locale.

Le chemin runtime/fournisseur sélectionné possède l'exécution du modèle, l'authentification, la disponibilité du modèle, les limites de débit, la sémantique des outils et les preuves de transcription spécifiques au runtime. Ne faites pas en sorte que les prompts ou l'état de l'interface compensent une authentification manquante, des binaires manquants, des identifiants de modèle rejetés ou des pannes de fournisseur. Pour les détails de configuration côté utilisateur, voir [Fournisseurs et runtimes](/fr/reference/providers-runtimes).

## Débogage des équipes d'agents

En cas de blocage au lancement, d'états OpenCode `registered` / bootstrap non confirmé, de réponses de coéquipiers manquantes ou de journaux de tâches suspects, partez du runbook de débogage dédié. Inspectez l'artefact d'échec de lancement le plus récent sous `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`, puis corrélez l'état de l'interface avec les fichiers persistés et les preuves spécifiques au runtime.

Évitez les nettoyages larges pendant le débogage. N'arrêtez que le processus, la lane, l'équipe ou l'exécution de smoke test que vous pouvez identifier comme appartenant au problème.

## Conventions des contributeurs

- Utilisez `pnpm dev` pour l'application de bureau Electron pendant le développement normal.
- N'utilisez pas le mode dev navigateur comme substitut au runtime de bureau, à l'IPC, au terminal, à l'authentification du fournisseur ou au comportement du cycle de vie d'une équipe.
- Gardez séparées les responsabilités d'Electron main, preload, renderer, shared et des fonctionnalités.
- Utilisez `wrapAgentBlock(text)` pour les blocs réservés aux agents au lieu de concaténer manuellement les marqueurs.
- Privilégiez une vérification ciblée. Évitez les `lint:fix` larges ou le brassage de formatage à moins que la tâche ne porte explicitement sur le formatage.
- Traitez le parsing, le cycle de vie des tâches, la détection fournisseur/runtime, la persistance, l'IPC, Git et les flux de revue comme des zones à haut risque qui nécessitent des tests ciblés ou un chemin de vérification clair.

## Pages connexes

- [Configuration du runtime](/fr/guide/runtime-setup)
- [Dépannage](/fr/guide/troubleshooting)
- [Revue de code](/fr/guide/code-review)
- [Confidentialité et données locales](/fr/reference/privacy-local-data)
