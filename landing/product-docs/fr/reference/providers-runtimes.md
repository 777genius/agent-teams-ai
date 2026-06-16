---
title: Fournisseurs et runtimes – Documentation Agent Teams
description: Chemins de runtime pris en charge (Claude Code, Codex, OpenCode), identifiants de fournisseur, nommage des modèles, stratégies multi-fournisseurs et vérifications de capacités.
lang: fr-FR
---

# Fournisseurs et runtimes

Agent Teams sépare l'orchestration de l'accès aux modèles. L'application gère les équipes, les tâches, les messages, l'état de lancement et l'interface de revue ; le chemin runtime/fournisseur sélectionné effectue le travail réel du modèle.

## Ce que fournit l'application

Agent Teams fournit :

- l'orchestration des équipes et des tâches
- l'interface du tableau kanban
- la messagerie entre coéquipiers
- les journaux de tâches
- l'interface de revue
- l'intégration des projets locaux
- la détection du runtime et les vérifications de capacités
- les journaux et diagnostics locaux

## Ce que fournit le runtime

Le runtime fournit :

- l'exécution du modèle
- l'authentification du fournisseur
- le comportement d'exécution des outils
- les limites de débit et les capacités spécifiques au modèle
- les transcriptions et les preuves de livraison spécifiques au runtime

## Chemins de runtime pris en charge

| Chemin de runtime | Chemin fournisseur/modèle | Idéal pour | Notes |
| --- | --- | --- | --- |
| Claude Code | Anthropic / modèles Claude | Utilisateurs de Claude Code et flux de travail adossés à Anthropic | Chemin local-first par défaut pour les équipes Claude. Nécessite que le runtime et l'accès au compte soient disponibles localement. |
| Codex | Codex / modèles adossés à OpenAI | Flux de travail natifs Codex | Utilise l'intégration du runtime Codex et l'état d'authentification/de compte Codex lorsqu'ils sont disponibles. Certains diagnostics diffèrent des transcriptions Claude. |
| OpenCode | Routage de modèles géré par OpenCode | Équipes multi-fournisseurs et large couverture de modèles | OpenCode peut router à travers de nombreux fournisseurs de modèles. Agent Teams traite les voies OpenCode comme des preuves spécifiques au runtime et évite de deviner lorsque l'identité de la voie est ambiguë. |

Gemini est disponible comme chemin de fournisseur pris en charge avec l'authentification Google ADC (gcloud auth), l'OAuth de Gemini CLI et par clé API. Il apparaît aux côtés des autres fournisseurs dans l'interface de création d'équipe et de configuration du runtime lorsque le runtime le signale comme disponible.

## Identifiants de fournisseur

L'application reconnaît actuellement ces identifiants de fournisseur dans la configuration d'équipe/runtime :

| Identifiant de fournisseur | Intention d'affichage |
| --- | --- |
| `anthropic` | Chemin Anthropic / Claude Code |
| `codex` | Chemin Codex |
| `gemini` | Chemin du fournisseur Gemini (Google ADC, Gemini CLI ou clé API) |
| `opencode` | Chemin OpenCode, y compris le routage de fournisseur géré par OpenCode |

Ne considérez pas ce tableau comme une garantie que chaque fournisseur est authentifié, installé ou disponible pour chaque modèle sur chaque machine. L'état du runtime et les vérifications de capacités font foi pour un lancement donné.

## Identifiants de modèle

Les identifiants de modèle sont transmis au runtime sélectionné. Agent Teams ne réécrit pas le catalogue de modèles d'un fournisseur dans un schéma de nommage universel.

Exemples :

| Chemin fournisseur | Exemple d'identifiant de modèle | Notes |
| --- | --- | --- |
| Claude Code | `opus`, `sonnet`, ou un identifiant de modèle Claude complet | La disponibilité dépend de Claude Code et de l'accès au compte |
| Codex | `gpt-5.4`, `gpt-5.3-codex` | La disponibilité provient de l'état du compte/runtime Codex |
| OpenCode | `openrouter/moonshotai/kimi-k2.6` | Le préfixe doit correspondre à une configuration de fournisseur OpenCode |

Si un nom de modèle est rejeté, vérifiez-le d'abord directement dans le runtime/fournisseur. Modifier un brief d'équipe ne peut pas rendre lançable un modèle indisponible.

## Stratégie multi-fournisseurs

Agent Teams maintient une orchestration consciente du fournisseur mais sans en dépendre :

- les équipes, les tâches, les boîtes de réception, les commentaires, l'état de revue et les diagnostics de lancement restent dans le stockage local d'Agent Teams
- chaque membre peut porter des paramètres de fournisseur/modèle via les métadonnées de lancement d'équipe
- la disponibilité des modèles, l'authentification, les limites de débit et le comportement des outils restent des responsabilités du runtime/fournisseur
- OpenCode est le chemin de routage le plus large lorsque vous souhaitez qu'une seule équipe utilise plusieurs voies de fournisseur/modèle

Pour les frontières destinées aux contributeurs et les conseils d'implémentation canoniques, voir [Architecture pour les contributeurs](/fr/reference/contributor-architecture).

Modèles recommandés :

| Modèle | Quand il aide | Risque |
| --- | --- | --- |
| Un seul fournisseur pour tous les membres | Premier lancement, dépôts sensibles, débogage le plus simple | Des limites de débit partagées peuvent arrêter toute l'équipe |
| Lead solide + constructeurs moins coûteux | Garder la planification/revue fiable tout en réduisant le coût d'implémentation | La sortie des constructeurs peut nécessiter une revue plus stricte |
| Modèles distincts pour le constructeur et le relecteur | Détecter les angles morts spécifiques à un modèle | Plus de configuration et d'attribution à inspecter |

## Coûts des fournisseurs

Agent Teams est gratuit et open source. Vous pouvez démarrer avec le modèle gratuit inclus sans authentification - sans inscription, clés API ni carte de crédit. L'utilisation de fournisseurs payants ou adossés à un compte est régie par le runtime/fournisseur que vous sélectionnez : limites d'abonnement, clés API, authentification de compte, limites de débit et politiques de fournisseur restent toutes externes à l'application.

## Vérifications de capacités

Lors de la configuration, l'application peut effectuer des vérifications d'accès et de capacités. Cela aide à détecter une authentification de runtime manquante avant qu'un lancement d'équipe n'échoue à mi-parcours du provisionnement.

Les vérifications de capacités peuvent signaler qu'un fournisseur existe mais n'est pas authentifié, qu'une liste de modèles est indisponible, qu'un chemin de runtime est manquant, ou qu'une capacité d'extension spécifique n'est pas prise en charge. Traitez ces résultats comme des diagnostics de configuration, pas comme des échecs de tâche.

Correctifs de configuration typiques :

| Résultat de la vérification | Que faire |
| --- | --- |
| Runtime manquant | Installer la CLI ou corriger le `PATH` |
| Fournisseur non authentifié | Lancer le flux de connexion du fournisseur ou ajouter la clé API requise |
| Modèle indisponible | Choisir un modèle visible dans la liste des modèles de ce runtime |
| Capacité non prise en charge | Utiliser un autre chemin de runtime pour ce coéquipier |

## Limites à prévoir

- La prise en charge d'un runtime ne signifie pas une parité de fonctionnalités égale entre Claude Code, Codex et OpenCode.
- La couverture des journaux et des transcriptions diffère selon le runtime.
- Les voies OpenCode ont besoin de preuves de voie/session stables avant que l'application puisse attribuer les journaux de runtime en toute sécurité.
- Les noms et la disponibilité des modèles des fournisseurs peuvent changer en dehors de l'application.
- Un prompt d'équipe ne peut pas corriger une authentification manquante, des entrées PATH manquantes, des pannes de fournisseur ou des limites de débit épuisées.
