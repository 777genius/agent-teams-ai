---
title: Intégration MCP – Documentation Agent Teams
description: Configurez MCP dans Agent Teams pour les opérations sur le tableau, la coordination des coéquipiers, les serveurs d'outils externes et le développement d'outils personnalisés.
lang: fr-FR
---

# Intégration MCP

Agent Teams utilise MCP dans deux couches pratiques :

| Couche | Ce qu'elle fait | Qui l'utilise |
| --- | --- | --- |
| Serveur de tableau intégré | Expose les outils Agent Teams de tâche, message, revue, processus, runtime et inter-équipes | Les leads et les coéquipiers lancés par l'application |
| Serveurs MCP externes | Ajoutent des outils optionnels comme l'automatisation de navigateur, le contexte de conception, la recherche dans la documentation ou les systèmes d'entreprise | Les utilisateurs et les runtimes configurés |

Gardez ces couches séparées. Le serveur MCP intégré `agent-teams` est la manière dont les agents se coordonnent à l'intérieur d'Agent Teams. Les serveurs MCP externes sont des outils de runtime optionnels.

## Comment Agent Teams injecte MCP

Lorsque l'application de bureau lance des membres d'équipe basés sur Claude, elle écrit un fichier JSON `--mcp-config` temporaire contenant le serveur intégré `agent-teams` :

```json
{
  "mcpServers": {
    "agent-teams": {
      "command": "node",
      "args": ["/path/to/agent-teams-mcp/index.js"],
      "env": {
        "AGENT_TEAMS_MCP_CLAUDE_DIR": "/Users/you/.claude"
      }
    }
  }
}
```

En développement, la commande peut pointer vers `mcp-server/src/index.ts` via `tsx`. Dans les builds empaquetés, l'application copie le serveur MCP fourni vers un chemin de données applicatives stable et l'exécute avec Node. Le fichier généré appartient à l'application et est nettoyé au mieux.

Les serveurs MCP utilisateur et projet restent séparés. L'application lit les serveurs installés depuis :

| Portée | Emplacement |
| --- | --- |
| Utilisateur | `~/.claude.json` sous `mcpServers` |
| Entrée de projet locale dans la configuration Claude | `~/.claude.json` sous `projects[projectPath].mcpServers` |
| Projet | `<project>/.mcp.json` sous `mcpServers` |

Préférez la portée projet pour les outils qui appartiennent à un seul dépôt. Préférez la portée utilisateur pour les outils que vous réutilisez dans des projets sans rapport.

## Exemple de `.mcp.json` de projet

Placez ce fichier à la racine du projet lorsqu'une équipe doit voir le même serveur à portée de projet :

```json
{
  "mcpServers": {
    "docs-search": {
      "command": "npx",
      "args": ["-y", "@acme/docs-search-mcp"],
      "env": {
        "DOCS_INDEX_PATH": "./docs-index"
      }
    },
    "local-browser": {
      "command": "node",
      "args": ["./tools/mcp/browser-server.js"]
    }
  }
}
```

Ne mettez pas de secrets dans les fichiers `.mcp.json` commités. Placez les identifiants dans votre shell, une configuration à portée utilisateur, ou le flux d'installation MCP personnalisé de l'application si la valeur doit rester locale.

## Flux de travail MCP du tableau

Les agents doivent utiliser les outils MCP du tableau lorsque le travail relève d'une tâche :

1. Lisez le dernier contexte de la tâche.
2. Démarrez la tâche uniquement au moment où le travail commence réellement.
3. Ajoutez des commentaires de tâche pour les blocages, les plans et les résultats finaux.
4. Marquez la tâche comme terminée après avoir publié le commentaire de résultat.
5. Envoyez un court message lorsqu'un lead ou un coéquipier doit connaître le résultat.

Exemple de flux d'agent :

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

Utilisez un message direct pour la coordination. Utilisez un commentaire de tâche pour un historique de tâche durable.

::: tip
Si la note concerne la revue, la vérification, un changement de périmètre ou un blocage, placez-la sur la tâche.
:::

## Outils Agent Teams intégrés

Le serveur MCP enregistre les outils depuis `agent-teams-controller/src/mcpToolCatalog.js`. La boucle d'enregistrement se trouve dans `mcp-server/src/tools/index.ts`, et chaque groupe a son propre fichier sous `mcp-server/src/tools/`.

Outils opérationnels courants :

| Outil | Usage |
| --- | --- |
| `task_get` | Lire le dernier contexte de la tâche, les commentaires, les pièces jointes, le statut et les relations |
| `task_start` | Marquer une tâche in progress lorsque le travail commence réellement |
| `task_add_comment` | Ajouter des notes de blocage, des notes de vérification, des plans et des résumés de résultats finaux |
| `task_complete` | Terminer une tâche après la publication du commentaire de résultat final |
| `message_send` | Envoyer un message de boîte de réception visible à un lead, un coéquipier ou un utilisateur |
| `review_request`, `review_start`, `review_approve`, `review_request_changes` | Faire avancer les flux de revue à portée de tâche |
| `process_register`, `process_list`, `process_stop`, `process_unregister` | Suivre les serveurs de développement, les watchers et autres services en arrière-plan détenus par les coéquipiers |

Les noms d'outils peuvent apparaître aux runtimes avec des préfixes d'espace de noms MCP, par exemple `mcp__agent-teams__task_get`. Le nom d'outil canonique à l'intérieur du serveur MCP reste `task_get`.

## Enregistrer un nouvel outil intégré

Pour le travail sur le dépôt Agent Teams, ajoutez des outils de tableau intégrés via la structure FastMCP existante :

1. Ajoutez l'implémentation de l'outil au fichier correspondant dans `mcp-server/src/tools/`, ou créez un nouveau fichier de groupe si le domaine est véritablement nouveau.
2. Ajoutez le nom de l'outil au groupe approprié dans `agent-teams-controller/src/mcpToolCatalog.js`.
3. Câblez un nouveau groupe via `mcp-server/src/tools/index.ts` uniquement lorsqu'un nouveau groupe de domaine est nécessaire.
4. Validez l'entrée avec `zod` et appelez l'API du contrôleur au lieu de lire directement les fichiers du tableau.
5. Ajoutez des tests ciblés dans `mcp-server/test/tools.test.ts` ou un cas e2e lorsque le transport importe.

Forme minimale :

```ts
server.addTool({
  name: 'task_example',
  description: 'Explain what this tool does for agents.',
  parameters: z.object({
    teamName: z.string().min(1),
    claudeDir: z.string().min(1).optional(),
    taskId: z.string().min(1)
  }),
  execute: async ({ teamName, claudeDir, taskId }) => {
    assertConfiguredTeam(teamName, claudeDir);
    const controller = getController(teamName, claudeDir);
    return jsonTextContent(controller.tasks.getTask(taskId));
  }
});
```

Ne créez pas un outil qui contourne la validation du contrôleur, modifie des fichiers d'équipe sans rapport, ou expose un accès large au système de fichiers/aux processus sans un besoin de tâche restreint.

## Serveurs MCP externes

Utilisez des serveurs MCP externes lorsqu'un coéquipier a besoin d'une connexion d'outil durable, et pas seulement d'un prompt avec du contexte collé.

Bons cas d'usage :

- outils de test de navigateur ou de site web
- outils de données de conception ou de produit
- systèmes de documentation interne et de recherche
- systèmes de suivi de tickets ou de support
- outils d'inspection de base de données avec des identifiants en lecture seule

Mauvais cas d'usage :

- secrets collés dans les prompts
- fichiers ponctuels qui peuvent être attachés directement
- outils qui modifient les systèmes de production sans revue
- accès large au système de fichiers local lorsqu'une portée de projet plus étroite suffit

## Portées

Agent Teams reconnaît les portées MCP partagées et orientées projet.

| Portée | À utiliser quand |
| --- | --- |
| Utilisateur ou Global | Le même serveur doit être disponible dans tous les projets |
| Projet ou Local | Le serveur appartient à un seul dépôt, espace de travail ou contexte d'équipe |

Préférez la portée la plus étroite qui rend tout de même le flux de travail utilisable. Les serveurs à portée de projet sont plus faciles à raisonner pendant la revue, car l'outil appartient au projet en cours de modification.

## Liste de vérification de configuration

Avant d'assigner une tâche qui dépend d'un serveur MCP :

1. Installez ou configurez le serveur.
2. Confirmez qu'il apparaît dans la liste MCP installée de l'application pour la portée prévue.
3. Lancez les diagnostics depuis le registre MCP ou l'interface des extensions lorsqu'ils sont disponibles.
4. Commencez par une tâche en lecture seule à faible risque.
5. Mentionnez l'utilisation attendue de l'outil MCP dans la description de la tâche ou le brief d'équipe.

Si un serveur échoue aux diagnostics, corrigez cela d'abord. Un meilleur prompt de tâche ne réparera pas une commande manquante, un mauvais chemin de configuration ou des identifiants rejetés.

## Installer un serveur personnalisé depuis l'application

L'application de bureau expose les API du registre MCP via Electron IPC pour la recherche, le parcours, l'installation, l'installation personnalisée, la désinstallation, la lecture de l'état installé et les diagnostics. Les installations personnalisées valident le nom du serveur, la portée, le chemin du projet, les noms des variables d'environnement et les en-têtes HTTP avant d'appeler le chemin d'installation du runtime.

Utilisez l'installation personnalisée lorsque vous avez un paquet MCP qui n'est pas encore dans le registre :

| Champ | Exemple |
| --- | --- |
| Nom du serveur | `docs-search` |
| Portée | `project` pour ce dépôt, `user` pour tous les projets |
| Type | `stdio` pour les commandes locales, `http` ou `sse` pour les serveurs distants |
| Paquet | `@acme/docs-search-mcp` |
| Env | `DOCS_INDEX_PATH=./docs-index` |

Après l'installation, lancez les diagnostics et créez une petite tâche en lecture seule pour éprouver la surface d'outils avant d'assigner un travail plus important.

## Exemple de tâche

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

Cela fonctionne parce que cela nomme l'outil, la surface, la limite d'écriture et l'étape de vérification.

## Règles de sécurité

- Ne donnez pas par défaut à chaque coéquipier chaque serveur MCP.
- Tenez les outils capables d'écriture hors des équipes larges, sauf si la revue les exige.
- Préférez les identifiants en lecture seule pour les tâches d'inspection.
- Placez l'utilisation d'outils ayant un impact sur la production derrière des commentaires de tâche explicites et une revue.
- Traitez les échecs de diagnostic MCP comme des échecs de configuration, pas des échecs d'agent.
- Évitez de commiter des secrets dans `.mcp.json` ou dans les prompts.
- Utilisez des valeurs `projectPath` absolues lors de l'installation de serveurs à portée de projet via l'application.
- Ne modifiez pas les fichiers `agent-teams-mcp-*.json` générés par l'application ; ce sont des artefacts de lancement temporaires.

## Guides associés

- [Configuration du runtime](/fr/guide/runtime-setup)
- [Exemples de briefs d'équipe](/fr/guide/team-brief-examples)
- [Flux de travail des agents](/fr/guide/agent-workflow)
- [Développeurs](/fr/developers/)
