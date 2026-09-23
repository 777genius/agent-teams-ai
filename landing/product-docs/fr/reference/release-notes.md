---
title: Notes de version – Documentation Agent Teams
description: Notes de version et journal des modifications d'Agent Teams. Liens vers les fichiers canoniques RELEASE.md et CHANGELOG.md pour tous les détails.
lang: fr-FR
---

# Notes de version

Dernière version publiée : **[v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0)** (2026-09-19). Consultez [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) pour la version actuelle et les téléchargements.

## Comment fonctionnent les versions

Agent Teams suit le [versionnage sémantique](https://semver.org/). Les tags poussés sur le dépôt déclenchent un [workflow de publication](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) automatisé qui construit des paquets pour macOS, Windows et Linux, puis les publie sur GitHub Releases.

## Dernière version

### v2.15.0 - Reprise du travail, messages privés et modèles locaux

Vous pouvez reprendre le travail bloqué depuis la page de l’équipe, échanger en tête-à-tête dans Messages, choisir davantage de modèles locaux et tester Ollama sans sélectionner de projet. La version corrige aussi la visibilité des modèles locaux et la reprise de tâches restantes après l’arrêt d’une équipe mixte. Voir les [notes de v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0).

## Versions précédentes

### v1.2.0 — Agent Graph, approbation des outils par équipe, AskUserQuestion interactif

Agent Graph avec visualisation à forces dirigées et disposition des tâches en kanban, contrôles d'approbation des outils par équipe avec des invites de permission lisibles, notifications de commentaires de tâche et boutons AskUserQuestion interactifs. Refonte du système de permissions avec préchargement de Write/Edit/NotebookEdit et intégration du catalogue d'outils MCP. Voir le [journal des modifications complet](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31).

### v1.1.0 — React 19 + Electron 40, démarrages de tâche initiés par l'utilisateur

Migration vers React 19 + Electron 40, démarrages de tâche initiés par l'utilisateur depuis le tableau kanban, guide de dépannage de l'authentification, coloration syntaxique pour R/Ruby/PHP/SQL, recherche dans les transcriptions 3x plus rapide, corrections des chemins WSL/Windows et correctif d'une vulnérabilité XSS. Voir le [journal des modifications complet](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25).

### v1.0.0 — Première version publique

Première build stable : fiabilité de la CLI et de l'authentification dans les applications packagées, renforcement de l'IPC, packaging multiplateforme avec builds macOS signées, documents de gouvernance open source (LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY). Voir le [journal des modifications complet](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23).

## Sources canoniques

| Document | Description |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | Processus de publication, guide de versionnage, nommage des artefacts, configuration des mises à jour automatiques et modèle de notes de version. |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Historique des premières versions ; consultez GitHub Releases pour les versions récentes. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Installeurs téléchargeables pour toutes les plateformes. |

## Pages connexes

- [Installation](/fr/guide/installation)
- [Démarrage rapide](/fr/guide/quickstart)
- [Architecture pour les contributeurs](/fr/reference/contributor-architecture)
- [Développeurs](/fr/developers/)
