---
title: トラブルシューティング – Agent Teams ドキュメント
description: ローカルの診断情報を使って、チームの起動の問題、エージェントの返信の欠落、レート制限、CLI 認証の問題、レーンのブートストラップの停滞を解決します。
lang: ja-JP
---

# トラブルシューティング

ほとんどのチームの問題は、ランタイムの設定、起動の確認、タスクの解析、プロバイダーの制限という 4 つのカテゴリーのいずれかに分類されます。

## 証拠の素早い準備

チームのライフサイクルに関するあらゆる問題について、まず以下の変数を定義し、同じシェルを再利用してください。

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

次に、UI の状態を解釈する前に、想定されるファイルが存在することを確認します。

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning 証拠を最優先に
動かなくなったバッジだけを根拠に、プロンプト、プロバイダー設定、プロセスのクリーンアップを修正しないでください。まず UI を、永続化されたファイル、起動アーティファクト、ランタイムの証拠と突き合わせてください。
:::

## チームが起動しない

各項目を順番に確認します。

1. **ランタイムが利用可能** — 選択した CLI（`claude`、`codex`、`opencode`）がインストールされている
2. **PATH から到達可能** — そのバイナリが環境の `PATH` で利用できる
3. **モデルへのアクセス** — プロバイダーが、要求したモデル文字列にアクセスできる（特に OpenCode では、正確なプロバイダー名/モデル名が重要です）
4. **プロジェクトパス** — プロジェクトディレクトリが存在し、読み取り可能である
5. **ネットワーク / VPN** — 一部のプロバイダーは VPN が有効なときにトラフィックを遮断します

::: tip
ランタイムのバイナリをターミナルで実行して、`PATH` と認証を確認してください。例: `claude --version` または `opencode --version`。
:::

### OpenCode: registered だがブートストラップが未確認

OpenCode が `registered` を示しているのにブートストラップが未確認の場合は、チームのプロンプトを変更する前に、まずアーティファクトを調査してください。

コントリビューター向け/デバッグの詳細は [コントリビューター向けアーキテクチャ](/ja/reference/contributor-architecture) にあり、正規のエージェントチームデバッグ runbook へのリンクが含まれています。

最新の起動失敗アーティファクトを確認します。

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` は、最新のパックされたアーティファクトディレクトリとその `manifest.json` を指します。このマニフェストには次のものが含まれます。

- `classification` — その起動が失敗とみなされた理由
- `bootstrapTransportBreadcrumb` — 使用された配信経路
- メンバーのスポーン状態
- 編集（マスク）済みのログとトレース

レーンのマニフェストも確認します。

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip UI から推測しないこと
UI の診断情報は、必ず永続化されたファイル（`launch-state.json`、`bootstrap-journal.jsonl`）およびランタイム固有の証拠と突き合わせてください。
:::

## 一般的な診断

UI だけではなく、ディスク上に永続化されたファイルから始めてください。

### チームルート

```bash
printf '%s\n' "$TEAM_DIR"
```

主要なファイルと、それぞれが示す内容は次のとおりです。

- `launch-state.json` — メンバーの起動/生存状態（`.teamLaunchState`、`.summary`、`.members`）
- `bootstrap-journal.jsonl` — CLI/ランタイムからの順序付きブートストラップイベント（`tail -80`）
- `bootstrap-state.json` — ブートストラップフェーズの概要
- `config.json` — プロバイダー、モデル、プロジェクトの設定
- `inboxes/*.json` と `sentMessages.json` — メッセージ配信の状態

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### OpenCode のランタイム証拠

OpenCode のチームメイトについては、セッションの証拠はレーンランタイムストアにあります。

- `.opencode-runtime/lanes.json` — 状態を含むレーンのインデックス
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` と証拠エントリ
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — コミット済みのセッションレコード

想定される正常な状態: レーンの状態が `active`、マニフェストに少なくとも 1 件の証拠エントリを持つ `activeRunId` がある、メンバーが `bootstrapConfirmed: true` である。

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### 起動失敗アーティファクト

起動が失敗としてマークされた場合は、`latest.json` を調査します。

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
```

このマニフェストには次のものが含まれます。
- `classification` — その起動が失敗とみなされた理由
- `bootstrapTransportBreadcrumb` — 使用された配信経路
- メンバーのスポーン状態と、編集（マスク）済みのログ/トレース

## エージェントの返信が欠落している

タスクログとチームメイトのメッセージを開いてください。返信の欠落は、多くの場合次の原因によるものです。

- **ランタイム配信のリトライ** — エージェントは回答したものの、メッセージがアプリに配信されなかった可能性があります。配信台帳を確認してください。
- **解析またはフィルタリング** — エージェントの出力に、想定されるマーカーやタスク参照が含まれていなかった。
- **タスクへの帰属** — セッション中に作業は行われたものの、正しいタスク id が出力に含まれていなかったため、タスクに紐付けられなかった。

::: warning 沈黙＝無視と思い込まないこと
ログで確認できるまで、モデルがメッセージを無視したと思い込まないでください。
:::

永続化されたメッセージの状態を使って、「未送信」と「送信済みだが表示されていない」を切り分けます。

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

`from`、`to`、`messageId`、`relayOfMessageId`、`taskRefs` を確認します。OpenCode のチームメイトについては、モデルがプロンプトを無視したと思い込む前に、ランタイム配信の証拠も調査してください。

## タスクが変更に紐付けられていない

タスク固有のログとコードレビューのリンクを使用します。差分が切り離されているように見える場合は、次を確認します。

- タスク id またはタスク参照がエージェントの出力に含まれていたかどうかを確認する。
- エージェントが編集を行う前に `task_add_comment` を呼び出したかどうかを検証する。
- ボードが作業開始を認識できるよう、エージェントが `task_start` を呼び出したことを確認する。

OpenCode のチームメイトについては、セッションがタスクに属するという確実な証拠は、UI のメッセージストリームだけではなく、`opencode-sessions.json` とレーンのマニフェストエントリにあります。

### タスクログのトリアージ

タスクログが不完全に見える場合は、タスク JSON、受信トレイ、ブートストラップイベントにまたがってタスク id で検索します。

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

結果は慎重に解釈してください。

| 証拠 | 証明できること | 証明できないこと |
| --- | --- | --- |
| メッセージが配信された | アプリがプロンプトを書き込んだか中継した | エージェントが進捗を出した |
| タスクコメント | エージェントがボードに表示されるテキストを投稿した | そのコメントが意味のある進捗である |
| ネイティブツールの行 | ランタイムがセッション内で作業を行った | 帰属が一致しない限り、その作業がこのタスクに属する |
| 変更台帳のエントリ | アプリがファイルの変更を記録した | 実装が正しい |

OpenCode では、正常なタスクログには通常、`read`、`bash`、`edit`、`write` といったネイティブランタイムの行に加えて、Agent Teams の MCP の行が含まれます。`agent-teams_*` の行しか見当たらない場合は、ログのマッチング範囲を広げる前に、タスクへの帰属とセッションの境界を確認してください。

## レート制限

プロバイダーが既知のリセット時刻を報告する場合、Agent Teams はクールダウン後にリードへ続行を促すことができます。リセット時刻が不明な場合は、待機するか、プロバイダー/ランタイムの経路を切り替えてください。

| プロバイダーの挙動 | 推奨される対応 |
| --- | --- |
| 既知のリセット時刻が表示される | クールダウンを待ってから続行する |
| リセット時刻が表示されない | プロバイダーまたはランタイムの経路を切り替える |
| 429 が繰り返される | 並行数を下げるか、別のモデルレーンを使用する |

## CLI 認証の問題

### `claude login` が保持されない

CLI が 1 つのターミナルでは認証されているのに、アプリでは未認証と表示される場合は、認証が想定される設定パスに保存されていること、およびアプリのプロセスが同じ `$HOME` を参照していることを確認してください。

### OpenCode のプロバイダーキーが拒否される

- `config.json` 内のプロバイダー名が、モデル文字列のプロバイダープレフィックスと一致しているか再確認する
- そのキーが、プロバイダーのダッシュボードで失効または取り消されていないことを確認する

### 認証診断ログ

`CliInstallerService.getStatus()` が呼び出されるたびに、Electron のログフォルダー（macOS では通常 `~/Library/Logs/<product-name>/`）内の `claude-cli-auth-diag.ndjson` に 1 行が追記されます。このファイルが **512 KiB** を超えると、次の書き込みの前に空に切り詰められます。

パッケージ化されたアプリで「Not logged in」や認証エラーが表示される場合は、このファイルを確認してください。

## レーンのブートストラップが停滞している

OpenCode のセカンダリレーンについて:

- `inboxes/<member>.json` が存在しないことが、自動的にバグであるとは限りません。OpenCode のレーンは、開始前にプライマリ受信トレイによって作成されている必要はありません。
- プライマリメンバーがすでに使用可能なのに UI でチームがまだ起動中と表示される場合、「all teammates joined」はセカンダリレーンを待っています。
- `Prepared communication channels for X/Y members` が止まる場合は、`Y` に OpenCode のセカンダリメンバーが誤って含まれていないかを確認してください。

### レーンのマニフェストのエントリが空

ブリッジがブートストラップ成功と報告しているのに `manifest.json` が `entries: []` を示している場合、問題はモデルの挙動ではなく **証拠のコミット** にあります。`opencode-sessions.json` とそのマニフェストエントリが存在するまで、メンバーを配信可能とみなしてはなりません。

## メンバーのよくある状態

| 状態 | 意味 |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | 正常で準備完了 |
| `registered` / `runtime_pending_bootstrap` | プロセスまたはレーンは存在するが、ブートストラップの証拠がまだコミットされていない |
| `failed_to_start` + `runtime_process` | プロセスは存在するが、起動ゲートが失敗した。診断情報を確認してください |
| `failed_to_start` + `stale_metadata` | 保存された pid/セッションが古いか、すでに停止している |

::: warning
`member_briefing` だけではランタイムの証拠には**なりません**。OpenCode では、確実な証拠は `opencode-sessions.json` とマニフェストエントリのような、コミット済みのランタイム証拠です。
:::

## ランタイムのデバッグモード

ローカルでのデバッグのために、チームメイトを tmux ペインで実行するよう強制できます。

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

これは対話的な CLI の挙動を調べるために使用します。これがプロセスバックエンドと完全に等価であるとは考えないでください。

## スモークチェック

通常の検証にはデスクトップの Electron アプリを使用してください。ブラウザ/Web の開発モードには、完全なデスクトップランタイム、IPC、プロバイダー認証、ターミナル、チームのライフサイクル挙動は含まれていません。

### ドキュメントのみの変更

リポジトリのルートから:

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### チームライフサイクルの変更

狭い範囲から始めて、徐々に広げます。

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### ライブチームのスモーク

小規模なチームと、Git で追跡している使い捨てのプロジェクトを使用します。

1. `pnpm dev` でデスクトップアプリを起動します。
2. リード 1 名とビルダー 1 名を作成します。
3. 明示的な検証コマンドを添えて、ごく小さな変更を依頼します。
4. タスクが `pending` -> `in_progress` -> `completed` と移動することを確認します。
5. タスクログを開き、ツールの行、タスクコメント、ファイルの変更が整合していることを確認します。
6. クリーンアップの際は、スモーク専用のチーム/プロセスのみを停止します。

::: warning 狭い範囲のクリーンアップのみ
スモーク実行のクリーンアップ中に、すべての OpenCode ホスト、無関係な tmux ペイン、ユーザーのチームを終了しないでください。
:::

## 安全なクリーンアップ

古くなったプロセスをクリーンアップする際は:

1. pid を特定し、それが現在のチーム/レーンに属していることを確認します。
2. スモークテストやデバッグ中の起動に明示的に属するプロセスのみを停止します。
3. 近道として、すべての OpenCode プロセスや共有ホストのプロセスを**終了しない**でください。

## 証拠を収集すべきタイミング

サポートを求める前に、次を収集してください。

- タスク id（短縮形または完全形）
- チーム名
- ランタイムの経路（`claude`、`codex`、`opencode`）
- 起動ログの抜粋（`latest.json` または `bootstrap-journal.jsonl` から）
- プロバイダー / モデル文字列
- 問題が発生した正確な時間帯

通常、このデータがあれば、起動やタスクのライフサイクルの問題をデバッグするのに十分です。

::: tip
問題が解決しない場合は、`~/.claude/teams/<teamName>/` 配下のチームの永続化ファイルを開き、コードを変更する前に UI の診断情報をライブプロセスの状態と突き合わせてください。
:::
