---
title: チームブリーフの例 – Agent Teams ドキュメント
description: 小さな修正、ドキュメント作業、実装タスク、レビュー、高リスク領域向けの実用的なチームブリーフテンプレートです。
lang: ja-JP
---

# チームブリーフの例

優れたチームブリーフは、すべての実装の詳細を前もって強制することなく、リードが小さなタスクを作成するのに十分な構造を与えます。

次の形を使ってください。

```text
Outcome:
Scope:
Boundaries:
Coordination:
Verification:
Review:
```

## 最小限のブリーフ

小さくてリスクの低い作業に使用します。

```text
Outcome: Improve the quickstart so a new user can launch one team successfully.
Scope: Keep edits inside landing/product-docs.
Boundaries: Do not rewrite the whole docs structure.
Coordination: Create one or two tasks, keep comments on the task.
Verification: Run `pnpm --dir landing docs:build`.
Review: Summarize changed pages and any remaining gaps.
```

## 実装のブリーフ

コードの変更が 1 つの機能領域に及ぶ場合に使用します。

```text
Outcome: Add a focused improvement to task comment filtering.
Scope: Work inside the task/comment feature files unless a shared helper is clearly needed.
Boundaries: Do not change task storage format or review state semantics.
Coordination: Split parser, UI, and tests into separate tasks if they can be reviewed independently.
Verification: Run the focused unit tests first, then the feature typecheck if touched.
Review: Call out parsing edge cases and any behavior that affects existing task comments.
```

## ドキュメントのブリーフ

ドキュメントやガイドの作業に使用します。

```text
Outcome: Draft practical workflow guides from the docs audit.
Scope: Add concise VitePress pages under landing/product-docs/guide.
Boundaries: Avoid moving existing navigation hubs owned by other tasks.
Coordination: Check related docs tasks before editing nav.
Verification: Run `pnpm --dir landing docs:build`.
Review: Include links added to sidebar and any pages intentionally left as drafts.
```

## レビュー重視のブリーフ

IPC、プロバイダー認証、永続化、Git、タスクライフサイクルのロジックなど、リスクの高い領域に使用します。

```text
Outcome: Fix the launch failure without changing successful launch behavior.
Scope: Start from the newest launch-failure artifact and the affected runtime adapter.
Boundaries: Do not change provider prompts until setup and runtime evidence are inspected.
Coordination: Make one diagnostic task and one fix task if the cause is confirmed.
Verification: Run focused tests and one desktop smoke check when practical.
Review: Lead must inspect the diff before approval.
```

## 複数プロバイダーのブリーフ

チームメイトが異なるプロバイダー/モデルのレーンで動作する場合に使用します。

```text
Outcome: Implement and review a small feature using separate builder and reviewer lanes.
Scope: Builder edits the feature. Reviewer inspects only the task diff and tests.
Boundaries: Do not switch model ids mid-task unless launch fails before work begins.
Coordination: Builder posts result comment first. Reviewer posts findings as task comments.
Verification: Builder runs focused tests. Reviewer checks failure output and changed scope.
Review: Lead approves only after reviewer comments are resolved.
```

## ブリーフ内のエージェントブロック

エージェントブロックとは、`<info_for_agent>...</info_for_agent>` のようなマーカーで囲まれた、エージェント専用の非表示テキストです。アプリは通常の表示からこれらを取り除きますが、エージェントの連携のために利用できる状態を保ちます。人間の読み手にとってはノイズになるが、エージェントに何かを伝える必要がある場合にブリーフで使用してください。

例 - 連携の指示をユーザーに見せることなく、リードに作業の分割方法を伝えるブリーフ:

```text
Outcome: Add a dark mode toggle to the application settings.
Scope: Settings UI, theme context, and CSS variables.
Boundaries: Do not change existing light theme values or provider auth screens.

<info_for_agent>
Split this into three tasks: (1) theme context and CSS vars, (2) toggle component and settings wiring, (3) dark mode preview in existing docs screenshots if practical.
</info_for_agent>
```

このブロックは、人間向けのブリーフをすっきりと保ちつつ、リードに構造化されたタスク分割のガイダンスを与えます。

## 避けるべきこと

| 弱いブリーフ | より良い代替案 |
| --- | --- |
| "Improve the app" | ワークフロー、ファイル、成功の確認方法を明記する |
| "Fix all docs" | 1 つのガイドグループと 1 つのビルドコマンドを選ぶ |
| "Use the best model" | プロバイダー/モデルの選択を明記するか、アプリのデフォルトに任せる |
| "Refactor as needed" | 変更を許可するモジュールを明記する |
| "Make it production ready" | レビュー、テスト、ロールアウトの確認を定義する |

## 起動前に

チームを開始する前に、次の点を確認してください。

1. ブリーフが具体的な成果を明記している。
2. リスクの境界が明示されている。
3. リードが作業をレビュー可能なタスクに分割できる。
4. 分かっている場合は検証コマンドが含まれている。
5. 機微な領域は承認前にレビューを必要とする。

ブリーフがまだ漠然としている場合は、まずソロまたは小規模なチームを起動し、実装ではなくタスク計画を作成するよう依頼してください。

## 関連ガイド

- [チームの作成](/ja/guide/create-team)
- [MCP 連携](/ja/guide/mcp-integration)
- [Git と worktree の戦略](/ja/guide/git-worktree-strategy)
