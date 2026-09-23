---
title: リリースノート – Agent Teams ドキュメント
description: Agent Teams のリリースノートと変更履歴です。詳細は正規の RELEASE.md と CHANGELOG.md へのリンクをご覧ください。
lang: ja-JP
---

# リリースノート

最新の公開リリースは **[v2.15.0](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0)**（2026-09-19）です。最新バージョンとダウンロードは [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) で確認してください。

## リリースの仕組み

Agent Teams は [セマンティック バージョニング](https://semver.org/) に従っています。リポジトリにプッシュされたタグは、自動の [リリースワークフロー](https://github.com/777genius/agent-teams-ai/blob/main/docs/RELEASE.md) をトリガーし、macOS、Windows、Linux 向けのパッケージをビルドして、GitHub Releases に公開します。

## 最新リリース

### v2.15.0 - 作業の再開、1対1のメッセージ、ローカルモデル

チーム画面から停止した作業を再開し、Messages でチームメンバーと1対1で会話できます。追加のローカルモデルを選択し、プロジェクトを選ばずに Ollama をテストできます。ローカルモデルが表示されない問題や、混合チームの停止後に残作業が再開する問題も修正されました。詳細は [v2.15.0 のリリースノート](https://github.com/777genius/agent-teams-ai/releases/tag/v2.15.0) を参照してください。

## 過去のリリース

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
| [CHANGELOG.md](https://github.com/777genius/agent-teams-ai/blob/main/docs/CHANGELOG.md) | 初期リリースの変更履歴。最近のリリースは GitHub Releases を参照してください。 |
| [GitHub Releases](https://github.com/777genius/agent-teams-ai/releases) | すべてのプラットフォーム向けのダウンロード可能なインストーラー。 |

## 関連ページ

- [インストール](/ja/guide/installation)
- [クイックスタート](/ja/guide/quickstart)
- [コントリビューター向けアーキテクチャ](/ja/reference/contributor-architecture)
- [開発者向け](/ja/developers/)
