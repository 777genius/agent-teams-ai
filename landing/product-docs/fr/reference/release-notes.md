---
title: Notes de version – Documentation Agent Teams
description: Notes de version et journal des modifications d'Agent Teams. Liens vers les fichiers canoniques RELEASE.md et CHANGELOG.md pour tous les détails.
lang: fr-FR
---

# Notes de version

Version actuelle : **v1.2.0** (2026-03-31). Le développement actif se poursuit sur la branche `main` avec des modifications non publiées concernant la synchronisation du travail des membres, le renforcement de la livraison OpenCode et la stabilisation de la CI.

## Comment fonctionnent les versions

Agent Teams suit le [versionnage sémantique](https://semver.org/). Les tags poussés sur le dépôt déclenchent un [workflow de publication](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) automatisé qui construit des paquets signés pour macOS, Windows et Linux, puis les publie sur GitHub Releases.

## Versions récentes

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
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | Journal des modifications complet avec toutes les versions, fonctionnalités, améliorations et corrections de bugs du point de vue de l'utilisateur. |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | Installeurs téléchargeables pour toutes les plateformes. |

## Pages connexes

- [Installation](/fr/guide/installation)
- [Démarrage rapide](/fr/guide/quickstart)
- [Architecture pour les contributeurs](/fr/reference/contributor-architecture)
- [Développeurs](/fr/developers/)
