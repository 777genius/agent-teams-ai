---
title: MCP 連携 – Agent Teams ドキュメント
description: ボード操作、チームメイトの連携、外部ツールサーバー、カスタムツール開発のために Agent Teams で MCP を設定します。
lang: ja-JP
---

# MCP 連携

Agent Teams は MCP を 2 つの実践的なレイヤーで利用します。

| レイヤー | 役割 | 利用者 |
| --- | --- | --- |
| 組み込みボードサーバー | Agent Teams のタスク、メッセージ、レビュー、プロセス、ランタイム、クロスチームのツールを公開します | アプリが起動したリードとチームメイト |
| 外部 MCP サーバー | ブラウザ自動化、デザインコンテキスト、ドキュメント検索、社内システムなどの任意のツールを追加します | ユーザーと設定済みのランタイム |

これらのレイヤーは分けて考えてください。組み込みの `agent-teams` MCP サーバーは、エージェントが Agent Teams 内で連携するための仕組みです。外部 MCP サーバーは任意のランタイムツールです。

## Agent Teams が MCP を注入する仕組み

デスクトップアプリが Claude ベースのチームメンバーを起動すると、組み込みの `agent-teams` サーバーを含む一時的な `--mcp-config` JSON ファイルが書き出されます。

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

開発環境では、このコマンドは `tsx` を介して `mcp-server/src/index.ts` を指す場合があります。パッケージ化されたビルドでは、アプリがバンドルされた MCP サーバーを安定したアプリデータパスにコピーし、Node で実行します。生成されるファイルはアプリが所有し、ベストエフォートでクリーンアップされます。

ユーザーおよびプロジェクトの MCP サーバーは引き続き分離されます。アプリはインストール済みのサーバーを次の場所から読み込みます。

| スコープ | 場所 |
| --- | --- |
| ユーザー | `~/.claude.json` の `mcpServers` 配下 |
| Claude 設定内のローカルプロジェクトエントリ | `~/.claude.json` の `projects[projectPath].mcpServers` 配下 |
| プロジェクト | `<project>/.mcp.json` の `mcpServers` 配下 |

1 つのリポジトリに属するツールにはプロジェクトスコープを優先してください。無関係な複数のプロジェクトで再利用するツールにはユーザースコープを優先してください。

## プロジェクトの `.mcp.json` の例

チームが同じプロジェクトスコープのサーバーを参照すべき場合は、このファイルをプロジェクトのルートに配置します。

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

コミットされる `.mcp.json` ファイルにシークレットを含めないでください。値をローカルに保持する必要がある場合は、認証情報をシェル、ユーザースコープの設定、またはアプリのカスタム MCP インストールフローに保存してください。

## ボード MCP のワークフロー

作業がタスクに属する場合、エージェントはボード MCP ツールを使用すべきです。

1. 最新のタスクコンテキストを読み取ります。
2. 実際に作業を始めるときにのみタスクを開始します。
3. ブロッカー、計画、最終結果についてタスクコメントを追加します。
4. 結果コメントを投稿した後にタスクを完了としてマークします。
5. リードやチームメイトが結果を知る必要があるときは、短いメッセージを送ります。

エージェントのフローの例:

```text
task_get -> task_start -> edit/test -> task_add_comment -> task_complete -> message_send
```

連携にはダイレクトメッセージを使用してください。永続的なタスク履歴にはタスクコメントを使用してください。

::: tip
そのメモがレビュー、検証、範囲の変更、ブロッカーに関わる場合は、タスクに記載してください。
:::

## 組み込みの Agent Teams ツール

MCP サーバーは `agent-teams-controller/src/mcpToolCatalog.js` からツールを登録します。登録ループは `mcp-server/src/tools/index.ts` にあり、各グループは `mcp-server/src/tools/` 配下に独自のファイルを持ちます。

一般的な運用ツール:

| ツール | 用途 |
| --- | --- |
| `task_get` | タスクの最新のコンテキスト、コメント、添付ファイル、ステータス、関連を読み取ります |
| `task_start` | 作業が実際に始まったときにタスクを in progress としてマークします |
| `task_add_comment` | ブロッカーのメモ、検証メモ、計画、最終結果の要約を追加します |
| `task_complete` | 最終結果コメントを投稿した後にタスクを完了します |
| `message_send` | リード、チームメイト、ユーザーに表示されるインボックスメッセージを送ります |
| `review_request`、`review_start`、`review_approve`、`review_request_changes` | タスクスコープのレビューワークフローを進めます |
| `process_register`、`process_list`、`process_stop`、`process_unregister` | チームメイトが所有する開発サーバー、ウォッチャー、その他のバックグラウンドサービスを追跡します |

ツール名は、ランタイムには `mcp__agent-teams__task_get` のように MCP 名前空間のプレフィックス付きで表示される場合があります。MCP サーバー内の正規のツール名は引き続き `task_get` です。

## 新しい組み込みツールの登録

Agent Teams リポジトリでの作業では、既存の FastMCP 構造を通じて組み込みのボードツールを追加します。

1. ツールの実装を `mcp-server/src/tools/` 内の該当ファイルに追加するか、ドメインが本当に新しい場合は新しいグループファイルを作成します。
2. ツール名を `agent-teams-controller/src/mcpToolCatalog.js` 内の適切なグループに追加します。
3. 新しいドメイングループが必要な場合にのみ、新しいグループを `mcp-server/src/tools/index.ts` を通じて配線します。
4. `zod` で入力を検証し、ボードファイルを直接読み取る代わりにコントローラー API を呼び出します。
5. `mcp-server/test/tools.test.ts` に焦点を絞ったテストを追加するか、トランスポートが重要な場合は e2e ケースを追加します。

最小限の形:

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

コントローラーの検証を回避するツール、無関係なチームファイルを変更するツール、狭いタスク上の必要性なしに広範なファイルシステム/プロセスアクセスを公開するツールは作成しないでください。

## 外部 MCP サーバー

チームメイトが、コンテキストを貼り付けた単発のプロンプトだけでなく、永続的なツール接続を必要とする場合は、外部 MCP サーバーを使用してください。

適している用途:

- ブラウザまたはウェブサイトのテストツール
- デザインまたはプロダクトデータのツール
- 社内ドキュメントおよび検索システム
- 課題トラッカーまたはサポートシステム
- 読み取り専用の認証情報を使ったデータベース検査ツール

適さない用途:

- プロンプトに貼り付けられたシークレット
- 直接添付できる単発のファイル
- レビューなしに本番システムを変更するツール
- より狭いプロジェクトスコープで十分な場合の広範なローカルファイルシステムアクセス

## スコープ

Agent Teams は、共有スコープとプロジェクト指向の MCP スコープを認識します。

| スコープ | 使用する場面 |
| --- | --- |
| User または Global | 同じサーバーを複数のプロジェクト間で利用できるようにすべき場合 |
| Project または Local | サーバーが 1 つのリポジトリ、ワークスペース、またはチームコンテキストに属する場合 |

ワークフローが引き続き利用可能でありながら、最も狭いスコープを優先してください。プロジェクトスコープのサーバーは、ツールが変更対象のプロジェクトに属するため、レビュー時に把握しやすくなります。

## セットアップのチェックリスト

MCP サーバーに依存するタスクを割り当てる前に:

1. サーバーをインストールまたは設定します。
2. 意図したスコープで、アプリのインストール済み MCP リストに表示されることを確認します。
3. 利用可能な場合は、MCP レジストリまたは拡張機能 UI から診断を実行します。
4. 低リスクの読み取り専用タスクから始めます。
5. 想定される MCP ツールの使用を、タスクの説明またはチームブリーフに記載します。

サーバーが診断に失敗した場合は、まずそれを修正してください。タスクプロンプトを改善しても、欠落したコマンド、誤った設定パス、拒否された認証情報は修復できません。

## アプリからカスタムサーバーをインストールする

デスクトップアプリは、検索、ブラウズ、インストール、カスタムインストール、アンインストール、インストール状態の読み取り、診断のために、Electron IPC を通じて MCP レジストリ API を公開します。カスタムインストールは、ランタイムのインストールパスを呼び出す前に、サーバー名、スコープ、プロジェクトパス、環境変数名、HTTP ヘッダーを検証します。

レジストリにまだ存在しない MCP パッケージがある場合は、カスタムインストールを使用してください。

| フィールド | 例 |
| --- | --- |
| サーバー名 | `docs-search` |
| スコープ | このリポジトリには `project`、すべてのプロジェクトには `user` |
| タイプ | ローカルコマンドには `stdio`、リモートサーバーには `http` または `sse` |
| パッケージ | `@acme/docs-search-mcp` |
| 環境変数 | `DOCS_INDEX_PATH=./docs-index` |

インストール後は診断を実行し、より大きな作業を割り当てる前に、小さな読み取り専用タスクを作成してツールの表面を検証してください。

## タスクの例

```text
Audit the docs home page with the browser MCP. Check desktop and mobile widths, capture any layout issue as a task comment, and only edit landing/product-docs files. Run `pnpm --dir landing docs:build` before completion.
```

これが機能するのは、ツール、対象範囲、書き込みの境界、検証ステップを明示しているからです。

## 安全のためのルール

- デフォルトですべてのチームメイトにすべての MCP サーバーを与えないでください。
- レビューで必要とされない限り、書き込み可能なツールを広範なチームから除外してください。
- 検査タスクには読み取り専用の認証情報を優先してください。
- 本番に影響するツールの使用は、明示的なタスクコメントとレビューの背後に置いてください。
- MCP の診断失敗は、エージェントの失敗ではなくセットアップの失敗として扱ってください。
- `.mcp.json` やプロンプトにシークレットをコミットしないでください。
- アプリを通じてプロジェクトスコープのサーバーをインストールする際は、絶対パスの `projectPath` の値を使用してください。
- アプリが生成する `agent-teams-mcp-*.json` ファイルは編集しないでください。これらは一時的な起動アーティファクトです。

## 関連ガイド

- [ランタイムの設定](/ja/guide/runtime-setup)
- [チームブリーフの例](/ja/guide/team-brief-examples)
- [エージェントのワークフロー](/ja/guide/agent-workflow)
- [開発者向け](/ja/developers/)
