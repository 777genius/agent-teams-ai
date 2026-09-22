---
title: クイックスタート – Agent Teams ドキュメント
description: 新規インストールから稼働中の AI エージェントチームまでを数分で立ち上げます。インストール、ランタイムの選択、チームの作成、最初のコードレビューを扱います。
lang: ja-JP
---

# クイックスタート

このガイドでは、新規インストールから稼働中のチームまでを数分で立ち上げます。

## 最短ルート

```bash
# 1. Install prerequisites
node --version    # need 20+
pnpm --version    # need 10+

# 2. Clone and install
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install

# 3. Start the desktop app (default workflow)
pnpm dev

# 4. Verify a docs-only change
pnpm --dir landing docs:build
```

デスクトップ版の Electron アプリ（`pnpm dev`）が主要なターゲットです。通常の開発ではブラウザ/Web 開発サーバーを使用しないでください。ブラウザ経由のパスには、デスクトップ IPC、ターミナル、プロバイダー認証、チームのライフサイクル動作がありません。

## はじめる前に

必要なもの:

- **コンピューター** — macOS、Windows、または Linux で動作するもの
- **（推奨）Git で追跡されているプロジェクト** — worktree の分離や差分レビューは Git に依存します
- **（任意）プロバイダーアクセス** — ランタイムの設定では UI から利用可能なプロバイダーを検出しますが、一部のパスには既存の認証（Anthropic、OpenAI など）が必要です

以下の手順がうまくいかない場合は、[トラブルシューティングガイド](/ja/guide/troubleshooting#team-does-not-launch)で一般的な対処法を確認してください。

プロジェクトの規約やアーキテクチャに関するガイダンスについては、変更を加える前にこれらの正規ファイルを参照してください:

- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — リポジトリのナビゲーションとアーキテクチャの指針
- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 作業上の規約とプロジェクトのルール
- [機能アーキテクチャ標準](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — 新機能の構成
- [デバッグ用ランブック](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — 起動とチームメイトの診断

## 1. ソースから実行する、またはダウンロードする

**パッケージ済みアプリをダウンロード**して、macOS、Windows、または Linux 向けに<a href="/ja/download/" target="_self">ダウンロードページ</a>から入手できます。前提条件は不要です。認証なしの無料モデルから始めることも、より多くのモデルを使いたいときに UI からプロバイダー認証を接続することもできます。

**または開発用にソースから実行**します:

Node.js 24.16.0 LTS と pnpm 10+ が必要です。macOS では、公式の Node.js 24 のプレビルドバイナリは macOS 13.5+ を必要とします。

```bash
git clone https://github.com/777genius/agent-teams-ai.git
cd agent-teams-ai
pnpm install
pnpm dev
```

`pnpm dev` は、ホットリロード付きのデスクトップ版 Electron アプリを起動します。これがデフォルトの開発ターゲットです。通常の開発ではブラウザ Web 開発サーバーを起動しないでください。ブラウザ経由のパスには、完全なデスクトップ IPC、ターミナル、プロバイダー認証、チームのライフサイクル動作がありません。

## 2. プロジェクトを開く、または作成する

アプリを起動し、エージェントに作業させたいプロジェクトディレクトリを選択します。Agent Teams はローカルのプロジェクトファイルとランタイム/セッションの状態を読み取り、UI 上でタスク、ログ、差分、チームメイトのアクティビティを表示できるようにします。

::: tip
最良の体験を得るには、Git で追跡されているプロジェクトを選んでください。worktree の分離と差分ベースのレビューはどちらも Git に依存します。
:::

チームを起動する前に、プロジェクトが十分にクリーンなベースラインを持っているか確認してください:

```bash
git status --short
```

完全にクリーンなツリーである必要はありませんが、エージェントが編集を始める前に、どの変更が自分のものかを把握しておくべきです。これにより、タスクの差分やハンク単位のレビューがはるかに信頼しやすくなります。

## 3. ランタイムのパスを選ぶ

セットアップフローは、マシンにインストールされているランタイムを自動検出します。最初によく使われるセットアップは次のとおりです:

| ランタイム | 適した用途                                       |
| -------- | ----------------------------------------------- |
| Claude   | Claude Code ユーザーや既存の Anthropic アクセス |
| Codex    | Codex ネイティブのワークフローや OpenAI アクセス        |
| OpenCode | 認証なしの無料モデル、マルチモデルチーム、多数のプロバイダーバックエンド |


各プロバイダーの詳細な設定については、[ランタイムの設定](/ja/guide/runtime-setup)を参照してください。

有料またはアカウントに紐づくランタイムをアプリの外で検証するには、バイナリを確認し、認証をテストします:

```bash
# Check that the runtime is installed and on PATH
command -v claude && claude --version
command -v codex && codex --version
command -v opencode && opencode --version
```

コマンドが失敗する場合は、まずランタイムのインストールまたは `PATH` を修正してください。バイナリが見つからない場合や、それを必要とするモデルのプロバイダー認証が欠けている場合、チームのプロンプトでは回避できません。

::: tip
バイナリは見つかるのにアプリが「not logged in」と報告する場合、ターミナルとアプリで環境が異なっている可能性があります。両者を比較するには、[認証診断ログ](/ja/guide/troubleshooting#auth-diagnostic-log)を参照してください。
:::

## 4. 最初のチームを作成する

リードと 1 名以上のスペシャリストでチームを作成します。最初のチームは小さく保ってください。リード 1 名、実装エージェント 1 名、レビュー担当エージェント 1 名で、ワークフローを検証するには十分です。

推奨される構成とヒントについては、[チームの作成](/ja/guide/create-team)を参照してください。

最初の起動では、次のようなチーム構成が望ましいです:

| メンバー | 担当 | 備考 |
| --- | --- | --- |
| Lead | ゴールをタスクに分割し、ステータスを調整する | 手持ちの最も信頼できるプロバイダーに割り当てる |
| Builder | スコープが定まったタスクを実装する | ファイルや機能の明確な境界を与える |
| Reviewer | 完了した作業をレビューする | リグレッションと不足しているテストに注目するよう依頼する |

最初から 5 名以上のチームメイトで始めるのは避けてください。エージェントが増えると、セットアップが健全だと確認できる前に、並行処理、ログ、プロバイダー使用量、競合のリスクが増大します。

## 5. リードに具体的なゴールを与える

エンジニアリングリードに指示を出すのと同じようにゴールを書きます:

```text
Improve the onboarding flow. Split the work into tasks, keep changes small, and ask for review before broad refactors.
```

優れた最初のプロンプトには、具体的なスコープ、安全のための境界、検証が含まれます:

```text
Improve the docs quickstart. Keep edits inside landing/product-docs. Add practical examples, preserve existing VitePress syntax, and run `pnpm --dir landing docs:build` before marking tasks done.
```

最初の実行では、「アプリをもっと良くして」のような曖昧なプロンプトは避けてください。リードは大きなゴールを分解できますが、より良い入力ほど、より小さなタスクとよりクリーンなレビューを生み出します。

::: tip
チームは起動するのにタスクが表示されない場合は、リードがあなたのプロンプトを受け取ったかどうかを確認してください。診断については、[エージェントの返信が見当たらない](/ja/guide/troubleshooting#agent-replies-are-missing)を参照してください。
:::

リードはタスクを作成し、作業を割り当て、チームメイトを調整します。進捗はかんばんボードで確認でき、いつでもコメントやダイレクトメッセージで介入できます。

## 6. 結果をレビューする

完了したタスクやレビュー可能なタスクを開き、差分を確認して、個々の変更を承認、却下、またはコメントします。エージェントがなぜその選択をしたのかを理解する必要がある場合は、タスクログを使用してください。

レビューの完全なワークフローについては、[コードレビュー](/ja/guide/code-review)を参照してください。

最初のタスクを承認する前に、次の 3 点を確認してください:

1. タスクコメントが何を変更したかを説明している
2. 変更されたファイルがタスクのスコープと一致している
3. 検証結果がタスクコメントまたはログで確認できる

## よくある落とし穴

| 症状 | 考えられる原因 | 確認すること |
| --- | --- | --- |
| アプリがランタイムを検出しない | バイナリが `PATH` 上にない、またはアプリとターミナルで異なる環境が見えている | ターミナルで `command -v <runtime>` を実行し、同じターミナル環境を使ってアプリを起動する |
| チームの起動が止まる | 有料/アカウントモデルのプロバイダー認証が欠けている、モデル文字列が間違っている、またはランタイムバイナリが見つからない | [トラブルシューティング](/ja/guide/troubleshooting#team-does-not-launch)を参照 |
| OpenCode レーンが `registered` のまま止まる | レーンのエビデンスがまだコミットされていない、またはモデル文字列の不一致 | `~/.claude/teams/<team>/.opencode-runtime/lanes/` を確認する |
| エージェントの返信が見当たらない | ランタイム配信のリトライ、パース、またはタスク帰属の問題 | タスクログを開き、配信台帳を確認する |
| プロバイダーが 429 を返す | レート制限に達した | リセットを待つか、モデル/プロバイダーを切り替える |

## 次のステップ

- [チームの作成](/ja/guide/create-team) — 推奨されるチーム構成とブリーフの書き方
- [ランタイムの設定](/ja/guide/runtime-setup) — プロバイダー認証とモデルの選択
- [コードレビュー](/ja/guide/code-review) — レビュー、承認、または変更のリクエスト

### コントリビューター向け

Agent Teams またはこのドキュメントを変更する場合は、リポジトリのルートにある正規のプロジェクトファイルから始めてください:

- [CLAUDE.md](https://github.com/777genius/agent-teams-ai/blob/main/CLAUDE.md) — 作業上の規約とプロジェクトのルール
- [AGENTS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENTS.md) — アーキテクチャと実装ガイダンスのためのナビゲーション層
- [AGENT_CRITICAL_GUARDRAILS.md](https://github.com/777genius/agent-teams-ai/blob/main/AGENT_CRITICAL_GUARDRAILS.md) — 実装の厳格なガードレール
- [機能アーキテクチャ標準](https://github.com/777genius/agent-teams-ai/blob/main/docs/FEATURE_ARCHITECTURE_STANDARD.md) — 新機能の構成
- [エージェントチームのデバッグ用ランブック](https://github.com/777genius/agent-teams-ai/blob/main/docs/team-management/debugging-agent-teams.md) — 起動、ブートストラップ、チームメイトの診断

このドキュメントサイトが正しくビルドされることを確認するには:

```bash
pnpm --dir landing docs:build
```
