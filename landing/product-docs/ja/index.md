---
title: Agent Teams ドキュメント – ローカル デスクトップアプリで AI エージェントのチームを動かす
description: AI エージェントのオーケストレーションを行う無料のデスクトップアプリ Agent Teams のドキュメントです。チームを作成し、カンバンボードで作業を見守り、コード変更をレビューし、Claude、Codex、OpenCode、マルチモデルのワークフローを連携させます。
lang: ja-JP
layout: home
hero:
  name: Agent Teams ドキュメント
  text: ローカル デスクトップアプリで AI エージェントのチームを動かす
  tagline: チームを作成し、タスクがカンバンボード上を移動していく様子を見守り、コード変更をレビューし、ローカルでの制御を手放すことなく Claude、Codex、OpenCode、マルチモデルのワークフローを連携させます。
  actions:
    - theme: brand
      text: クイックスタート
      link: /ja/guide/quickstart
    - theme: alt
      text: インストール
      link: /ja/guide/installation
    - theme: alt
      text: コンセプト
      link: /ja/reference/concepts
features:
  - icon: '01'
    title: チームファーストのワークフロー
    details: ロールを定義し、リードを起動して、エージェントがタスクを分割・取得・調整できるようにします。
    link: /ja/guide/create-team
    linkText: チームを作成する
  - icon: '02'
    title: ライブ カンバンボード
    details: エージェントが作業する中で、タスクが todo、in progress、review、done、approved を移動していく様子を見守ります。
    link: /ja/guide/agent-workflow
    linkText: ワークフローを理解する
  - icon: '03'
    title: 組み込みのコードレビュー
    details: タスク単位の差分を確認し、ハンクを承認または却下し、エージェントに方向性が必要な箇所にコメントします。
    link: /ja/guide/code-review
    linkText: 変更をレビューする
  - icon: '04'
    title: ランタイムを意識したセットアップ
    details: すでにお持ちのアクセス権を通じて、Claude、Codex、OpenCode、またはマルチモデルのプロバイダーを利用します。
    link: /ja/guide/runtime-setup
    linkText: ランタイムを設定する
  - icon: '05'
    title: ローカルファーストの制御
    details: デスクトップアプリはローカルのプロジェクトとランタイムの状態を読み取ります。選択したプロバイダーがプロンプトのコンテキストを受け取らない限り、コードはお使いのマシンに留まります。
    link: /ja/reference/privacy-local-data
    linkText: プライバシーモデル
  - icon: '06'
    title: デバッグ可能なチーム
    details: 起動やタスクが行き詰まったときに、タスクログ、ランタイム出力、チームメイトのメッセージ、ライブプロセスをトレースします。
    link: /ja/guide/troubleshooting
    linkText: トラブルシューティング
---

<InstallBlock label="コピー" copied-label="コピーしました" />

## はじめに

Agent Teams は、AI エージェントのチームをオーケストレーションするための無料のデスクトップアプリです。単一のエージェントに孤立したプロンプトを送るだけではありません。チームを作成し、ロールを割り当て、エージェントがタスクボードを通じて作業を調整する様子を見守ります。

<DocsCardGrid />

## 起動後の次のステップ

最初のチームを作成したら、さらに先へ進むために次のガイドを参照してください。

- **ランタイムの設定** - Claude、Codex、OpenCode、またはマルチモデルのプロバイダーを設定します: [ランタイムを設定する](/ja/guide/runtime-setup)
- **エージェントのワークフロー** - エージェントがタスクボードを通じてどのように調整するかを理解します: [ワークフローを理解する](/ja/guide/agent-workflow)
- **チームブリーフの例** - 実際のブリーフからプロンプトのパターンを学びます: [例を見る](/ja/guide/team-brief-examples)
- **コードレビュー** - 差分を確認し、変更を承認または却下します: [変更をレビューする](/ja/guide/code-review)
- **トラブルシューティング** - 行き詰まった起動、不在のチームメイト、タスクの失敗を診断します: [トラブルシューティング](/ja/guide/troubleshooting)
- **Git と worktree の戦略** - 複数のチームメイトが同じリポジトリを並行して編集する場合に worktree による分離を利用します: [worktree について学ぶ](/ja/guide/git-worktree-strategy)
- **リリースノート** - 各バージョンの新機能を確認します: [リリースを見る](/ja/reference/release-notes)

## リファレンス

正確な用語、プロバイダーの動作、コントリビューター向けアーキテクチャ、プライバシーの境界が必要なときは、リファレンスページを参照してください。

<DocsCardGrid type="reference" />

## 製品プレビュー

<ZoomImage src="/screenshots/product-preview.png" alt="Agent Teams のカンバンボード" caption="タスクのステータス、チームメイトのアクティビティ、レビューのワークフローが、ひとつのワークスペースで常に見える状態に保たれます。" />
