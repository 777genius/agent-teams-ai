---
title: コントリビューター向けアーキテクチャ – Agent Teams ドキュメント
description: 機能のレイアウト、ランタイム/プロバイダーの境界、ハードガードレール、および正規のアーキテクチャドキュメントについてのコントリビューターガイド。
lang: ja-JP
---

# コントリビューター向けアーキテクチャ

このページはコントリビューター向けのマップです。すべての実装ルールを再掲するのではなく、正規のリポジトリガイダンスへの道しるべを示します。

## 正規の情報源

アプリを変更する際は、これらのファイルを信頼できる情報源（source of truth）として使用してください。

| 必要なもの | 正規の情報源 |
| --- | --- |
| リポジトリの概要とコマンド | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| ローカルでの作業規約 | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| ハードガードレール | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| 中規模・大規模機能のレイアウト | [docs/FEATURE_ARCHITECTURE_STANDARD.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| エージェントチームの起動デバッグ | [docs/team-management/debugging-agent-teams.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |

## 機能のレイアウト

中規模・大規模の機能は `src/features/<feature-name>/` の配下に置き、機能アーキテクチャ標準に従ってください。機能の内部実装はパブリックなエントリーポイントの背後に隠し、機能境界をまたぐディープインポートは避けてください。

新規作業では、ローカルのリファレンス実装として既存の `src/features/recent-projects` スライスから始めてください。機能スライスを作成すると価値以上に構造が増えてしまう場合、小さな修正は既存のコードパスの近くに留めても構いません。

## ランタイムとプロバイダーの境界

Agent Teams はオーケストレーションを担います。すなわち、チーム、タスク、メッセージ、起動状態、レビュー UI、診断、およびローカルでの永続化です。

選択されたランタイム/プロバイダーのパスは、モデルの実行、認証、モデルの可用性、レート制限、ツールのセマンティクス、およびランタイム固有のトランスクリプト証跡を担います。認証の欠落、バイナリの欠落、拒否されたモデル ID、またはプロバイダーの障害を、プロンプトや UI の状態で補おうとしないでください。ユーザー向けのセットアップ詳細については、[プロバイダーとランタイム](/ja/reference/providers-runtimes)を参照してください。

## エージェントチームのデバッグ

起動のハング、OpenCode の `registered` / bootstrap-unconfirmed 状態、チームメイトの返信の欠落、または不審なタスクログについては、専用のデバッグ用ランブックから始めてください。`~/.claude/teams/<team>/launch-failure-artifacts/latest.json` 配下にある最新の起動失敗アーティファクトを調べ、次に UI の状態を永続化されたファイルおよびランタイム固有の証跡と突き合わせてください。

デバッグ中の広範囲なクリーンアップは避けてください。問題に属すると特定できるプロセス、レーン、チーム、またはスモークランのみを停止してください。

## コントリビューターの規約

- 通常の開発では、デスクトップ版 Electron アプリに `pnpm dev` を使用してください。
- デスクトップランタイム、IPC、ターミナル、プロバイダー認証、またはチームのライフサイクル挙動の代替として、ブラウザの開発モードを使用しないでください。
- Electron の main、preload、renderer、shared、および機能の責務を分離して保ってください。
- マーカーを手動で連結する代わりに、エージェント専用ブロックには `wrapAgentBlock(text)` を使用してください。
- 焦点を絞った検証を優先してください。タスクが明示的にフォーマットに関するものでない限り、広範囲な `lint:fix` やフォーマットの変更は避けてください。
- パース、タスクのライフサイクル、プロバイダー/ランタイムの検出、永続化、IPC、Git、およびレビューフローは、的を絞ったテストまたは明確な検証パスを必要とする高リスク領域として扱ってください。

## 関連ページ

- [ランタイムの設定](/ja/guide/runtime-setup)
- [トラブルシューティング](/ja/guide/troubleshooting)
- [コードレビュー](/ja/guide/code-review)
- [プライバシーとローカルデータ](/ja/reference/privacy-local-data)
