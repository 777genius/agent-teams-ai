---
title: Configuration du runtime – Documentation Agent Teams
description: Configurez les runtimes Claude Code, Codex ou OpenCode. Couvre l'authentification, l'accès aux fournisseurs, le mode multimodèle et les vérifications avant lancement.
lang: fr-FR
---

# Configuration du runtime

Agent Teams est une couche de coordination. Le véritable travail des modèles s'exécute via les runtimes et les fournisseurs locaux pris en charge.

::: tip Démarrage rapide - choisir votre premier runtime
| Si vous ... | Commencez par |
| --- | --- |
| Utilisez déjà Claude Code ou disposez d'un accès Anthropic | **Claude** - authentification familière, configuration minimale |
| Utilisez Codex ou des flux de travail basés sur OpenAI | **Codex** - intégration native |
| Voulez essayer Agent Teams sans inscription ni clés d'API | **OpenCode** - utilisez le modèle gratuit inclus sans authentification |
| Voulez un routage multimodèle ou une large couverture de fournisseurs | **OpenCode** - le plus flexible, une seule configuration pour de nombreux backends |
| N'êtes pas sûr du runtime qui vous convient | **OpenCode** - couvre le plus d'options de fournisseurs et vous permet de changer plus tard |

Commencez avec un seul runtime et un seul coéquipier. Confirmez qu'un lancement fonctionne avant de passer au multimodèle.
:::

## Prérequis

Avant de lancer une équipe, assurez-vous que :

- Le binaire du runtime est installé et présent dans votre `PATH`.
- Votre compte fournisseur dispose d'un accès actif au modèle que vous comptez utiliser, sauf si vous commencez avec le modèle OpenCode gratuit inclus sans authentification.
- Le chemin du projet existe et est lisible.
- L'application et votre terminal utilisent le même environnement home/config lorsque vous testez l'authentification manuellement.

::: tip
Commencez avec un seul coéquipier et un seul fournisseur. Confirmez qu'un lancement fonctionne avant d'ajouter des voies multimodèles.
:::

Vérifications rapides dans le terminal :

```bash
command -v claude
command -v codex
command -v opencode
```

Exécutez la commande correspondant au runtime que vous prévoyez d'utiliser. Si elle n'affiche rien, installez le runtime ou corrigez le `PATH` avant de lancer une équipe.

## Chemins pris en charge

| Chemin | CLI par défaut | Fournisseurs typiques | À utiliser quand |
| --- | --- | --- | --- |
| Claude | `claude` | Anthropic | Vous utilisez déjà Claude Code ou des flux de travail adossés à Anthropic |
| Codex | `codex` | OpenAI | Vous voulez une intégration runtime native de Codex |
| OpenCode | `opencode` | OpenRouter et de nombreux backends | Vous voulez un routage multimodèle et une large couverture de fournisseurs |

L'application détecte les runtimes pris en charge et guide la configuration depuis l'interface lorsque cela est possible.

Gemini est disponible comme chemin de fournisseur pris en charge avec Google ADC (`gcloud auth`), l'OAuth de Gemini CLI et l'authentification par clé d'API. Configurez-le depuis l'interface de configuration du runtime lorsque le backend Gemini est détecté.

## Accès aux fournisseurs

Agent Teams n'a pas de palier payant propre. Vous pouvez commencer avec le modèle OpenCode gratuit inclus sans authentification - sans inscription, clés d'API ni carte de crédit. Pour des modèles supplémentaires, apportez l'accès fournisseur dont vous disposez déjà : abonnements, authentification de runtime local ou clés d'API selon le chemin que vous choisissez.

- Les chemins **Claude** et **Codex** s'appuient sur leurs outils d'authentification CLI respectifs.
- **OpenCode** peut d'abord exécuter le modèle gratuit inclus sans authentification. D'autres modèles OpenCode peuvent nécessiter des clés d'API spécifiques au fournisseur dans un fichier de configuration (par exemple `openrouter`, `openai`, `anthropic`).

## Configuration de l'authentification

### Claude Code

Exécutez le flux d'authentification standard dans un terminal :

```bash
claude login
```

Vérifiez ensuite que la CLI est accessible :

```bash
claude --version
```

Si l'application packagée signale « not logged in » alors que votre terminal fonctionne, comparez les `$HOME` et `PATH` vus par l'application avec ceux du terminal que vous avez utilisé pour la connexion. Le journal de diagnostic d'authentification décrit dans [Dépannage](/fr/guide/troubleshooting#auth-diagnostic-log) est le meilleur point de départ.

### Codex

Installez et authentifiez-vous via le flux CLI d'OpenAI :

```bash
codex login
```

Vérifiez ensuite que le runtime est accessible :

```bash
codex --version
```

Les lancements natifs de Codex utilisent l'état du compte Codex et les données du catalogue de modèles lorsqu'elles sont disponibles. Si un modèle est absent de l'interface, actualisez le statut du fournisseur avant de modifier les prompts d'équipe.

### OpenCode

Pour utiliser le modèle gratuit inclus sans authentification, sélectionnez-le dans l'application et lancez sans inscription auprès d'un fournisseur. Pour utiliser d'autres backends OpenCode, créez ou modifiez `~/.opencode/config.json` (ou le chemin équivalent sur votre plateforme) avec la clé de fournisseur souhaitée :

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-..."
    }
  }
}
```

Utilisez le nom de fournisseur exact attendu par OpenCode. Si vous définissez un nom de fournisseur personnalisé, vérifiez bien qu'il correspond à l'ID de fournisseur que vous utilisez dans la chaîne de modèle (par exemple `openrouter/moonshotai/kimi-k2.6` utiliserait le bloc `openrouter`).

Exemples de chaînes de modèle :

| Chaîne de modèle | Bloc de fournisseur qui doit exister |
| --- | --- |
| `openrouter/moonshotai/kimi-k2.6` | `openrouter` |
| `openai/gpt-5.4` | `openai` |
| `anthropic/claude-sonnet-4-6` | `anthropic` |

Si OpenCode se lance mais qu'un coéquipier ne devient jamais livrable, inspectez les preuves de voie avant de supposer que le modèle a ignoré le prompt. Voir [Dépannage](/fr/guide/troubleshooting#opencode-registered-but-bootstrap-unconfirmed).

### Gemini

Gemini prend en charge trois méthodes d'authentification :

- **Google ADC** — exécutez `gcloud auth application-default login` pour vous authentifier via les Google Application Default Credentials.
- **Gemini CLI** — exécutez `gemini login` si la CLI Gemini est installée.
- **Clé d'API** — définissez `GEMINI_API_KEY` dans votre environnement ou configurez-la via l'interface Manage Providers de l'application.

L'application détecte automatiquement la méthode d'authentification disponible et affiche le fournisseur Gemini dans l'interface de configuration du runtime et de création d'équipe lorsque le backend est accessible.

## Mode multimodèle

Le mode multimodèle peut router le travail à travers de nombreux backends de fournisseurs via une configuration compatible OpenCode. Utilisez-le lorsque vous avez besoin de flexibilité de fournisseur ou que vous voulez que les coéquipiers utilisent différentes voies de modèles.

::: info Voies de modèles
Chaque coéquipier peut utiliser une paire `providerId` + `model` différente. Dans l'interface d'édition d'équipe, déployez les options de membre pour remplacer les valeurs par défaut globales.
:::

Une configuration multimodèle prudente :

| Rôle | Fournisseur | Pourquoi |
| --- | --- | --- |
| Lead | Claude ou Codex | Gardez la coordination sur le fournisseur en qui vous avez le plus confiance |
| Builder | OpenCode | Utilisez un large routage de modèles pour le travail d'implémentation |
| Reviewer | Claude, Codex ou un second modèle OpenCode | Séparez le jugement de revue de la voie du builder |

Évitez de mélanger de nombreux fournisseurs inconnus dès le premier lancement. Confirmez une petite tâche par voie avant d'assigner un travail plus large.

## Liste de vérification avant lancement

Avant de lancer une équipe :

1. Le runtime sélectionné est installé
2. Le binaire du runtime est dans le `PATH` de l'environnement
3. L'authentification du fournisseur est configurée pour le backend choisi
4. Le fournisseur a accès à la chaîne de modèle exacte que vous spécifiez
5. Le chemin du projet existe et est lisible

## Quand changer de chemin de runtime

Changez lorsque le chemin actuel est bloqué par la disponibilité du modèle, les limites de débit, les capacités du fournisseur ou les besoins de rôle de l'équipe. Conservez le même projet et le même flux de travail d'équipe, mais validez une petite tâche après le changement.

::: warning Traitez les erreurs de configuration comme des problèmes de configuration
Si l'authentification échoue, qu'un nom de modèle est rejeté ou que le binaire du runtime est introuvable, corrigez d'abord la configuration. Ne modifiez pas les prompts d'équipe ni le code du projet pour contourner un problème de configuration du runtime.
:::

Utilisez ce tableau de décision :

| Symptôme | Meilleure première action |
| --- | --- |
| Binaire introuvable | Corrigez l'installation ou le `PATH` |
| La connexion fonctionne dans le terminal mais pas dans l'application | Vérifiez le journal de diagnostic d'authentification Electron et l'environnement |
| Modèle rejeté | Vérifiez l'identifiant de modèle exact dans le runtime du fournisseur |
| 429 répétés | Réduisez la concurrence ou changez de modèle/fournisseur |
| Voie OpenCode bloquée | Inspectez le manifeste de la voie et `opencode-sessions.json` |
