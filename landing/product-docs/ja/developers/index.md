---
title: 開発者ハブ – Agent Teams ドキュメント
description: Agent Teams のアーキテクチャ、ガードレール、デバッグ、MCP による拡張方法に関する、コントリビューターと開発者向けの入口です。
lang: ja-JP
---

# 開発者ハブ

Agent Teams 自体を変更したい場合、チームの起動をデバッグしたい場合、または MCP ツールでランタイムを拡張したい場合は、このページを参照してください。以下のリンクは正規のリポジトリドキュメントを指しており、実装ルールが一箇所にまとまるようになっています。

## はじめに

| 必要なこと | 参照先 |
| --- | --- |
| リポジトリの概要、スクリプト、ソースのセットアップ | [README.md](https://github.com/777genius/agent-teams-ai/blob/main/README.md) |
| エージェントのナビゲーションとアーキテクチャの索引 | [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) |
| エージェントとコントリビューターのための作業規約 | [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) |
| 厳格な実装ガードレール | [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) |
| 中規模および大規模な機能の構成 | [機能アーキテクチャ標準](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) |
| 起動、ブートストラップ、チームメイトのメッセージングのデバッグ | [エージェントチームのデバッグ用ランブック](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) |
| コントリビューションのプロセス | [コントリビューションガイド](https://github.com/777genius/agent-teams-ai/blob/main/.github/CONTRIBUTING.md) |
| リリースノート / 変更履歴 | [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) — [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) |

## ローカル開発の手順

通常の開発では、デスクトップ版の Electron アプリを実行します。

```bash
pnpm install
pnpm dev
```

ブラウザ/Web 版はデスクトップランタイムの代替にはなりません。デスクトップモードがサポートされたローカルの手順です。これには IPC、ターミナル、プロバイダー認証、チームのライフサイクル処理、起動診断、そして実際のチームで使われるランタイムブリッジが含まれているためです。

## アーキテクチャのチェックポイント

機能を変更する前に、その境界を特定してください。

| 領域 | 想定される配置場所 |
| --- | --- |
| 中規模または大規模なプロダクト機能 | `src/features/<feature-name>/` |
| Electron メインプロセスのオーケストレーション | `src/main/` |
| preload で安全な API サーフェス | `src/preload/` |
| レンダラーの UI とアプリの状態 | `src/renderer/` |
| 共有の型と純粋なヘルパー | `src/shared/` |
| Agent Teams ボードの MCP サーバー | `mcp-server/` |
| ボードのデータコントローラー | `agent-teams-controller/` |

機能の構成については、`src/features/recent-projects` をリファレンスとなるスライスとして使用してください。プロセス間のコントラクトは明示的に保ち、機能の境界をまたいだ深いインポートは避けてください。

## デバッグの手順

起動のハング、OpenCode の `registered` / bootstrap-unconfirmed 状態、チームメイトの返信の欠落、または不審なタスクログが発生した場合は、次の手順に従ってください。

1. [デバッグ用ランブック](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) から始めます。
2. `~/.claude/teams/<team>/launch-failure-artifacts/latest.json` にある最新のアーティファクトパックを確認します。
3. アーティファクトの `manifest.json` を開き、`classification`、ブートストラップのブレッドクラム、起動診断、メンバーのスポーン状態、伏字処理されたログの末尾を確認します。
4. スモークテストまたは失敗した起動が所有していると特定できるチーム、実行、ペイン、プロセスのみをクリーンアップします。

## MCP 開発の手順

Agent Teams は、ボード操作のために `agent-teams` という名前の組み込み MCP サーバーを使用します。ユーザーおよびプロジェクトの MCP サーバーは、ランタイムに外部機能を追加できます。セットアップの例、`.mcp.json` の構造、ツール登録のガイダンスについては、[MCP 連携](/ja/guide/mcp-integration) を参照してください。

## 関連ドキュメント

- [コントリビューター向けアーキテクチャ](/ja/reference/contributor-architecture)
- [ランタイムの設定](/ja/guide/runtime-setup)
- [MCP 連携](/ja/guide/mcp-integration)
- [トラブルシューティング](/ja/guide/troubleshooting)
