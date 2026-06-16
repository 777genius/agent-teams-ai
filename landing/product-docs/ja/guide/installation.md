---
title: インストール – Agent Teams ドキュメント
description: macOS、Windows、Linux 向けの Agent Teams をダウンロードしてインストールします。パッケージ済みビルド、ソースからのセットアップ、自動更新、必要要件について説明します。
lang: ja-JP
---

# インストール

Agent Teams は、macOS、Windows、Linux 向けのデスクトップアプリとして配布されています。

::: tip 最短の手順
1. 以下からお使いのプラットフォーム向けのビルドをダウンロードします
2. アプリを起動します。認証不要の無料モデルから始めるか、UI からプロバイダー認証を接続します
3. [クイックスタート](/ja/guide/quickstart) を開始して、最初のチームを作成します

デスクトップアプリの起動: Electron アプリは `pnpm dev` で実行します。通常の利用ではブラウザ/Web の開発モードを起動しないでください。
:::

## ビルドのダウンロード

パッケージ済みアプリが必要な場合は、<a href="/ja/download/" target="_self">ダウンロードページ</a> または最新の [GitHub リリース](https://github.com/777genius/agent-teams-ai/releases) をご利用ください。

- macOS Apple Silicon: `.dmg`
- macOS Intel: `.dmg`
- Windows: `.exe`
- Linux: `.AppImage`、`.deb`、`.rpm`、または `.pacman`

::: warning Windows SmartScreen
署名されていない、または公開されたばかりのオープンソースアプリは、SmartScreen をトリガーすることがあります。リリース元を信頼できる場合は、**More info** を選択し、続いて **Run anyway** を選択してください。
:::

## 必要要件

パッケージ済みアプリは、セットアップ不要のオンボーディングを目的として設計されています。認証不要の無料モデルから始められます。登録、API キー、クレジットカードは不要です。さらに多くのモデルを利用したい場合は、アプリが UI からランタイム検出とプロバイダー認証をガイドします。

有料またはアカウント連携のモデルを利用するには、少なくとも 1 つのプロバイダーを接続してください。

| プロバイダー         | アクセス方法                                       |
| ------------------ | ------------------------------------------------- |
| Claude (Anthropic) | Claude Code CLI ログインまたは API キー             |
| Codex (OpenAI)     | Codex CLI ログインまたは API キー                   |
| Gemini (Google)    | Google ADC、Gemini CLI、または API キー             |
| OpenCode           | 認証不要で同梱されている無料モデル、または対応するバックエンド（例: OpenRouter）向けの API キー |

::: info
Gemini は対応プロバイダーの一つとして利用できます。すべてのプロバイダーにわたる認証オプションと現在のステータスについては、[プロバイダーとランタイム](/ja/reference/providers-runtimes) を参照してください。
:::

ソースからの開発には、さらに以下が必要です。

| ツール   | バージョン  |
| ------- | ------- |
| Node.js | 24.16.0 LTS |
| pnpm    | 10+     |

macOS では、公式の Node.js 24 プリビルドバイナリには macOS 13.5+ が必要です。

## ソースから実行する

<InstallBlock command="git clone https://github.com/777genius/agent-teams-ai.git && cd agent-teams-ai && pnpm install && pnpm dev" label="コピー" copied-label="コピーしました" />

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` は、ホットリロード付きのデスクトップ Electron アプリを起動します。これがデフォルトの開発ターゲットです。通常の開発ではブラウザ Web 開発サーバーを起動しないでください。ブラウザ経路には、完全なデスクトップ IPC、ターミナル、プロバイダー認証、チームライフサイクルの挙動がありません。

`main` ブランチには、最新の安定した開発成果が含まれています。特定の未リリースの変更が必要な場合にのみ、フィーチャーブランチに切り替えてください。

## セットアップの確認

インストール後、ビルドが健全であることを確認します。

```bash
# デスクトップアプリがコンパイルされ、起動することを確認します
pnpm typecheck

# VitePress ドキュメントサイトがビルドされることを確認します
pnpm --dir landing docs:build
```

`pnpm typecheck` が型エラーを報告する場合は、依存関係やピン留めされた TypeScript の新しいバージョンを確認してください。`pnpm --dir landing docs:build` が失敗する場合は、`landing/product-docs/` を調べて、markdown や設定の構文エラーを確認してください。

これらのドキュメントを編集している場合は、ビルドを実行して変更を確認してください。

```bash
pnpm --dir landing docs:build
```

## 自動更新

パッケージ済みアプリは、起動時および実行中に定期的に、更新を自動でチェックします。更新が利用可能になると、アプリがダウンロードとインストールを促します。アプリメニューから手動でチェックすることもできます。

::: tip
ソースから実行している場合、自動更新は利用できません。依存関係が変更されたときは、最新の変更をプルして `pnpm install` を再実行してください。
:::

## ソースからの更新

ソースから実行している場合は、`main` ブランチをプルし、依存関係が変更されたときはインストールを再実行してください。

```bash
git pull
pnpm install
```

更新後、ビルドとドキュメントを確認してください。

```bash
pnpm typecheck
pnpm --dir landing docs:build
```

通常の開発では、ブラウザ開発サーバーではなく、常に `pnpm dev`（Electron）を使用してください。

## 次のステップ

- [クイックスタート](/ja/guide/quickstart) — インストールから最初に稼働するチームまで
- [ランタイムの設定](/ja/guide/runtime-setup) — ランタイムごとのプロバイダー認証とモデル選択
- [チームの作成](/ja/guide/create-team) — 推奨されるチーム構成とブリーフの書き方

### コントリビューター向け

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — リポジトリのナビゲーションとアーキテクチャのポインタ
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 作業上の慣例とプロジェクトのルール
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — 厳格な実装ガードレール
