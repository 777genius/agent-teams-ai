---
title: Flux de travail des agents – Documentation Agent Teams
description: Comprenez le cycle de vie des tâches, le tableau kanban, les messages, les journaux de tâches, le travail en parallèle, les processus en direct et la communication inter-équipes.
lang: fr-FR
---

# Flux de travail des agents

Agent Teams rend le travail des agents visible sous forme d'état de tâche, de messages, de journaux et de modifications de code révisables.

## Modes

| Mode | Description |
| --- | --- |
| Solo | Un coéquipier avec des tâches auto-gérées |
| Équipe | Plusieurs coéquipiers travaillant en parallèle et se révisant mutuellement |

Les deux modes partagent les mêmes surfaces de kanban, de journaux de tâches et de revue de code.

## Cycle de vie des tâches

Agent Teams suit chaque tâche selon deux dimensions indépendantes : le statut de travail et l'état de revue.

| Dimension | États | Description |
| --- | --- | --- |
| Statut de travail | `pending`, `in_progress`, `completed` | Indique si la tâche est en attente, activement en cours de traitement ou terminée par son propriétaire |
| État de revue | `none`, `review`, `needsFix`, `approved` | Indique où en est la tâche dans le flux de revue post-achèvement |

Le tableau kanban affiche la vue combinée, mais les deux dimensions évoluent indépendamment.

### Flux du statut de travail

| Étape | Ce qui se passe | Propriétaire |
| --- | --- | --- |
| Pending | La tâche est créée et prête, mais personne n'a encore commencé le travail | Lead ou utilisateur |
| In progress | Les agents travaillent et mettent à jour l'état de la tâche via les outils MCP du tableau | Coéquipiers |
| Completed | Le propriétaire publie un commentaire de résultat et marque la tâche comme terminée | Coéquipier |

### Flux de l'état de revue

| Étape | Ce qui se passe | Propriétaire |
| --- | --- | --- |
| None | La tâche n'est pas encore en revue (elle peut être pending, in progress ou récemment completed) | — |
| Review | Une revue a été demandée ; un relecteur inspecte le diff et le résultat | Relecteur |
| Needs fix | Des modifications ont été demandées lors de la revue ; le propriétaire doit mettre à jour | Coéquipier (propriétaire) |
| Approved | La revue a réussi ; la tâche est finalisée | Relecteur |

### Planification → In progress

Lorsqu'un coéquipier démarre une tâche, le statut de travail passe à `in_progress`. L'agent crée un commentaire de tâche avec son plan et poursuit le travail. Toutes les actions des outils natifs (read, bash, edit, write) sont diffusées dans un journal de tâche.

### Completed → Review

Lorsque le coéquipier termine son travail, il publie un commentaire de résultat et fait passer le statut de travail à `completed`. Le lead ou le relecteur peut alors demander une revue pour lancer le flux de revue.

### Review → Approved

Si la surface de revue affiche des modifications acceptables, approuvez la revue. La tâche est finalisée et liée à son diff.

::: warning Revue par correction d'abord
Si l'on demande des modifications à un coéquipier lors de la revue, il doit publier un commentaire de suivi avec les corrections, puis le lead peut approuver.
:::

## Tableau kanban

Le tableau est la principale surface d'exploitation. Il vous permet de :

- Parcourir le travail ouvert, bloqué et en revue
- Ouvrir le détail d'une tâche et inspecter les journaux d'exécution
- Réviser les modifications sans lire les fichiers de session bruts
- Attribuer ou réattribuer des propriétaires

::: tip
Utilisez les boutons d'action rapide sur les cartes pour démarrer, terminer ou demander une revue sans ouvrir le panneau de détail.
:::

## Messages et commentaires

| Canal | Quand l'utiliser |
| --- | --- |
| Message direct | Rediriger un agent, poser une question rapide |
| Commentaire de tâche | Notes appartenant à une tâche spécifique |

Les commentaires conservent le contexte pour une revue ultérieure et apparaissent dans la chronologie de la tâche.

::: tip Préférez les commentaires de tâche
Si la remarque concerne une tâche spécifique, ajoutez-la en commentaire sur cette tâche plutôt que d'envoyer un message direct. Cela garde l'historique lié au travail.
:::

## Journaux de tâches

Les journaux propres à une tâche isolent la sortie d'exécution, les actions et les messages d'une seule affectation. Utilisez-les pour répondre à :

- Qu'a exécuté cet agent ?
- Pourquoi a-t-il modifié ce fichier ?
- A-t-il demandé de l'aide à un autre coéquipier ?
- Quelle tâche a produit ce diff ?

### Liste de vérification

Lorsqu'une tâche semble bloquée ou que son diff paraît détaché, vérifiez le cycle de vie dans cet ordre :

1. La tâche a le propriétaire attendu et est passée à `in_progress`.
2. Le propriétaire a publié un commentaire de tâche avec le plan ou la première mise à jour d'avancement.
3. Les journaux de tâche montrent une activité d'exécution dans la fenêtre de la tâche.
4. Les modifications de fichiers sont liées à la même tâche, au même propriétaire et à la même session.
5. Le commentaire final de la tâche inclut la commande de vérification et son résultat.

Pour un débogage plus poussé, utilisez les commandes de preuve persistée dans [Dépannage](/fr/guide/troubleshooting#task-log-triage). L'interface est la surface de travail, mais les fichiers de tâches persistés, les boîtes de réception et les preuves d'exécution sont la source pour les bugs difficiles de lancement ou d'attribution.

## Modèles de travail en parallèle

Les coéquipiers peuvent travailler simultanément sur des tâches indépendantes. Vous pouvez également créer des liens de dépendance (`blocked-by`) pour qu'une tâche attende qu'une autre soit terminée. Surveillez le tableau pour repérer les voies bloquées et réattribuez les propriétaires si un coéquipier est inactif tandis qu'un autre est surchargé.

## Processus en direct

La section des processus en direct affiche les URL et les processus en cours d'exécution lorsque les agents démarrent des serveurs ou des outils locaux. Ouvrez les URL directement depuis l'application pour inspecter les résultats. Les processus restent enregistrés jusqu'à ce qu'ils soient explicitement arrêtés ou que le runtime se ferme.

## Communication inter-équipes

Les agents peuvent envoyer des messages à d'autres équipes lorsque les équipes sont liées. Utilisez cela pour les transferts, les bibliothèques partagées ou les vérifications de statut entre escouades.
