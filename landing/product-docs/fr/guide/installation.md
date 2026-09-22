---
title: Installation – Documentation Agent Teams
description: Téléchargez et installez Agent Teams pour macOS, Windows ou Linux. Couvre les builds packagés, la configuration depuis les sources, les mises à jour automatiques et les prérequis.
lang: fr-FR
---

# Installation

Agent Teams est distribué sous forme d'application de bureau pour macOS, Windows et Linux.

::: tip Chemin le plus court
1. Téléchargez le build correspondant à votre plateforme ci-dessous
2. Lancez l'application - commencez avec le modèle gratuit sans authentification ou connectez l'authentification d'un fournisseur depuis l'interface
3. Lancez le [démarrage rapide](/fr/guide/quickstart) pour créer votre première équipe

Démarrage de l'application de bureau : exécutez `pnpm dev` pour l'application Electron. Ne lancez pas le mode dev navigateur/web pour un usage normal.
:::

## Télécharger les builds

Utilisez la <a href="/fr/download/" target="_self">page de téléchargement</a> ou la dernière [version GitHub](https://github.com/777genius/agent-teams-ai/releases) lorsque vous souhaitez l'application packagée :

- macOS Apple Silicon : `.dmg`
- macOS Intel : `.dmg`
- Windows : `.exe`
- Linux : `.AppImage`, `.deb`, `.rpm` ou `.pacman`

::: warning Windows SmartScreen
Les applications open source non signées ou récemment publiées peuvent déclencher SmartScreen. Si vous faites confiance à la source de la version, choisissez **More info** puis **Run anyway**.
:::

## Prérequis

L'application packagée est conçue pour une intégration sans configuration. Vous pouvez commencer avec le modèle gratuit sans authentification - sans inscription, sans clés API ni carte de crédit. Si vous souhaitez davantage de modèles, l'application vous guide pour la détection du runtime et l'authentification des fournisseurs depuis l'interface.

Pour les modèles payants ou liés à un compte, connectez au moins un fournisseur :

| Fournisseur        | Méthode d'accès                                   |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Connexion à la CLI Claude Code ou clé API         |
| Codex (OpenAI)     | Connexion à la CLI Codex ou clé API               |
| OpenCode           | Modèle gratuit inclus sans authentification, ou clé API pour un backend pris en charge (par ex. OpenRouter) |


Pour le développement depuis les sources, vous avez également besoin de :

| Outil   | Version |
| ------- | ------- |
| Node.js | 24.16.0 LTS |
| pnpm    | 10+     |

Sur macOS, les binaires précompilés officiels de Node.js 24 nécessitent macOS 13.5 ou ultérieur.

## Exécuter depuis les sources

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="Copier" copied-label="Copié" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` démarre l'application de bureau Electron avec rechargement à chaud. C'est la cible de développement par défaut — ne lancez pas de serveur de dev web dans le navigateur pour le développement normal. Le chemin navigateur ne dispose pas de l'ensemble du comportement de bureau : IPC, terminal, authentification des fournisseurs et cycle de vie des équipes.

La branche `main` contient le dernier développement stable. Passez à des branches de fonctionnalités uniquement si vous avez besoin d'un changement spécifique non encore publié.

## Vérifier la configuration

Après l'installation, confirmez que le build est sain :

```bash
# Check that the desktop app compiles and starts
pnpm typecheck

# Verify the VitePress documentation site builds
pnpm --dir landing docs:build
```

Si `pnpm typecheck` signale des erreurs de type, vérifiez s'il existe une version plus récente des dépendances ou un TypeScript épinglé. Si `pnpm --dir landing docs:build` échoue, inspectez `landing/product-docs/` pour détecter des erreurs de syntaxe dans le markdown ou la configuration.

Si vous modifiez cette documentation, exécutez le build pour vérifier vos changements :

```bash
pnpm --dir landing docs:build
```

## Mises à jour automatiques

L'application packagée recherche des mises à jour automatiquement au démarrage et périodiquement pendant son exécution. Lorsqu'une mise à jour est disponible, l'application vous invite à la télécharger et à l'installer. Vous pouvez également vérifier manuellement depuis le menu de l'application.

::: tip
Les mises à jour automatiques ne sont pas disponibles lors de l'exécution depuis les sources. Récupérez les dernières modifications et relancez `pnpm install` lorsque les dépendances changent.
:::

## Mettre à jour depuis les sources

Si vous exécutez depuis les sources, récupérez la branche `main` et relancez l'installation lorsque les dépendances changent :

```bash
git pull
pnpm install
```

Après la mise à jour, vérifiez le build et la documentation :

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

Utilisez toujours `pnpm dev` (Electron) — et non le serveur de dev navigateur — pour le développement normal.

## Étapes suivantes

- [Démarrage rapide](/fr/guide/quickstart) — de l'installation à la première équipe en cours d'exécution
- [Configuration du runtime](/fr/guide/runtime-setup) — authentification des fournisseurs et sélection du modèle par runtime
- [Créer une équipe](/fr/guide/create-team) — formes d'équipe recommandées et rédaction du brief

### Pour les contributeurs

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — navigation dans le dépôt et repères d'architecture
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — conventions de travail et règles du projet
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — garde-fous stricts d'implémentation
