---
title: Dépannage – Documentation Agent Teams
description: Résolvez les problèmes de lancement d'équipe, les réponses d'agent manquantes, les limites de débit, les problèmes d'authentification CLI et les blocages de bootstrap de lane grâce à des diagnostics locaux.
lang: fr-FR
---

# Dépannage

La plupart des problèmes d'équipe relèvent de l'une de ces quatre catégories : configuration du runtime, confirmation de lancement, analyse des tâches et limites du fournisseur.

## Mise en place rapide des preuves

Pour tout problème lié au cycle de vie d'une équipe, définissez d'abord ces variables et réutilisez le même shell :

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

Confirmez ensuite que les fichiers attendus existent avant d'interpréter l'état de l'interface :

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning Les preuves d'abord
Ne corrigez pas les prompts, les paramètres du fournisseur ou le nettoyage des processus en vous basant uniquement sur un badge bloqué. Corrélez d'abord l'interface avec les fichiers persistés, les artefacts de lancement et les preuves du runtime.
:::

## L'équipe ne se lance pas

Vérifiez chaque élément dans l'ordre :

1. **Runtime disponible** — la CLI sélectionnée (`claude`, `codex`, `opencode`) est installée
2. **PATH accessible** — le binaire est disponible dans le `PATH` de l'environnement
3. **Accès au modèle** — le fournisseur a accès à la chaîne de modèle demandée (en particulier pour OpenCode, les noms exacts de fournisseur/modèle ont leur importance)
4. **Chemin du projet** — le répertoire du projet existe et est lisible
5. **Réseau / VPN** — certains fournisseurs bloquent le trafic lorsqu'un VPN est actif

::: tip
Exécutez le binaire du runtime dans un terminal pour vérifier le `PATH` et l'authentification. Exemple : `claude --version` ou `opencode --version`.
:::

### OpenCode : enregistré mais bootstrap non confirmé

Si OpenCode affiche `registered` mais que le bootstrap n'est pas confirmé, inspectez d'abord les artefacts avant de modifier les prompts de l'équipe.

Les détails pour les contributeurs et le débogage se trouvent dans [Architecture pour les contributeurs](/fr/reference/contributor-architecture), qui renvoie au runbook canonique de débogage des équipes d'agents.

Examinez l'artefact d'échec de lancement le plus récent :

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` pointe vers le répertoire d'artefacts empaquetés le plus récent et son `manifest.json`. Le manifeste inclut :

- `classification` — pourquoi le lancement a été considéré comme un échec
- `bootstrapTransportBreadcrumb` — le chemin de livraison utilisé
- Les statuts de spawn des membres
- Les journaux et traces expurgés

Vérifiez aussi le manifeste de lane :

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip Ne devinez pas à partir de l'interface
Corrélez toujours les diagnostics de l'interface avec les fichiers persistés (`launch-state.json`, `bootstrap-journal.jsonl`) et les preuves spécifiques au runtime.
:::

## Diagnostics généraux

Commencez par les fichiers persistés sur le disque plutôt que par l'interface seule.

### Racine de l'équipe

```bash
printf '%s\n' "$TEAM_DIR"
```

Fichiers clés et ce qu'ils vous indiquent :

- `launch-state.json` — état de lancement/vivacité des membres (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — événements de bootstrap ordonnés depuis la CLI/le runtime (`tail -80`)
- `bootstrap-state.json` — résumé de la phase de bootstrap
- `config.json` — configuration du fournisseur, du modèle et du projet
- `inboxes/*.json` et `sentMessages.json` — état de livraison des messages

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### Preuves du runtime OpenCode

Pour les coéquipiers OpenCode, la preuve de session se trouve dans le magasin runtime de lane :

- `.opencode-runtime/lanes.json` — index des lanes avec leur état
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` et entrées de preuve
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — enregistrements de session validés

État sain attendu : état de lane `active`, le manifeste a un `activeRunId` avec au moins une entrée de preuve, le membre a `bootstrapConfirmed: true`.

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### Artefacts d'échec de lancement

Lorsqu'un lancement est marqué comme un échec, inspectez `latest.json` :

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
```

Le manifeste inclut :
- `classification` — pourquoi le lancement a été considéré comme un échec
- `bootstrapTransportBreadcrumb` — le chemin de livraison utilisé
- Les statuts de spawn des membres et les journaux/traces expurgés

## Les réponses des agents sont manquantes

Ouvrez les journaux de tâches et les messages des coéquipiers. Les réponses manquantes proviennent souvent de :

- **Nouvelle tentative de livraison du runtime** — l'agent a peut-être répondu, mais le message n'a pas été livré à l'application. Vérifiez le registre de livraison.
- **Analyse ou filtrage** — la sortie de l'agent ne comportait pas les marqueurs attendus ou les références de tâches.
- **Attribution de tâche** — le travail a eu lieu pendant la session mais n'a pas été lié à la tâche car l'identifiant de tâche correct était absent de la sortie.

::: warning Ne présumez pas que le silence signifie ignorer
Ne présumez pas que le modèle a ignoré le message tant que les journaux ne le confirment pas.
:::

Utilisez l'état persisté des messages pour distinguer « non envoyé » de « envoyé mais non rendu » :

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

Vérifiez `from`, `to`, `messageId`, `relayOfMessageId` et `taskRefs`. Pour les coéquipiers OpenCode, inspectez aussi les preuves de livraison du runtime avant de présumer que le modèle a ignoré le prompt.

## Les tâches ne sont pas liées aux modifications

Utilisez les journaux propres à chaque tâche et les liens de revue de code. Si un diff semble détaché :

- Vérifiez si l'identifiant de tâche ou la référence de tâche figurait dans la sortie de l'agent.
- Vérifiez que l'agent a appelé `task_add_comment` avant d'effectuer des modifications.
- Assurez-vous que l'agent a appelé `task_start` pour que le tableau sache que le travail a commencé.

Pour les coéquipiers OpenCode, la preuve faisant autorité qu'une session appartient à une tâche se trouve dans `opencode-sessions.json` et l'entrée du manifeste de lane, et pas uniquement dans le flux de messages de l'interface.

### Triage des journaux de tâches

Lorsqu'un journal de tâche semble incomplet, recherchez par identifiant de tâche dans le JSON des tâches, les boîtes de réception et les événements de bootstrap :

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

Interprétez le résultat avec soin :

| Preuve | Ce qu'elle prouve | Ce qu'elle ne prouve pas |
| --- | --- | --- |
| Message livré | L'application a écrit ou relayé un prompt | L'agent a progressé |
| Commentaire de tâche | L'agent a publié du texte visible sur le tableau | Que le commentaire constitue un progrès significatif |
| Lignes d'outils natifs | Le runtime a effectué du travail dans une session | Que le travail appartient à cette tâche, sauf si l'attribution correspond |
| Entrée du registre de modifications | L'application a enregistré des modifications de fichiers | Que l'implémentation est correcte |

Pour OpenCode, un journal de tâche sain inclut généralement des lignes de runtime natives comme `read`, `bash`, `edit` ou `write` ainsi que des lignes MCP Agent Teams. Si vous ne voyez que des lignes `agent-teams_*`, confirmez l'attribution de tâche et les limites de session avant d'élargir la correspondance des journaux.

## Limites de débit

Si un fournisseur signale une heure de réinitialisation connue, Agent Teams peut inciter le lead à continuer après le délai de récupération. Si l'heure de réinitialisation est inconnue, attendez ou changez de chemin de fournisseur/runtime.

| Comportement du fournisseur | Action suggérée |
| --- | --- |
| Heure de réinitialisation connue affichée | Attendre le délai de récupération et continuer |
| Aucune heure de réinitialisation affichée | Changer de fournisseur ou de chemin de runtime |
| 429 répétés | Réduire la concurrence ou utiliser une autre lane de modèle |

## Problèmes d'authentification CLI

### `claude login` ne persiste pas

Si la CLI est authentifiée dans un terminal mais que l'application indique le contraire, vérifiez que l'authentification est enregistrée au chemin de configuration attendu et que le processus de l'application voit le même `$HOME`.

### Clé de fournisseur OpenCode rejetée

- Vérifiez deux fois que le nom du fournisseur dans `config.json` correspond au préfixe de fournisseur dans la chaîne de modèle
- Assurez-vous que la clé n'est pas expirée ou révoquée dans le tableau de bord du fournisseur

### Journal de diagnostic d'authentification

Chaque appel à `CliInstallerService.getStatus()` ajoute une ligne à `claude-cli-auth-diag.ndjson` dans le dossier de journaux Electron (généralement `~/Library/Logs/<product-name>/` sur macOS). Si le fichier dépasse **512 KiB**, il est tronqué à vide avant la prochaine écriture.

Consultez ce fichier si vous voyez « Not logged in » ou des erreurs d'authentification dans l'application empaquetée.

## Bootstrap de lane bloqué

Pour les lanes secondaires OpenCode :

- Un fichier `inboxes/<member>.json` manquant n'est pas automatiquement un bug. Les lanes OpenCode n'ont pas besoin d'être créées via la boîte de réception primaire avant de démarrer.
- Si l'interface indique que l'équipe est encore en cours de lancement alors que les membres primaires sont déjà utilisables, « tous les coéquipiers ont rejoint » attend les lanes secondaires.
- Si `Prepared communication channels for X/Y members` reste bloqué, vérifiez si `Y` inclut à tort des membres OpenCode secondaires.

### Entrées vides du manifeste de lane

Si le pont (bridge) indique que le bootstrap a réussi mais que `manifest.json` affiche `entries: []`, le problème vient de la **validation des preuves**, et non du comportement du modèle. Le membre ne doit pas être considéré comme livrable tant que `opencode-sessions.json` et son entrée de manifeste n'existent pas.

## États courants des membres

| État | Signification |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | Sain et prêt |
| `registered` / `runtime_pending_bootstrap` | Le processus ou la lane existe, mais la preuve de bootstrap n'a pas encore été validée |
| `failed_to_start` + `runtime_process` | Le processus existe, mais la porte de lancement a échoué. Vérifiez les diagnostics |
| `failed_to_start` + `stale_metadata` | Le pid/la session enregistrés sont périmés ou morts |

::: warning
`member_briefing` à lui seul N'EST PAS une preuve de runtime. Pour OpenCode, la preuve faisant autorité est une preuve de runtime validée telle que `opencode-sessions.json` et l'entrée du manifeste.
:::

## Mode débogage du runtime

Pour le débogage local, vous pouvez forcer les coéquipiers à s'exécuter dans des panneaux tmux :

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

Utilisez ceci pour inspecter le comportement interactif de la CLI. Ne considérez pas cela comme entièrement équivalent au backend de processus.

## Vérifications de fumée

Utilisez l'application de bureau Electron pour la validation normale. Le mode de développement navigateur/web n'inclut pas le runtime de bureau complet, l'IPC, l'authentification des fournisseurs, le terminal ni le comportement du cycle de vie de l'équipe.

### Modifications de documentation uniquement

Depuis la racine du dépôt :

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### Modifications du cycle de vie de l'équipe

Commencez de façon ciblée, puis élargissez :

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### Test de fumée d'équipe en direct

Utilisez une petite équipe et un projet jetable suivi par Git :

1. Démarrez l'application de bureau avec `pnpm dev`.
2. Créez un lead et un builder.
3. Demandez une petite modification avec une commande de vérification explicite.
4. Confirmez que la tâche passe de `pending` -> `in_progress` -> `completed`.
5. Ouvrez les journaux de tâche et vérifiez que les lignes d'outils, les commentaires de tâche et les modifications de fichiers concordent.
6. N'arrêtez que l'équipe/les processus appartenant au test de fumée lors du nettoyage.

::: warning Nettoyage ciblé uniquement
Ne tuez pas tous les hôtes OpenCode, les panneaux tmux non liés ou les équipes utilisateur lors du nettoyage d'un test de fumée.
:::

## Nettoyage sûr

Lors du nettoyage de processus périmés :

1. Identifiez le pid et confirmez qu'il appartient à l'équipe / la lane en cours.
2. N'arrêtez que les processus appartenant explicitement à un test de fumée ou au lancement que vous déboguez.
3. **Ne tuez pas** tous les processus OpenCode ou les processus hôtes partagés par facilité.

## Quand collecter des preuves

Avant de demander de l'aide, collectez :

- L'identifiant de tâche (court ou complet)
- Le nom de l'équipe
- Le chemin de runtime (`claude`, `codex` ou `opencode`)
- Un extrait du journal de lancement (depuis `latest.json` ou `bootstrap-journal.jsonl`)
- La chaîne de fournisseur / modèle
- La fenêtre temporelle exacte où le problème s'est produit

Ces données suffisent généralement à déboguer les problèmes de lancement et de cycle de vie des tâches.

::: tip
Si le problème persiste, ouvrez les fichiers persistés de l'équipe sous `~/.claude/teams/<teamName>/` et corrélez les diagnostics de l'interface avec l'état des processus en direct avant de modifier le code.
:::
