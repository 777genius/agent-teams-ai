---
title: Documentation Agent Teams – Lancez des équipes d'agents IA depuis une application de bureau locale
description: Documentation d'Agent Teams, une application de bureau gratuite pour l'orchestration d'agents IA. Créez des équipes, suivez le travail sur un tableau kanban, examinez les modifications de code et coordonnez les flux de travail Claude, Codex, OpenCode et multimodèles.
lang: fr-FR
layout: home
hero:
  name: Documentation Agent Teams
  text: Lancez des équipes d'agents IA depuis une application de bureau locale
  tagline: Créez des équipes, suivez le travail se déplacer sur un tableau kanban, examinez les modifications de code et coordonnez les flux de travail Claude, Codex, OpenCode et multimodèles sans renoncer au contrôle local.
  actions:
    - theme: brand
      text: Démarrage rapide
      link: /fr/guide/quickstart
    - theme: alt
      text: Installation
      link: /fr/guide/installation
    - theme: alt
      text: Concepts
      link: /fr/reference/concepts
features:
  - icon: '01'
    title: Flux de travail axé sur l'équipe
    details: Définissez des rôles, lancez un lead et laissez les agents répartir, revendiquer et coordonner les tâches.
    link: /fr/guide/create-team
    linkText: Créer une équipe
  - icon: '02'
    title: Tableau kanban en direct
    details: Suivez les tâches passer par todo, in progress, review, done et approved au fil du travail des agents.
    link: /fr/guide/agent-workflow
    linkText: Comprendre le flux de travail
  - icon: '03'
    title: Revue de code intégrée
    details: Inspectez les diffs au périmètre des tâches, acceptez ou rejetez des hunks et commentez là où les agents ont besoin d'orientation.
    link: /fr/guide/code-review
    linkText: Examiner les modifications
  - icon: '04'
    title: Configuration adaptée au runtime
    details: Utilisez Claude, Codex, OpenCode ou des fournisseurs multimodèles via l'accès dont vous disposez déjà.
    link: /fr/guide/runtime-setup
    linkText: Configurer les runtimes
  - icon: '05'
    title: Contrôle local d'abord
    details: L'application de bureau lit l'état local des projets et des runtimes. Votre code reste sur votre machine, sauf si un fournisseur sélectionné reçoit le contexte du prompt.
    link: /fr/reference/privacy-local-data
    linkText: Modèle de confidentialité
  - icon: '06'
    title: Équipes débogables
    details: Tracez les journaux de tâches, la sortie du runtime, les messages des coéquipiers et les processus en direct lorsqu'un lancement ou une tâche se bloque.
    link: /fr/guide/troubleshooting
    linkText: Dépanner
---

<InstallBlock label="Copier" copied-label="Copié" />

## Commencer ici

Agent Teams est une application de bureau gratuite pour orchestrer des équipes d'agents IA. Vous n'envoyez pas seulement des prompts isolés à un seul agent : vous créez une équipe, attribuez des rôles et regardez les agents coordonner leur travail à travers un tableau de tâches.

<DocsCardGrid />

## Étapes suivantes après le lancement

Après avoir créé votre première équipe, explorez ces guides pour aller plus loin :

- **Configuration du runtime** - configurez Claude, Codex, OpenCode ou des fournisseurs multimodèles : [Configurer les runtimes](/fr/guide/runtime-setup)
- **Flux de travail des agents** - comprenez comment les agents se coordonnent à travers le tableau de tâches : [Comprendre le flux de travail](/fr/guide/agent-workflow)
- **Exemples de briefs d'équipe** - apprenez des modèles de prompt à partir de briefs concrets : [Voir les exemples](/fr/guide/team-brief-examples)
- **Revue de code** - inspectez les diffs, acceptez ou rejetez les modifications : [Examiner les modifications](/fr/guide/code-review)
- **Dépannage** - diagnostiquez les lancements bloqués, les coéquipiers manquants et les échecs de tâches : [Dépanner](/fr/guide/troubleshooting)
- **Stratégie Git et worktree** - utilisez l'isolation par worktree lorsque plusieurs coéquipiers modifient le même dépôt en parallèle : [En savoir plus sur les worktrees](/fr/guide/git-worktree-strategy)
- **Notes de version** - découvrez les nouveautés de chaque version : [Voir les versions](/fr/reference/release-notes)

## Référence

Utilisez les pages de référence lorsque vous avez besoin de la terminologie exacte, du comportement des fournisseurs, de l'architecture pour les contributeurs ou des frontières de confidentialité.

<DocsCardGrid type="reference" />

## Aperçu du produit

<ZoomImage src="/screenshots/product-preview.png" alt="Tableau kanban d'Agent Teams" caption="Le statut des tâches, l'activité des coéquipiers et le flux de revue restent visibles dans un seul espace de travail." />
