---
title: Démarrage rapide – Documentation Agent Teams
description: Passez d'une installation neuve à une équipe d'agents IA en fonctionnement en quelques minutes. Couvre l'installation, la sélection du runtime, la création d'équipe et la première revue de code.
lang: fr-FR
---

# Démarrage rapide

Ce guide vous fait passer d'une installation neuve à une équipe en fonctionnement en quelques minutes.

## Le chemin le plus court

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

L'application de bureau Electron (`pnpm dev`) est la cible principale — n'utilisez pas le serveur de développement navigateur/web pour le développement normal. Le chemin navigateur ne dispose pas de l'IPC de bureau, du terminal, de l'authentification fournisseur, ni du comportement de cycle de vie des équipes.

## Avant de commencer

Vous avez besoin de :

- **Un ordinateur** sous macOS, Windows ou Linux
- **(Recommandé) Un projet suivi par Git** — l'isolation par worktree et la revue des diffs reposent sur Git
- **(Optionnel) Un accès fournisseur** — la configuration du runtime détecte les fournisseurs disponibles depuis l'interface, mais certains chemins nécessitent une authentification existante (Anthropic, OpenAI, etc.)

Si une étape ci-dessous ne fonctionne pas, consultez le [guide de dépannage](/fr/guide/troubleshooting#team-does-not-launch) pour les correctifs courants.

Pour les conventions de projet et les recommandations d'architecture, reportez-vous à ces fichiers canoniques avant d'apporter des modifications :

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — repères de navigation et d'architecture du dépôt
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — conventions de travail et règles du projet
- [Standard d'architecture des fonctionnalités](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — structure pour les nouvelles fonctionnalités
- [Runbook de débogage](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — diagnostics de lancement et de coéquipiers

## 1. Exécuter depuis les sources ou télécharger

**Téléchargez l'application packagée** pour macOS, Windows ou Linux depuis la <a href="/fr/download/" target="_self">page de téléchargement</a> - aucun prérequis nécessaire. Commencez avec le modèle gratuit sans authentification, ou connectez une authentification fournisseur depuis l'interface lorsque vous souhaitez davantage de modèles.

**Ou exécutez depuis les sources** pour le développement :

Nécessite Node.js 24.16.0 LTS et pnpm 10+. Sur macOS, les binaires précompilés officiels de Node.js 24 nécessitent macOS 13.5+.

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` démarre l'application de bureau Electron avec rechargement à chaud. C'est la cible de développement par défaut. Ne démarrez pas un serveur de développement web navigateur pour le développement normal — le chemin navigateur ne dispose pas de l'IPC de bureau complet, du terminal, de l'authentification fournisseur, ni du comportement de cycle de vie des équipes.

## 2. Ouvrir ou créer un projet

Lancez l'application et sélectionnez le répertoire du projet dans lequel vous voulez que les agents travaillent. Agent Teams lit les fichiers locaux du projet et l'état du runtime/de la session afin que l'interface puisse afficher les tâches, les journaux, les diffs et l'activité des coéquipiers.

::: tip
Choisissez un projet suivi par Git pour la meilleure expérience. L'isolation par worktree et la revue basée sur les diffs reposent toutes deux sur Git.
:::

Avant de lancer une équipe, vérifiez que le projet dispose d'une base de référence suffisamment propre :

```bash
git status --short
```

Vous n'avez pas besoin d'un arbre parfaitement propre, mais vous devriez savoir quelles modifications sont les vôtres avant que les agents ne commencent à éditer. Cela rend les diffs de tâche et la revue au niveau du hunk bien plus fiables.

## 3. Choisir un chemin de runtime

Le flux de configuration détecte automatiquement les runtimes installés sur votre machine. Une première configuration courante est :

| Runtime  | Adapté à                                        |
| -------- | ----------------------------------------------- |
| Claude   | Utilisateurs de Claude Code et accès Anthropic existant |
| Codex    | Flux de travail natifs Codex et accès OpenAI        |
| OpenCode | Modèle gratuit sans authentification, équipes multimodèles et nombreux backends fournisseurs |

::: info
Gemini est disponible en tant que chemin fournisseur pris en charge. Voir [Fournisseurs et runtimes](/fr/reference/providers-runtimes) pour les options d'authentification et l'état actuel des fournisseurs.
:::

Voir [Configuration du runtime](/fr/guide/runtime-setup) pour une configuration détaillée par fournisseur.

Pour vérifier un runtime payant ou adossé à un compte en dehors de l'application, vérifiez le binaire et testez l'authentification :

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

Si la commande échoue, corrigez d'abord l'installation du runtime ou le `PATH`. Les prompts d'équipe ne peuvent pas contourner un binaire manquant ou une authentification fournisseur manquante pour les modèles qui l'exigent.

::: tip
Si le binaire est trouvé mais que l'application signale « not logged in », l'environnement peut différer entre votre terminal et l'application. Voir le [journal de diagnostic d'authentification](/fr/guide/troubleshooting#auth-diagnostic-log) pour les comparer.
:::

## 4. Créer votre première équipe

Créez une équipe avec un lead et un ou plusieurs spécialistes. Gardez la première équipe petite : un lead, un agent d'implémentation et un agent orienté revue suffisent pour valider le flux de travail.

Voir [Créer une équipe](/fr/guide/create-team) pour la structure recommandée et des conseils.

Pour le premier lancement, privilégiez une forme d'équipe comme celle-ci :

| Membre | Responsabilité | Notes |
| --- | --- | --- |
| Lead | Découper l'objectif en tâches et coordonner le statut | Conservez-le sur le fournisseur le plus fiable dont vous disposez |
| Builder | Implémenter les tâches délimitées | Donnez des frontières claires de fichiers ou de fonctionnalités |
| Reviewer | Examiner le travail terminé | Demandez-lui de se concentrer sur les régressions et les tests manquants |

Évitez de commencer avec cinq coéquipiers ou plus. Davantage d'agents augmentent la concurrence, les journaux, l'utilisation des fournisseurs et le risque de conflits avant que vous ne sachiez que la configuration est saine.

## 5. Donner au lead un objectif concret

Rédigez l'objectif comme vous briefieriez un lead d'ingénierie :

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

Les bons premiers prompts incluent un périmètre concret, des frontières de sécurité et une vérification :

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

Évitez les prompts vagues comme « rendre l'application meilleure » pour la première exécution. Le lead peut décomposer de grands objectifs, mais une meilleure entrée produit des tâches plus petites et une revue plus propre.

::: tip
Si l'équipe se lance mais qu'aucune tâche n'apparaît, vérifiez si le lead a reçu votre prompt. Voir [les réponses des agents sont manquantes](/fr/guide/troubleshooting#agent-replies-are-missing) pour les diagnostics.
:::

Le lead crée les tâches, attribue le travail et coordonne les coéquipiers. Vous pouvez suivre la progression sur le tableau kanban et intervenir à tout moment avec des commentaires ou des messages directs.

## 6. Examiner les résultats

Ouvrez les tâches terminées ou prêtes pour la revue, inspectez le diff, et acceptez, rejetez ou commentez les modifications individuelles. Utilisez les journaux de tâche lorsque vous avez besoin de comprendre pourquoi un agent a fait un choix.

Voir [Revue de code](/fr/guide/code-review) pour le flux de travail de revue complet.

Avant d'approuver la première tâche, vérifiez trois choses :

1. Le commentaire de la tâche explique ce qui a changé
2. Les fichiers modifiés correspondent au périmètre de la tâche
3. Le résultat de la vérification est visible dans le commentaire de la tâche ou les journaux

## Pièges courants

| Symptôme | Cause probable | Vérification |
| --- | --- | --- |
| L'application ne détecte pas de runtime | Binaire absent du `PATH`, ou l'application et le terminal voient des environnements différents | Exécutez `command -v <runtime>` dans un terminal, puis utilisez le même environnement de terminal pour lancer l'application |
| Le lancement de l'équipe se bloque | Authentification fournisseur manquante pour un modèle payant/adossé à un compte, mauvaise chaîne de modèle, ou binaire du runtime introuvable | Voir [Dépannage](/fr/guide/troubleshooting#team-does-not-launch) |
| La voie OpenCode reste bloquée sur `registered` | Preuve de voie pas encore committée, ou incohérence de chaîne de modèle | Inspectez `~/.claude/teams/<team>/.opencode-runtime/lanes/` |
| Réponses des agents manquantes | Problème de réessai de livraison du runtime, d'analyse, ou d'attribution de tâche | Ouvrez les journaux de tâche et vérifiez le registre de livraison |
| Le fournisseur renvoie des 429 | Limite de débit atteinte | Attendez la réinitialisation ou changez de modèle/fournisseur |

## Étapes suivantes

- [Créer une équipe](/fr/guide/create-team) — formes d'équipe recommandées et rédaction du brief
- [Configuration du runtime](/fr/guide/runtime-setup) — authentification fournisseur et sélection du modèle
- [Revue de code](/fr/guide/code-review) — examiner, approuver ou demander des modifications

### Pour les contributeurs

Si vous modifiez Agent Teams ou cette documentation, commencez par les fichiers canoniques du projet à la racine du dépôt :

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — conventions de travail et règles du projet
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — couche de navigation pour l'architecture et les recommandations d'implémentation
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — garde-fous d'implémentation stricts
- [Standard d'architecture des fonctionnalités](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — structure pour les nouvelles fonctionnalités
- [Runbook de débogage des équipes d'agents](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — diagnostics de lancement, de bootstrap et de coéquipiers

Pour vérifier que ce site de documentation se construit correctement :

```bash
pnpm --dir landing docs:build
```
