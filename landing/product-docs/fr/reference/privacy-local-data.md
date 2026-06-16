---
title: Confidentialité et données locales – Documentation Agent Teams
description: Ce qu'Agent Teams stocke localement, ce qui peut quitter votre machine via les appels de modèles adossés à un fournisseur, et des conseils pratiques en matière de confidentialité.
lang: fr-FR
---

# Confidentialité et données locales

Agent Teams privilégie le local, mais le chemin runtime/fournisseur sélectionné a toujours son importance. Cette page décrit ce que l'application de bureau stocke localement et ce qui peut quitter votre machine lorsque les agents appellent des modèles adossés à un fournisseur.

## Ce qui reste local

L'application de bureau s'exécute sur votre machine et lit les données locales de projet/runtime pour alimenter l'interface. Les données locales typiques comprennent :

- les fichiers de projet
- la configuration de l'équipe et les métadonnées des membres
- les métadonnées de tâches, les commentaires de tâches et les références de tâches
- les messages de la boîte de réception
- les journaux de runtime/session
- l'état de lancement et les diagnostics de bootstrap
- l'état des revues
- les paramètres locaux de l'application

Les emplacements locaux importants comprennent :

| Plateforme | Emplacement | Objet |
| --- | --- | --- |
| macOS/Linux | `~/.claude/teams/<team>/` | Configuration de l'équipe, métadonnées des membres, boîtes de réception, état de lancement, preuves de bootstrap, diagnostics de runtime, enregistrements des messages envoyés, état du kanban et fichiers d'équipe liés aux revues. |
| Windows | `%APPDATA%\Claude\teams\<team>\` | Idem — configuration de l'équipe, métadonnées des membres, boîtes de réception, état de lancement et diagnostics. |
| macOS/Linux | `~/.claude/tasks/<team>/` | Fichiers JSON de tâches durables pour le tableau de l'équipe. |
| Windows | `%APPDATA%\Claude\tasks\<team>\` | Idem — fichiers JSON de tâches durables. |
| macOS/Linux | `~/.claude/projects/<encoded-project>/` | Fichiers de session de projet de style Claude/Codex utilisés pour l'historique des sessions, l'analyse de contexte et l'interface adossée aux transcriptions. |
| Windows | `%APPDATA%\Claude\projects\<encoded-project>\` | Idem — fichiers de session de projet. |

Les fichiers exacts peuvent varier selon le runtime et la version de l'application. Pour le débogage de lancement, les preuves les plus récentes se trouvent généralement sous le dossier `~/.claude/teams/<team>/` pertinent (ou `%APPDATA%\Claude\teams\<team>\`).

## Ce qui peut quitter votre machine

Agent Teams en lui-même n'est pas un service de synchronisation de code dans le cloud pour votre dépôt. Il n'a pas besoin de téléverser l'intégralité de votre projet vers un serveur Agent Teams pour afficher le tableau, la boîte de réception, les journaux ou l'interface de revue.

Cependant, lorsqu'un agent demande à un modèle adossé à un fournisseur de travailler, le contexte du prompt, le contenu des fichiers sélectionnés, le texte des tâches, les commentaires, les résultats d'outils, la sortie de commandes et d'autres contextes fournis par le runtime peuvent être envoyés via le chemin runtime/fournisseur sélectionné. Ce qui est envoyé dépend du runtime, du modèle, des appels d'outils, du prompt et de la configuration du fournisseur.

L'authentification auprès du fournisseur, la rétention côté fournisseur, l'entraînement, la journalisation, le traitement régional et la facturation sont régis par le fournisseur/runtime que vous choisissez. Examinez ces politiques pour les projets sensibles.

Exemples courants :

| Action | Données pouvant être envoyées via le runtime/fournisseur |
| --- | --- |
| Demander à un agent de modifier un fichier | Le prompt de la tâche, le contenu pertinent du fichier, les résultats d'outils et la sortie de commandes |
| Joindre une capture d'écran | Le contenu de la pièce jointe et le texte de tâche/commentaire environnant |
| Demander une revue de code | Le contexte du diff, les fichiers sélectionnés, les commentaires et les journaux de vérification |
| Déboguer une commande en échec | La sortie d'erreur, les traces d'appel et les extraits de code source référencés |

## Ce que l'application ne garantit pas

- Elle ne peut pas garantir que les appels de modèles adossés à un fournisseur ne reçoivent jamais de code privé.
- Elle ne peut pas outrepasser les politiques de rétention ou de facturation du fournisseur.
- Elle ne peut pas faire en sorte qu'un fournisseur distant se comporte comme un modèle entièrement local.
- Elle ne peut pas protéger les secrets qu'un agent reçoit l'instruction de coller dans des prompts, des commentaires de tâches, des fichiers ou des commandes.
- Elle ne peut pas faire en sorte que chaque runtime expose le même niveau de détail de transcription ou d'audit.

## Conseils pratiques

- Ne joignez pas de secrets aux tâches, commentaires ou messages directs.
- Examinez les politiques du fournisseur pour les projets sensibles.
- Utilisez un niveau d'autonomie plus faible pour les dépôts à risque.
- Gardez un périmètre de tâche étroit lorsque vous travaillez avec du code privé.
- Privilégiez les preuves et journaux locaux lors du débogage.
- Vérifiez les prompts générés, les descriptions de tâches et les fichiers joints avant de demander aux agents de travailler sur du matériel confidentiel.
- Utilisez des chemins fournisseur/modèle qui correspondent à vos exigences de confidentialité.

Avant d'utiliser Agent Teams sur un dépôt sensible :

1. Retirez les secrets de l'arbre de travail et des pièces jointes de tâches
2. Choisissez le chemin runtime/fournisseur que vous êtes autorisé à utiliser
3. Commencez avec une faible autonomie et de petites tâches
4. Examinez les prompts de tâches et les commentaires générés avant d'élargir le périmètre
5. Gardez les journaux en local sauf si vous les partagez intentionnellement pour obtenir de l'aide

## Modèle open source

L'application elle-même est open source et gratuite. Vous pouvez examiner le fonctionnement de l'orchestration locale, du suivi des tâches, des boîtes de réception, des diagnostics de runtime et des flux de revue dans le dépôt.
