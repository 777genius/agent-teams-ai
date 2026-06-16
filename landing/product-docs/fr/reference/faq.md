---
title: FAQ – Documentation Agent Teams
description: Foire aux questions sur Agent Teams — tarification, accès aux modèles, runtimes, confidentialité, revue et dépannage.
lang: fr-FR
---

# FAQ

## Agent Teams est-il gratuit ?

Oui. L'application est gratuite et open source. L'accès au fournisseur ou au runtime peut tout de même engendrer des coûts selon ce que vous utilisez.

## Agent Teams inclut-il l'accès aux modèles ?

Non. Agent Teams est la couche locale d'orchestration et d'interface utilisateur. L'accès aux modèles provient du chemin runtime/fournisseur sélectionné, tel que Claude Code, Codex ou OpenCode.

## Quels runtimes sont pris en charge ?

Les chemins de runtime pris en charge sont Claude Code, Codex et OpenCode. L'application suit également des identifiants de fournisseur tels qu'Anthropic, Codex, Gemini et OpenCode lorsque le runtime les expose.

## Dois-je d'abord installer Claude Code ou Codex ?

Pas toujours. L'application guide la détection et la configuration du runtime depuis l'interface utilisateur. Certains chemins nécessitent tout de même une authentification de runtime externe.

La configuration d'OpenCode est distincte de celle de Claude Code et Codex. Si un lancement échoue, vérifiez l'état du runtime et l'authentification du fournisseur avant de modifier le prompt de l'équipe.

## Comment vérifier si un runtime est prêt ?

Exécutez d'abord la commande du runtime dans un terminal :

```bash
claude --version
codex --version
opencode --version
```

Confirmez ensuite l'authentification du fournisseur pour le chemin que vous avez sélectionné. Si la commande ou la vérification d'authentification échoue en dehors d'Agent Teams, corrigez la configuration avant de lancer une équipe.

## Mon code est-il téléversé vers les serveurs d'Agent Teams ?

Non. Agent Teams n'est pas un service de synchronisation de code dans le cloud. Les appels de modèle adossés à un fournisseur peuvent recevoir le contexte du prompt selon le runtime que vous avez sélectionné.

## Où les fichiers d'équipe sont-ils stockés ?

Les données de coordination d'équipe sont stockées localement dans `~/.claude/teams/<team>/` (macOS/Linux) ou `%APPDATA%\Claude\teams\<team>\` (Windows), les fichiers de tâches dans `~/.claude/tasks/<team>/` ou `%APPDATA%\Claude\tasks\<team>\`, et les données de session de projet dans `~/.claude/projects/<encoded-project>/` lorsqu'elles sont disponibles.

## Qu'est-ce qui peut quitter ma machine ?

Le contexte du prompt, le contenu des fichiers sélectionnés, les résultats d'outils, la sortie des commandes, le texte des tâches, les commentaires et les pièces jointes peuvent quitter votre machine via le chemin runtime/fournisseur lorsqu'un agent utilise un modèle adossé à un fournisseur. Le comportement exact dépend du runtime et du fournisseur.

## Les agents peuvent-ils communiquer entre eux ?

Oui. Les agents peuvent envoyer des messages à leurs coéquipiers, commenter des tâches, se coordonner entre équipes et utiliser des références de tâches pour garder les conversations rattachées au travail.

## Que dois-je mettre dans le premier prompt d'équipe ?

Donnez au lead un résultat concret, des limites de fichiers ou de fonctionnalités, des limites de risque et des attentes de vérification. Par exemple :

```text
Improve the docs quickstart. Keep edits inside landing/product-docs, add practical examples, and run `pnpm --dir landing docs:build` before marking work done.
```

## Puis-je examiner le code avant de l'accepter ?

Oui. Le flux de revue s'articule autour de diffs cadrés par tâche et de décisions au niveau du hunk.

## Qu'est-ce qu'un Agent Block ?

Un Agent Block est un texte caché réservé aux agents, encadré par des marqueurs tels que `<info_for_agent>...</info_for_agent>`. L'application le retire de l'affichage normal destiné à l'utilisateur, mais le conserve disponible pour la coordination entre agents.

## Qu'est-ce que le mode solo ?

Le mode solo est une équipe à un seul agent. Il est utile pour les tâches plus petites et pour réduire la surcharge de coordination.

## Dois-je utiliser l'isolation par worktree ?

Utilisez-la lorsque plusieurs coéquipiers OpenCode peuvent modifier le même projet Git en parallèle. Elle réduit les conflits de fichiers, mais elle nécessite un projet suivi par Git et s'applique actuellement aux membres OpenCode.

## Différents coéquipiers peuvent-ils utiliser différents fournisseurs ?

Oui, les réglages de fournisseur/modèle peuvent être transportés par membre d'équipe lorsque le chemin runtime sélectionné les prend en charge. OpenCode est le principal chemin pour un routage multi-fournisseur étendu.

## Pourquoi une tâche affiche-t-elle review ou approved séparément de done ?

L'état du travail et l'état de revue sont liés mais ne sont pas identiques. Une tâche peut être done du point de vue de l'agent, puis passer par les étapes review et approval dans l'interface kanban.

## Que dois-je faire lorsqu'un lancement reste bloqué ?

Ouvrez le dépannage, collectez les diagnostics de lancement, vérifiez `~/.claude/teams/<team>/`, et vérifiez l'authentification du runtime/fournisseur avant de modifier les prompts.

Pour OpenCode, vérifiez les preuves de lane/session avant de supposer qu'un coéquipier est en ligne mais ignore les messages.

## Pourquoi les journaux diffèrent-ils selon les runtimes ?

Claude Code, Codex et OpenCode exposent des formats de transcription et des preuves de runtime différents. Agent Teams normalise ce qu'il peut, mais l'exhaustivité des journaux et l'attribution peuvent varier selon le runtime.
