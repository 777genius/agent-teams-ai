---
title: Concepts – Documentation Agent Teams
description: Vocabulaire de base d'Agent Teams — équipes, leads, coéquipiers, tâches, kanban, boîtes de réception, runtimes et revue.
lang: fr-FR
---

# Concepts

Cette page définit les termes de base utilisés dans Agent Teams. Servez-vous-en comme vocabulaire commun pour l'application, le tableau des tâches, les messages et le flux de revue.

## Équipe

Une équipe est un groupe nommé d'agents rattaché à un chemin de projet. Elle possède un lead, des coéquipiers optionnels, des paramètres de runtime/fournisseur, des prompts, des boîtes de réception, des tâches et un état de lancement local.

## Lead {#lead}

Le lead est le coordinateur de l'équipe. Il transforme un objectif utilisateur en tâches, assigne ou réoriente les coéquipiers, suit les blocages, demande des revues et fait avancer le travail sur le tableau.

[Coéquipier →](#teammate)

Les messages du lead empruntent un chemin de livraison différent de celui des messages des coéquipiers : l'application relaie les entrées de la boîte de réception du lead vers le runtime du lead, tandis que les coéquipiers lisent leurs propres fichiers de boîte de réception entre les tours.

## Coéquipier {#teammate}

Un coéquipier est un agent non-lead de l'équipe. Les coéquipiers occupent généralement des rôles ciblés comme builder, reviewer, chercheur ou testeur. Un coéquipier peut recevoir des messages directs, des assignations de tâches, des commentaires de tâches et des demandes de revue.

[Lead ↑](#lead)

## Tâche

Une tâche est l'unité de travail durable. Elle possède un id, un statut, un propriétaire, une description, des commentaires, des journaux, des pièces jointes, des références de tâches et des modifications revues.

Les états de tâche courants sont `todo`, `in_progress`, `done`, `review` et `approved`. En interne, le fichier de tâche stocke l'état du travail, tandis que le positionnement de revue et d'approbation peut aussi utiliser l'état d'overlay du kanban.

## Kanban

Le kanban est la vue en tableau du travail de l'équipe. Il vous permet de parcourir les tâches par état, d'ouvrir les détails d'une tâche, d'inspecter les journaux, de revoir les diffs, d'approuver le travail terminé ou de demander des modifications.

## Boîte de réception

Une boîte de réception est un fichier de messages local pour un participant de l'équipe. Agent Teams utilise les boîtes de réception pour les messages utilisateur, les messages du lead, les messages des coéquipiers, les métadonnées de livraison du runtime, les messages inter-équipes et certaines notifications système.

Les messages sont des enregistrements locaux durables. La livraison dépend toujours du fait que le runtime sélectionné soit actif et capable de traiter son tour suivant.

## Bloc d'agent

Un bloc d'agent est un texte d'instruction masqué, réservé aux agents, encadré par `<info_for_agent>...</info_for_agent>`. L'interface retire ces blocs de l'affichage normal destiné aux humains, mais les agents et la livraison runtime peuvent les utiliser pour des détails de coordination.

Le marqueur canonique actuel est `info_for_agent`. Les documents plus anciens peuvent utiliser des blocs de code délimités avec un marqueur `info_for_agent`, ou des balises de style XML `<agent_block>` — ce sont des motifs hérités qui devraient être migrés vers `info_for_agent` lorsqu'on les rencontre. (Le nom de balise original était `agent-block` ; la forme avec underscore `<agent_block>` est utilisée dans la source VitePress pour éviter l'analyse HTML.)

## Phase de contexte

Une phase de contexte est un segment d'une chronologie de contexte de session. La compaction démarre une nouvelle phase, de sorte que l'utilisation des tokens et du contexte peut être analysée avant et après la réinitialisation.

Le suivi du contexte sépare des catégories telles que les instructions de projet, les fichiers mentionnés, la sortie d'outils, le texte de réflexion, la coordination d'équipe et les messages utilisateur. Ces chiffres sont des diagnostics, pas des relevés de facturation des fournisseurs.

## Runtime

Un runtime est le chemin d'exécution local qui exécute un tour d'agent. Les chemins de runtime pris en charge incluent Claude Code, Codex et OpenCode.

Le runtime gère le comportement d'exécution du modèle, les détails d'authentification, la sémantique d'exécution des outils, les limites de débit, la disponibilité des modèles et certains formats de transcription/journaux.

## Fournisseur

Un fournisseur est le chemin d'accès au modèle situé derrière un runtime. Les ids de fournisseur actuels incluent Anthropic, Codex et OpenCode. OpenCode peut router vers de nombreux fournisseurs de modèles via sa propre configuration.

Agent Teams orchestre les tâches et les messages, mais il ne remplace pas l'authentification du fournisseur ni la politique du fournisseur.

## Mode solo

Le mode solo exécute une équipe à un seul membre. Il est utile pour le travail rapide, une charge de coordination réduite et la validation d'un prompt avant de passer à une équipe complète.

## Communication inter-équipes

Les agents peuvent échanger des messages au sein d'une équipe et entre équipes. Utilisez cette fonctionnalité lorsque des équipes distinctes mènent des travaux liés et doivent se coordonner sans tout fusionner dans une seule grande équipe.

## Niveau d'autonomie

L'autonomie contrôle ce que les agents peuvent faire avant de demander. Une autonomie plus élevée est plus rapide ; une autonomie plus faible est plus sûre pour les chemins de code sensibles, la persistance, l'authentification des fournisseurs, les opérations Git et les releases.

## Revue

La revue est le flux d'acceptation au périmètre d'une tâche. Une tâche peut passer en review, recevoir des commentaires ou des modifications demandées, puis passer en approved lorsque le résultat est accepté.

La revue est liée aux diffs locaux et à l'historique des tâches, elle fonctionne donc mieux lorsque les tâches restent étroites et que les agents mentionnent la tâche sur laquelle ils travaillent.
