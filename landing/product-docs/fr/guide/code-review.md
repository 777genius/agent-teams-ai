---
title: Revue de code – Documentation Agent Teams
description: Inspectez les diffs liés aux tâches, acceptez ou rejetez des hunks, laissez des commentaires en ligne et gérez les états de revue, de none jusqu'à approved.
lang: fr-FR
---

# Revue de code

La revue de code dans Agent Teams est centrée sur les tâches. Vous inspectez ce qui a changé pour une tâche précise au lieu de fouiller dans un diff volumineux et non structuré.

## Surface de revue

Pour chaque tâche terminée qui a modifié des fichiers, l'interface de revue vous permet de :

- Inspecter les fichiers modifiés avec le contexte avant/après
- Accepter ou rejeter des hunks individuels
- Laisser des commentaires en ligne
- Relier le diff à la description de la tâche et aux journaux de l'agent

## Décisions au niveau du hunk

Acceptez les petites modifications correctes et rejetez les erreurs isolées sans jeter toute la tâche. C'est utile lorsqu'un agent a globalement résolu la tâche mais est allé trop loin dans un fichier.

::: tip Accepter de façon incrémentale
Si un diff est globalement correct, acceptez d'abord les bons hunks et demandez des modifications uniquement pour les parties à corriger. Cela permet de garder le tableau en mouvement.
:::

Utilisez les décisions au niveau du hunk pour :

| Situation | Action |
| --- | --- |
| Modification correcte et ciblée | Accepter le hunk |
| Bonne idée, mauvais fichier ou refactor trop large | Rejeter le hunk et demander une correction plus ciblée |
| Changement de comportement peu clair | Commenter et demander une vérification |
| Bruit de formatage généré | Rejeter sauf si le formatage faisait partie de la tâche |

## Lancer une revue

1. Ouvrez une tâche terminée
2. Regardez l'onglet **Changes**
3. Si le diff semble raisonnable, cliquez sur **Request Review** pour déplacer la tâche dans la colonne review

Pendant la revue, la tâche n'est pas encore considérée comme done, de sorte que d'autres coéquipiers ou le lead peuvent encore la commenter.

## Boucle de revue

Une boucle de revue saine ressemble à ceci :

1. Le propriétaire publie un commentaire de résultat avec le périmètre modifié et la vérification
2. Le relecteur ouvre le diff de la tâche et confronte les hunks à la description de la tâche
3. Le relecteur accepte les bons hunks, rejette les mauvais hunks ou demande des modifications
4. Le propriétaire corrige uniquement le périmètre demandé et publie un commentaire de suivi
5. Le relecteur approuve lorsque le résultat de la tâche et le diff correspondent

Exemple de commentaire de demande de modifications :

```text
Please keep the copy improvements, but revert the unrelated runtime wording in the provider table. Add the `pnpm --dir landing docs:build` result before resubmitting.
```

## États de revue

| État | Signification |
| --- | --- |
| `none` | La tâche est nouvelle, in progress, ou terminée mais pas encore en revue |
| `review` | La tâche est activement en cours de revue |
| `needsFix` | Des modifications ont été demandées ; le propriétaire doit mettre à jour avant une nouvelle approbation |
| `approved` | La revue a été acceptée et la tâche est finalisée |

## Flux de revue par les agents

Les équipes peuvent relire le travail des unes et des autres avant que vous ne preniez la décision finale. Cela permet de détecter les régressions évidentes et de garder le tableau honnête, mais vous devriez tout de même relire vous-même les zones à risque.

La revue par les agents est la plus utile lorsque le relecteur dispose d'une grille claire. Par exemple, demandez à un relecteur de vérifier uniquement la clarté de la documentation, uniquement la sécurité de l'IPC ou uniquement la couverture de tests. Les demandes larges de type « tout relire » tendent à produire des retours plus faibles.

### État de revue piloté par MCP

Les changements d'état de revue (request review, request changes, approve) sont pilotés par des outils. Laisser un commentaire « request changes » sur une tâche ne déplace **pas** la colonne kanban vers `needsFix` — un lead ou un agent doit appeler l'outil MCP approprié :

- `review_request_changes` — déplace la tâche vers `needsFix` et notifie le propriétaire
- `review_approve` — déplace la tâche vers `approved` et finalise la revue

Les commentaires seuls ne suffisent pas pour les transitions d'état. Pour la liste complète des outils MCP de revue et leurs paramètres, voir [Intégration MCP](/fr/guide/mcp-integration).

## Participants à la revue

Le lead de l'équipe est le relecteur par défaut. Vous pouvez configurer des relecteurs supplémentaires dans les paramètres du Kanban si vous souhaitez que des pairs relisent le travail des unes et des autres.

## Ce qu'il faut vérifier manuellement

Priorisez ces domaines lors de la revue :

- **Authentification des fournisseurs et détection du runtime** — l'agent a-t-il modifié la configuration du runtime d'une manière qui casserait d'autres chemins ?
- **IPC, preload et frontières du système de fichiers** — gardez les responsabilités d'Electron séparées
- **Comportement Git et worktree** - vérifiez le nommage des branches, les commits et les pushes ; voir [Stratégie Git et worktree](/fr/guide/git-worktree-strategy) pour les patterns d'isolation.
- **Logique de parsing et de cycle de vie des tâches** — les modifications des références de tâches, du chunking ou du filtrage peuvent casser la livraison des messages
- **Flux de persistance et de revue de code** — les modifications du stockage des tâches ou de l'état de revue doivent rester cohérentes entre les couches IPC

Pour la disposition canonique des fonctionnalités et les liens des garde-fous stricts, utilisez [Architecture pour les contributeurs](/fr/reference/contributor-architecture).

## Vérification

Préférez des commandes de vérification ciblées. Les commandes de formatage large ou de lint-fix ne devraient pas être utilisées sauf si la tâche vise explicitement un brassage de formatage à grande échelle.

Les bons commentaires de vérification incluent la commande et le résultat :

```text
Verified with `pnpm --dir landing docs:build`. Build passed.
```

Lorsque la vérification est omise, le commentaire de tâche devrait en expliquer la raison :

```text
Docs-only wording change. Build not run because the existing dev server was busy; checked Markdown links manually.
```

::: warning Ne pas formater automatiquement tout le projet
Sauf si la tâche concerne spécifiquement le formatage, évitez d'exécuter `pnpm lint:fix` sur des fichiers sans rapport. Cela crée du bruit dans la surface de revue.
:::
