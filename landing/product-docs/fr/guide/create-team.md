---
title: Créer une équipe – Documentation Agent Teams
description: Définissez les rôles, attribuez des fournisseurs et des modèles, rédigez un brief d'équipe et configurez l'isolation par worktree ainsi que les niveaux d'autonomie.
lang: fr-FR
---

# Créer une équipe

Une équipe est un groupe nommé d'agents doté de rôles, d'un lead, d'un projet cible et d'un prompt de coordination.

## Première équipe recommandée

Commencez par une petite équipe :

| Rôle     | Objectif                                                  |
| -------- | --------------------------------------------------------- |
| Lead     | Répartit le travail, crée les tâches, coordonne l'équipe  |
| Builder  | Implémente des tâches au périmètre défini                 |
| Reviewer | Examine les résultats, repère les régressions, demande des correctifs |

Cette configuration vous donne assez de coordination pour percevoir la valeur du produit sans rendre le premier lancement trop bruyant.

::: tip
Vous pourrez ajouter d'autres membres plus tard. Commencez petit, validez le flux de travail, puis montez en puissance.
:::

## Attribuer des fournisseurs et des modèles

Chaque membre de l'équipe s'exécute sur un backend fournisseur. Dans l'éditeur d'équipe, choisissez un fournisseur (Claude, Codex ou OpenCode) et un modèle pour chaque membre. L'application n'affiche que les fournisseurs que vous avez déjà authentifiés.

Le mélange de fournisseurs au sein d'une même équipe est pris en charge — par exemple, un lead Claude avec des builders OpenCode.

::: info
Gemini est disponible comme parcours fournisseur pris en charge. Consultez [Fournisseurs et runtimes](/fr/reference/providers-runtimes) pour les options d'authentification et le statut actuel des fournisseurs.
:::

## Rédiger un bon brief d'équipe

Le brief d'équipe doit inclure :

- le résultat que vous souhaitez
- les fichiers ou les domaines fonctionnels qui comptent
- les limites de risque, par exemple « ne pas refactoriser des modules sans rapport »
- les attentes en matière de revue
- les commandes de vérification lorsque vous les connaissez

Exemple :

```text
Build a focused improvement to the download flow. Keep changes inside the landing app unless a shared helper is clearly needed. Create tasks before implementation, review each task diff, and run landing lint/build checks.
```

## Isolation par worktree

Les membres OpenCode peuvent utiliser l'**isolation par worktree** pour travailler dans un worktree Git distinct plutôt que dans le répertoire de travail principal. Cela évite les conflits de fichiers lorsque plusieurs agents modifient le même projet.

::: warning
L'isolation par worktree nécessite un projet suivi par Git et est actuellement limitée aux membres OpenCode.
:::

Pour l'activer, basculez l'option **Worktree isolation** lors de l'ajout ou de la modification d'un membre d'équipe OpenCode.

## Choisir l'autonomie

Agent Teams prend en charge différents niveaux de contrôle. Utilisez davantage d'autonomie pour les modifications de routine et une revue plus stricte pour les zones à risque comme l'authentification des fournisseurs, l'IPC, la persistance, les workflows Git et l'outillage de release.

### Niveau d'effort

Chaque membre de l'équipe dispose d'un paramètre d'**effort** qui contrôle la quantité de raisonnement que le fournisseur investit avant de répondre. Un effort plus élevé produit des résultats plus approfondis au prix de plus de temps et de tokens.

| Niveau  | Quand l'utiliser                                              |
| ------- | ------------------------------------------------------------- |
| Low     | Recherches rapides, petites modifications de mise en forme, retouches de routine |
| Medium  | Valeur par défaut pour la plupart des tâches d'implémentation |
| High    | Refactorisations complexes, changements transversaux, chemins de code à risque |

L'application propose des niveaux supplémentaires (minimal, xhigh, max) pour les fournisseurs qui les prennent en charge. Si un modèle ne prend pas en charge l'effort configurable, le sélecteur est désactivé et la valeur par défaut du fournisseur est utilisée.

### Mode rapide

Basculez le **Fast mode** par membre pour privilégier la vitesse à la profondeur. Cela correspond au mode rapide/vitesse natif du fournisseur lorsqu'il est disponible. Réglez-le sur **On** pour les tâches de routine, sur **Off** pour le travail minutieux, ou sur **Inherit** pour suivre la valeur par défaut au niveau de l'équipe.

### Limiter le contexte

Activez **Limit context** pour réduire la fenêtre de contexte d'un membre. C'est utile pour les modèles Claude qui prennent en charge un contexte étendu (par exemple 1M de tokens) — limiter le contexte évite une consommation inutile de tokens et peut améliorer la latence des tâches qui n'ont pas besoin d'un large contexte.

## Ajouter du contexte

Joignez des fichiers, des captures d'écran ou des notes spécifiques lorsqu'ils modifient sensiblement la tâche. Les agents peuvent utiliser les descriptions de tâches, les commentaires et les pièces jointes comme contexte durable.

## Veiller à la qualité des tâches

Les bonnes équipes créent des tâches qui sont :

- assez spécifiques pour être examinées
- assez petites pour être terminées
- liées à un résultat visible
- adossées à un chemin de vérification

Si le lead crée des tâches vagues, envoyez-lui un message direct pour demander des tâches plus petites et testables.

## Étapes suivantes

- [Configuration du runtime](/fr/guide/runtime-setup) — configurez l'authentification des fournisseurs et les modèles
- [Revue de code](/fr/guide/code-review) — acceptez, rejetez ou commentez les modifications des agents
- [Dépannage](/fr/guide/troubleshooting) — problèmes courants et solutions
