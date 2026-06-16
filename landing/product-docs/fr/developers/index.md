---
title: Hub développeur – Documentation Agent Teams
description: Point d'entrée pour les contributeurs et les développeurs sur l'architecture d'Agent Teams, les garde-fous, le débogage et les chemins d'extension MCP.
lang: fr-FR
---

# Hub développeur

Utilisez cette page lorsque vous souhaitez modifier Agent Teams lui-même, déboguer un lancement d'équipe ou étendre un runtime avec des outils MCP. Les liens ci-dessous pointent vers les documents canoniques du dépôt afin que les règles d'implémentation restent centralisées.

## Commencez ici

| Besoin | Aller à |
| --- | --- |
| Vue d'ensemble du dépôt, scripts et configuration des sources | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| Index de navigation et d'architecture pour les agents | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| Conventions de travail pour les agents et les contributeurs | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| Garde-fous d'implémentation stricts | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| Structure des fonctionnalités moyennes et grandes | [Standard d'architecture des fonctionnalités](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| Débogage du lancement, du bootstrap et de la messagerie des coéquipiers | [Runbook de débogage des équipes d'agents](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| Processus de contribution | [Guide de contribution](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| Notes de version / Changelog | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## Chemin de développement local

Lancez l'application de bureau Electron pour un développement normal :

```bash
pnpm install
pnpm dev
```

Le chemin navigateur/web ne remplace pas le runtime de bureau. Le mode bureau est le chemin local pris en charge, car il inclut l'IPC, les terminaux, l'authentification des fournisseurs, la gestion du cycle de vie des équipes, les diagnostics de lancement et les ponts runtime utilisés par les véritables équipes.

## Points de contrôle de l'architecture

Avant de modifier une fonctionnalité, identifiez sa frontière :

| Domaine | Emplacement attendu |
| --- | --- |
| Fonctionnalité produit moyenne ou grande | `src/features/<feature-name>/` |
| Orchestration du processus principal Electron | `src/main/` |
| Surface d'API sûre pour le preload | `src/preload/` |
| Interface du renderer et état de l'application | `src/renderer/` |
| Types partagés et helpers purs | `src/shared/` |
| Serveur MCP du tableau Agent Teams | `mcp-server/` |
| Contrôleur de données du tableau | `agent-teams-controller/` |

Utilisez `src/features/recent-projects` comme slice de référence pour l'organisation des fonctionnalités. Gardez les contrats inter-processus explicites et évitez les imports profonds au travers des frontières de fonctionnalités.

## Chemin de débogage

Pour les blocages au lancement, les états OpenCode `registered` / bootstrap non confirmé, les réponses de coéquipiers manquantes ou les journaux de tâches suspects :

1. Commencez par le [runbook de débogage](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md).
2. Inspectez le pack d'artefacts le plus récent sous `~/.claude/teams/<team>/launch-failure-artifacts/latest.json`.
3. Ouvrez l'artefact `manifest.json` et vérifiez `classification`, les fils d'Ariane du bootstrap, les diagnostics de lancement, les statuts de spawn des membres et les fins de journaux expurgées.
4. Ne nettoyez que l'équipe, l'exécution, le panneau ou le processus que vous pouvez identifier comme appartenant au smoke test ou au lancement échoué.

## Chemin de développement MCP

Agent Teams utilise un serveur MCP intégré nommé `agent-teams` pour les opérations du tableau. Les serveurs MCP utilisateur et projet peuvent ajouter des capacités externes pour les runtimes. Consultez [Intégration MCP](/fr/guide/mcp-integration) pour des exemples de configuration, la structure de `.mcp.json` et des conseils sur l'enregistrement des outils.

## Docs associées

- [Architecture pour les contributeurs](/fr/reference/contributor-architecture)
- [Configuration du runtime](/fr/guide/runtime-setup)
- [Intégration MCP](/fr/guide/mcp-integration)
- [Dépannage](/fr/guide/troubleshooting)
