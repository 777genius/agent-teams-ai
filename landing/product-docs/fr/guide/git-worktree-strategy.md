---
title: Stratégie Git et worktree – Documentation Agent Teams
description: Déterminez quand utiliser le worktree principal, les branches de fonctionnalité ou l'isolation par worktree d'OpenCode pour le travail d'agents en parallèle.
lang: fr-FR
---

# Stratégie Git et worktree

Git offre à Agent Teams le meilleur parcours de revue : des diffs ciblés, une visibilité des branches, des modifications délimitées par tâche et un travail parallèle plus sûr.

## Choisir une stratégie

| Stratégie | À utiliser quand | Compromis |
| --- | --- | --- |
| Worktree principal | Travail en solo, modifications de documentation uniquement, ou un seul coéquipier à la fois | Simple, mais les modifications parallèles peuvent entrer en collision |
| Branche de fonctionnalité | Une équipe travaille sur une modification cohérente unique | Cible de revue propre, mais les coéquipiers partagent toujours les fichiers |
| Isolation par worktree | Plusieurs coéquipiers OpenCode peuvent modifier le même dépôt en parallèle | Meilleure isolation, mais la fusion/revue demande plus de discipline |

Commencez simple. Ajoutez l'isolation par worktree lorsque des modifications parallèles sont probables, et non parce que chaque tâche nécessiterait un checkout distinct.

## Quand activer l'isolation par worktree

Activez-la pour les coéquipiers OpenCode quand :

- deux coéquipiers ou plus peuvent modifier le même dépôt en même temps
- une tâche peut exécuter des formateurs, des générateurs de code ou des tests étendus
- vous souhaitez que la branche et le diff de chaque coéquipier restent séparés
- l'espace de travail du lead est sale et ne devrait pas recevoir de modifications directes

Laissez-la désactivée quand :

- la tâche est en lecture seule
- un seul coéquipier détient toutes les modifications
- le dépôt n'est pas suivi par Git
- vous avez besoin d'un chemin de runtime qui ne prend pas en charge ce mode d'isolation

::: warning
L'isolation par worktree s'applique actuellement aux membres OpenCode et nécessite un projet suivi par Git.
:::

## Hygiène des branches

Avant de démarrer un travail en parallèle :

```bash
git status --short
git branch --show-current
```

Utilisez une branche propre lorsque c'est possible. Si le worktree principal contient déjà des modifications de l'utilisateur, demandez aux agents de ne pas annuler les fichiers sans rapport et de garder un périmètre de tâche étroit.

Style de branche recommandé :

```text
agent/<team-or-task>/<short-purpose>
```

Exemples :

```text
agent/docs/mcp-guide
agent/review/task-log-filtering
agent/ui/code-review-polish
```

## Flux de revue

Pour les worktrees isolés, examinez le diff du coéquipier avant de fusionner ou d'appliquer les modifications dans l'espace de travail principal.

1. Vérifiez que le commentaire de résultat de la tâche nomme le périmètre modifié et la vérification.
2. Inspectez le diff de la tâche dans l'interface de revue.
3. Demandez des modifications sur la tâche si le diff touche des fichiers sans rapport.
4. Approuvez uniquement après que les tests ou les vérifications manuelles correspondent au risque de la tâche.
5. Fusionnez ou appliquez les modifications délibérément.

Ne fusionnez pas automatiquement la sortie d'un worktree juste parce que la tâche est terminée. L'achèvement signifie que l'agent estime que le travail est prêt pour la revue.

## Politique de conflits

Utilisez cette politique pour les équipes en parallèle :

| Situation | Action |
| --- | --- |
| Deux coéquipiers modifient le même fichier | Mettez une tâche en pause ou désignez un responsable unique de l'intégration |
| Des fichiers générés ont été modifiés de manière étendue | Exigez un commentaire expliquant le générateur et la commande |
| Le worktree principal contient des modifications sans rapport | Préservez-les et n'examinez que les modifications propres à la tâche |
| La branche du worktree diverge | Rebasez ou fusionnez manuellement après la revue, pas dans une tâche d'agent floue |

## Exemple de prompt de tâche

```text
Implement the settings validation fix in your assigned worktree. Keep edits inside src/features/settings and focused tests. Do not touch provider auth or task storage. Post the test command and result before completing the task.
```

Ce prompt fonctionne parce qu'il nomme la zone autorisée, les frontières sensibles et la preuve d'achèvement.

## Guides associés

- [Créer une équipe](/fr/guide/create-team)
- [Revue de code](/fr/guide/code-review)
- [Exemples de briefs d'équipe](/fr/guide/team-brief-examples)
- [Configuration du runtime](/fr/guide/runtime-setup)
