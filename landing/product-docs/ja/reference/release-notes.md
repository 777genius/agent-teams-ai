---
title: リリースノート – Agent Teams ドキュメント
description: Agent Teams のリリースノートと変更履歴です。詳細は正規の RELEASE.md と CHANGELOG.md へのリンクをご覧ください。
lang: ja-JP
---

# リリースノート

現在のリリース: **v1.2.0**（2026-03-31）。`main` ブランチでは引き続き活発な開発が行われており、メンバーの作業同期、OpenCode 配信の堅牢化、CI の安定化に関する未リリースの変更があります。

## リリースの仕組み

Agent Teams は [セマンティック バージョニング](https://semver.org/) に従っています。リポジトリにプッシュされたタグは、自動の [リリースワークフロー](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) をトリガーし、macOS、Windows、Linux 向けの署名済みパッケージをビルドして、GitHub Releases に公開します。

## 最近のリリース

### v1.2.0 — Agent Graph、チーム単位のツール承認、対話型 AskUserQuestion

力学的レイアウトによる可視化とかんばんタスクレイアウトを備えた Agent Graph、読みやすい権限プロンプトを備えたチーム単位のツール承認コントロール、タスクコメント通知、対話型の AskUserQuestion ボタン。Write/Edit/NotebookEdit のシードと MCP ツールカタログ連携を含む権限システムの全面刷新。詳しくは [変更履歴の全文](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#120---2026-03-31) をご覧ください。

### v1.1.0 — React 19 + Electron 40、ユーザー起点のタスク開始

React 19 + Electron 40 への移行、かんばんボードからのユーザー起点のタスク開始、認証のトラブルシューティングガイド、R/Ruby/PHP/SQL のシンタックスハイライト、3 倍高速化したトランスクリプト検索、WSL/Windows のパス修正、XSS 脆弱性の修正。詳しくは [変更履歴の全文](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#110---2026-03-25) をご覧ください。

### v1.0.0 — 初回の一般公開リリース

最初の安定版ビルド: パッケージ化されたアプリでの CLI/認証の信頼性、IPC の堅牢化、署名済みの macOS ビルドを含むクロスプラットフォームのパッケージング、オープンソースのガバナンス文書（LICENSE、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY）。詳しくは [変更履歴の全文](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md#100---2026-03-23) をご覧ください。

## 正規の情報源

| ドキュメント | 説明 |
| --- | --- |
| [RELEASE.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) | リリースプロセス、バージョニングガイド、成果物の命名、自動更新のセットアップ、リリースノートのテンプレート。 |
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | すべてのバージョンの機能、改善、バグ修正をユーザー視点でまとめた変更履歴の全文。 |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | すべてのプラットフォーム向けのダウンロード可能なインストーラー。 |

## 関連ページ

- [インストール](/ja/guide/installation)
- [クイックスタート](/ja/guide/quickstart)
- [コントリビューター向けアーキテクチャ](/ja/reference/contributor-architecture)
- [開発者向け](/ja/developers/)
