# TypeScript 移行計画

本ドキュメントは lm-misskeyutils を Python から TypeScript へ全面移行するための実行計画である。
実装は別セッション（人間または AI エージェント）が本ドキュメントだけを手掛かりに着手できることを目標に、
「引き継ぐべき挙動」「決定済み事項」「未決事項」を分けて記述する。

旧計画（Python のまま 7 ステージでリファクタリングする案）は本ドキュメントで置き換える。旧計画の現状分析は事実として正しかったが、
前提が以下のとおり変わったため実行しない。差分は末尾「旧計画からの変更点」を参照。

## 0. 進捗（2026-09-05 時点）

`refactoring` ブランチ上で Phase ごとに 1 コミットとして実施した（セッションの制約により `ts/phase-N-<topic>` ブランチ・個別 PR ではなく単一ブランチに積んでいる。PR 分割が必要なら各コミットを cherry-pick する）。

| Phase | 状態 | 備考 |
|---|---|---|
| 0 凍結と準備 | 完了 | `days_expire.py` に `reactionCount` 最小パッチ。タグ `python-final` は**ローカル作成のみ**（別 ref への push 権限がないため）→ `git push origin python-final` が必要。ゴールデンデータ `packages/core/test/fixtures/evaluate-rules/`（160 ノート、由来は同ディレクトリの README） |
| 1 モノレポ骨格 | 完了 | pnpm workspace、`tsc -b`、Biome、vitest。GitHub Actions のワークフローは push 資格情報に `workflow` スコープが無く `.github/workflows/` へ置けなかったため `ci/github-workflow-ci.yml` に置いてある（`ci/README.md` の手順で移動して有効化する）。core の制約（3.2）は Biome の `noNodejsModules` / `noRestrictedGlobals` と、`Date.now()` 等を検査するテスト（`packages/core/test/constraints.test.ts`）で機械検査 |
| 2 core 実装 | 完了 | 全モジュールをテスト付きで実装（109 テスト、ゴールデンデータ一致を確認） |
| 3 CLI 実装 | 実装は完了。**実サーバーでの同等性確認はマージ前に実施**（未実施） | このセッションからは実サーバーに接続できない。手順は 4.3 のとおり: 同一アカウント・同一 `deleterule.json` で Python 版（`git checkout python-final` して `fake_step4` 有効化）と `node packages/cli/dist/main.js days-expire --dry-run` を実行し、削除候補 id 集合を比較する。ローカルの偽 Misskey サーバー（429 + Retry-After、削除時 400、未知ユーザー）に対する疎通確認は実施済み |
| 4 切り替えと Python 削除 | 完了（同等性確認はマージ前に実施する方針） | README 全面更新、`.env.example` 更新、`*.py` / `Pipfile` / `setup.cfg` を削除。Python 版は `python-final` タグで辿れる。ゴールデンデータ生成スクリプト `generate_golden.py` は由来の記録として残した（Python ファイル削除後は動かない） |
| 5 Web | スコープ外 | |

### 実装中に決めたこと（計画からの差分）

- **429 の `reset` 単位（未決事項 1）**: 両対応の判定を入れた。優先順は `Retry-After` ヘッダ → `error.info.resetSec`（相対秒）→ `error.info.resetMs`（相対ミリ秒）→ `error.info.reset`（1e12 超なら epoch ミリ秒、1e9 超なら epoch 秒、それ以外は相対秒）。実サーバーのログで単位が確定したら `rateLimitWaitSeconds` を単純化してよい。
- **400 の判別方法**: misskey-js の `APIClient` は HTTP ステータスを呼び出し側に渡さないため、`withRetry` が 4xx 応答の `error` に `httpStatus` を付与して返す。フローは `getHttpStatus(err) === 400` で判定する。
- **削除時のエラー扱い**: 400 に限らず API エラーは 1 件ずつログして続行（Python 版と同じ）。リトライ上限超過と中断（AbortSignal）は処理を止める。
- **mute / block にも `--dry-run`** を付けた（書き込み系コマンドは全て dry-run 可能にする方針の延長）。
- **`.env` 指定オプションは `--dotenv <path>`**: `--env-file` は Node 自身がスクリプト引数からも横取りする（`node main.js --env-file x` が Node のオプションとして解釈される）ため。
- **`pollBase` の呼び出し単位上書き**: `RetryPolicy.pollBaseOverrides`（既定 `{ 'users/show': 0 }`）としてエンドポイント単位で指定する。
- 6.1 の API 定義突き合わせスクリプトは任意タスクのため未実施。

## 1. 背景と方針決定

### 1.1 プロジェクトの経緯

- 本プロジェクトの当初の動機は `net_runner` のバックオフ戦略にあった。かつて Misskey は 429 応答に待機秒数を含めておらず、
  自前の指数バックオフなしには大量処理を継続できなかった。
- 現在の Misskey は 429 応答に `Retry-After` ヘッダと本体 `error.info.reset` を返すため、この動機は薄れている。
- 一方で、同じ機能を **Web フロントエンドのみで実現する計画** が別途進行している。バッチ処理自体は今後も使い続けたい。

### 1.2 決定事項

| 項目 | 決定 |
|---|---|
| 言語 | 全コードを TypeScript に移行する。Python コードは移行完了後に削除する |
| 構成 | pnpm workspace のモノレポ。`packages/core`（環境非依存の共有ロジック）と `packages/cli`（Node 向けバッチ）から始め、Web は後日 `packages/web` として同じ core を利用する |
| API クライアント | `misskey-js`（npm、Misskey 公式 SDK）を使う。自前の API バインディングは書かない |
| バックオフ | 旧バージョンの Misskey が動いているインスタンスを考慮し、`Retry-After` / `reset` が得られない場合の **フォールバックとして指数バックオフを残す** |
| リトライの実装位置 | `APIClient` に注入する `fetch` のラッパーとして実装する。これによりブラウザと Node で完全に同一のコードが動く |
| 安全性 | 削除系コマンドは `--dry-run` を CLI オプションとして持つ。コードのコメントアウトによる切り替えは廃止 |
| 既知バグ | `reactionCount` キー不一致（後述 2.4）は移植時に修正する。バグをそのまま移植しない |

### 1.3 スコープ外

- Web フロントエンド本体の実装。ただし core は Web から使える制約（3.2）を最初から満たす。
- Python 版の構造改修。Python 版は凍結する（Phase 0）。

## 2. Python 版から引き継ぐ知識

移植先セッションは Python コードを読める前提だが、読み落としやすい運用知識と落とし穴をここに固定する。

### 2.1 現行ファイルと役割

| ファイル | 行数 | 役割 | 移植先 |
|---|---|---|---|
| `limitmanage.py` | 400 | 設定読込、ロギング初期化、urllib API バインディング、`net_runner`（リトライ） | core の `retry/`、cli の `config`・`logger`。API バインディングは misskey-js に置き換え |
| `days_expire.py` | 266 | ノート一括削除（ルール検証、列挙、エクスポート JSON マージ、判定、削除） | core の `rules/`・`notes/`・`export/`、cli の `days-expire` コマンド |
| `mute_from_list.py` | 37 | ユーザー名リストからミュート | core の `users/`、cli の `mute-from-list` |
| `block_from_list.py` | 37 | 上と完全重複。API 呼び出しとファイル名だけ違う | 同上を共通化し `block-from-list` |

### 2.2 死んでいるコード（移植しない）

- `limitmanage.py` の `getNotes` / `getNotesShow` / `getFile` / `getFolder` / `getAttachedNote` / `updateFile` / `createFolder` はどこからも呼ばれていない。
- `Pipfile` の `websockets` は未使用。
- `limitmanage.py:319` の `handler.terminator = '\n'` は HTTPHandler に属性を付けているだけで無意味。

実際に使われている Misskey エンドポイントは次の 5 つだけである。

| エンドポイント | 用途 | 呼び出し元 |
|---|---|---|
| `i` | 自分の userId と `pinnedNotes` を取得 | days_expire step1 |
| `users/notes` | 自分の全ノートを `untilId` でページング列挙（`limit: 100`, `includeReplies: true`）。**注意**: 現行 Misskey のパラメータは `withReplies` / `withRenotes` / `withChannelNotes` であり `includeReplies` は存在しない（misskey-js の型で確認済み）。詳細は 2.8 | days_expire step2 |
| `notes/delete` | ノート削除。成功は HTTP 204 | days_expire step4 |
| `users/show` | `username` + `host` から userId を解決 | mute/block |
| `mute/create` / `blocking/create` | ミュート / ブロック | mute/block |

### 2.3 `net_runner` の挙動（リトライ仕様の元）

| 状況 | 現行の挙動 | 備考 |
|---|---|---|
| 成功 | `LM_POLL_BASE`（既定 3 秒）待ってから返す | 呼び出し側が `wait=0` を渡すと待たない（ユーザー名解決で使用） |
| 429 かつ `Retry-After` ヘッダあり | `Retry-After + LM_POLL_BASE` 秒待って再試行 | ヘッダは整数秒として解釈 |
| 429 かつヘッダなし | 本体 `error.info.reset` を **ログに出すだけ** で待機時間には使っていない。指数バックオフ（初回 `LM_POLL_RATELIMIT_BASE`=600 秒、以降 2 倍、上限 `LM_POLL_RATELIMIT_MAX`=43200 秒）で待つ | `reset` は epoch 秒として日時変換してログ出力している |
| 400 かつ `raise400=True` | `LM_POLL_BASE` 待って例外を送出 | days_expire の削除で使用。step4 側で捕捉してログのみ |
| 400 かつ `raise400=False` | 「前回成功したが応答が届かなかった可能性」とみなし、**成功扱いで抜ける** | mute/block で使用。存在しないユーザー、既にミュート済み等を握りつぶす意図 |
| その他 4xx | 例外を送出 | パラメータ不正とみなし中断 |
| 5xx | `LM_POLL_NETERROR`（既定 300 秒）待って再試行。回数無制限 | |
| 接続エラー（`URLError`） | **再試行されず即例外**。`.env` の「network error 時の待機」というコメントは実態と異なる | 移植時は 5xx と同様に再試行対象にする |
| `sleepseconds(sec)` | `range(1, sec)` のため実際は `sec-1` 秒しか待たない。stderr にカウントダウン表示 | 移植時は正確に `sec` 秒待つ |

その他の落とし穴:

- `days_expire.py` の step1（`getI`）は `net_runner` を通っていない。起動直後の 429 でそのまま落ちる。移植版は全呼び出しをリトライ経由にする。
- `LM_BASE_URL` は `https://misskey.io/api` のように **`/api` を含む**。misskey-js の `origin` は `https://misskey.io` であり `/api/` を自動付与するため、設定の互換処理が必要（5.1）。

### 2.4 削除ルール判定（`step3`）の仕様

ルールは `deleterule.json` の配列で、`day` 昇順にソートしてから評価する。各ノートについてルールを順に見て、**最初に合致したルールで削除対象にする**。
1 つのルールに対する判定は次の順序で、いずれかの「保護条件」に当たればそのルールでは削除せず次のルールへ進む。

1. `createdAt + day 日 < now` でなければ、そのルールは対象外（次のルールへ）。
2. `pinned: true` かつノートがピン留め → 保護。ピン留め判定は `i` の `pinnedNotes` の id 集合による。
3. `renote: true` かつ `note.renoteId != null` → 保護。
4. `reply: true` かつ `note.replyId != null` → 保護。
5. `inChannel: true` かつ `note.channelId != null` → 保護。
6. `renoteCount` が指定され、`note.renoteCount >= rule.renoteCount` → 保護。
7. `repliesCount` が指定され、`note.repliesCount >= rule.repliesCount` → 保護。
8. `reactionCount` が指定され、`note.reactionCount >= rule.reactionCount` → 保護。
9. ここまで保護されなければ削除対象。ルール評価を打ち切る。

注意点:

- **既知バグ**: 現行コードはルール側・ノート側とも `reactionsCount`（複数形）を参照しているが、`deleterule.json` と README は `reactionCount`、
  Misskey の Note 型（misskey-js `autogen/types.d.ts`）も `reactionCount` である。したがって現行ではリアクション数による保護が一切効いていない。
  移植版は両側とも `reactionCount` に統一する。
- 比較は `>=`（しきい値以上で保護）。README の「if more than counts」は不正確なので、README 更新時に「以上」と明記する。
- 未指定のカウント条件は「保護しない」（`sys.maxsize` 既定）と等価。
- 日数比較は UTC の `now` で行う。`createdAt` は ISO 8601（タイムゾーン付き）。

### 2.5 エクスポート JSON とのマージ（`step2.2`）

- API の `users/notes` が取りこぼすノートを補うため、`exported_files/notes-*.json`（Misskey のノートエクスポート）のうち
  ファイル名の辞書順で最新のものを読み、id でマージする。重複時は API 側のデータを優先する。
- 形式は「ノートの配列」または `{ notes: [...] }` の両方を受け付ける。それ以外は警告して無視。
- **意味論上の注意**: Misskey のエクスポート形式には `renoteCount` / `repliesCount` / `reactionCount` が含まれない。
  そのためエクスポートにしかないノートはカウント条件で保護されず、日数と pinned / renote / reply / inChannel だけで判定される。
  これは現行の挙動であり、移植版もいったん踏襲するが、対象ノート数を警告ログに出す（未決事項 8 参照）。
- エクスポートにしかないノートがサーバー上で既に削除済みの場合、`notes/delete` は 400 を返す。現行は 1 件ずつ例外ログを出して続行する。移植版も同じ。

### 2.6 ユーザー名リスト処理（mute / block）

- 入力ファイルは 1 行 1 ユーザー。空行は無視。`name` または `name@host` 形式。
- `@name@host`（先頭 @ 付き）は現行では正しく解析できない（`split('@')` の先頭要素が空になる）。移植版は先頭 `@` を許容する。
- userId 解決は `wait=0`、`raise400=False`（解決できないユーザーは `id` が `None` のまま続行）。
- ミュート / ブロック実行は `raise400=False`（既に実施済みでも成功扱い）。`expiresAt` は現行では常に null（無期限）。

### 2.8 `users/notes` のパラメータ名不一致（移植時に要対応）

- Python 版は `users/notes` に `includeReplies: true` を送っているが、現行 Misskey の `users/notes` にこのパラメータは無く、
  `withReplies` / `withRenotes` / `withChannelNotes` / `withFiles` である（misskey-js 2026.7.0 の型定義で確認。`includeReplies` を渡すと tsc がエラーにする）。
- Misskey は未知のパラメータを無視するため、現行では **リプライが列挙されていない** 可能性が高い。さらに `withChannelNotes` の既定は false のため、
  チャンネル投稿も列挙されていない可能性がある（既定値は Misskey 実装で要確認）。
- `days_expire.py` 冒頭の「API がノートを取りこぼすことがあるのでエクスポート JSON とマージする」（2.5）は、この取りこぼしへの対症療法だった可能性がある。
- 移植版は `withReplies: true, withRenotes: true, withChannelNotes: true` を明示して列挙する。Phase 3 の同等性確認で
  「API 列挙だけで全ノートが揃うか」を件数で検証し、揃うならエクスポートマージを廃止候補にする（未決事項 7）。
- この件は misskey-js の型定義があったからこそ検出できた。Phase 2 以降、API 呼び出しは必ず型付きの `client.request()` を通す。

### 2.7 設定値（`.env`）

| 変数 | 既定 | 用途 |
|---|---|---|
| `LM_BASE_URL` | なし（必須） | API エンドポイント。`/api` を含む |
| `LM_API_TOKEN` | なし（必須） | アクセストークン。全リクエストの本体 `i` に載る |
| `LM_POLL_BASE` | 3 | 成功後の待機秒 |
| `LM_POLL_NETERROR` | 300 | 5xx 後の待機秒 |
| `LM_POLL_RATELIMIT_BASE` | 600 | 429 フォールバック時の初回待機秒 |
| `LM_POLL_RATELIMIT_MAX` | 43200 | 同上の上限 |
| `LM_LOGLEVEL` | INFO | ログレベル |
| `LM_LOGFILE` / `LM_LOGFILENAME` | False / limitmanage.log | ファイル出力の有無と名前。True のときコンソールにも出す |
| `LM_LOG_TIMEZONE` | Asia/Tokyo | ログ内の日時表示用タイムゾーン |
| `LM_DEBUGLEVEL` | 0 | urllib の HTTP デバッグ出力。**トークンを含む本体がそのまま出る** |
| `LM_USERAGENT` | ブラウザ UA 文字列 | User-Agent |
| `LM_DELETERULE` | deleterule.json | ルールファイルのパス |
| `LM_DELETE_STEP2PRINT` | False | True で全ノートの JSON を stdout に出す（バックアップ用途） |

## 3. 目標アーキテクチャ

### 3.1 リポジトリ構成

```
.
├── package.json              # pnpm workspace ルート。scripts: build / test / lint / typecheck
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── .github/workflows/ci.yml
├── packages/
│   ├── core/                 # @lm/core  環境非依存の共有ロジック
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts     # misskey-js APIClient の生成（fetch ラッパーを注入）
│   │   │   ├── retry/        # fetch ラッパーと待機時間計算
│   │   │   ├── rules/        # zod スキーマと evaluate()
│   │   │   ├── notes/        # 列挙（async generator）、削除フロー
│   │   │   ├── export/       # エクスポート JSON の解釈とマージ
│   │   │   ├── users/        # ユーザー名解析、id 解決、mute / block フロー
│   │   │   └── ports.ts      # Logger / Sleep / Clock / Progress の interface
│   │   └── test/             # vitest。fixtures/ にゴールデンデータ
│   ├── cli/                  # @lm/cli  Node 向けバッチ
│   │   └── src/
│   │       ├── main.ts       # サブコマンド振り分け（node:util parseArgs）
│   │       ├── config.ts     # env / .env / 引数から Config を組み立て、zod で検証
│   │       ├── logger.ts     # コンソール + 任意でファイル
│   │       └── commands/     # days-expire.ts, users-from-list.ts
│   └── web/                  # 将来。ここでは作らない
├── deleterule.json
├── .env.example
└── exported_files/
```

### 3.2 core の制約（Web 共有のための不変条件）

core は以下を守る。CI の lint で機械的に検査する（biome の `noRestrictedImports` または eslint 相当）。

- `node:*` モジュール、`process`、`fs`、`path` を import / 参照しない。
- 環境変数を読まない。設定は引数で受け取る。
- `console` を直接使わない。`Logger` interface を受け取る。
- `setTimeout` を直接使わない。`Sleep` interface（`(ms, signal?) => Promise<void>`）を受け取る。既定実装は core が提供してよいが差し替え可能にする。
- `Date.now()` を直接使わない。`Clock` interface を受け取る（テストで時刻を固定するため）。
- 長時間処理は `AbortSignal` を受け取り、待機中も含めて中断できる。
- 進捗は `Progress` callback で通知する（CLI はカウントダウン表示、Web は画面更新に使う）。
- 外部依存は `misskey-js` と `zod` のみ。

### 3.3 API クライアントとリトライ

misskey-js の `APIClient` は `{ origin, credential, fetch }` を取り、`fetch` を差し替えられる（`FetchLike` 型）。
`APIClient.request()` は 200 / 204 以外を本体の `error` オブジェクトで reject し、**HTTP ヘッダは呼び出し側に渡らない**。
したがってリトライは `fetch` ラッパー内で完結させる。ラッパーは生の `Response` を扱えるため `Retry-After` を読める。

```ts
// core/src/retry/withRetry.ts の意図
export function withRetry(base: FetchLike, policy: RetryPolicy, deps: { sleep; clock; logger; signal? }): FetchLike
```

待機時間の決定順序（429 の場合）:

1. `Retry-After` ヘッダ（秒）があればそれ + `pollBase`。
2. なければ本体 `error.info.reset` から待機秒を算出し + `pollBase`。単位は未決事項 8 を参照。
3. どちらも無ければ **フォールバック指数バックオフ**: 初回 `rateLimitBase`、以降 2 倍、上限 `rateLimitMax`。成功したらリセット。

その他の応答:

| 応答 | 挙動 |
|---|---|
| 200 / 204 | `pollBase` 待ってから返す（呼び出し単位で 0 に上書き可） |
| 400 | ラッパーはそのまま返す。呼び出し側フローが `on400: 'throw' \| 'skip'` で扱いを決める（2.3 の `raise400` 相当） |
| その他 4xx | そのまま返す（APIClient が reject する） |
| 5xx | `netErrorWait` 待って再試行。`maxNetErrorRetries`（新設、既定 5）を超えたら諦める |
| fetch 自体の例外（DNS、接続拒否など） | 5xx と同じ扱い。現行の「即死」を修正する |

ログには method / endpoint / status / 待機秒のみを出し、リクエスト本体は出さない（トークン漏洩の防止）。
現行 `LM_DEBUGLEVEL` 相当の「本体まで出す」モードは提供しない。

### 3.4 core の公開 API（概形）

```ts
// rules
export const RuleSchema, RulesSchema;                  // zod。deleterule.json の検証
export function evaluateRules(notes, pinnedIds, rules, now): string[];   // 2.4 の純粋関数

// notes
export async function* listAllNotes(client, userId, opts): AsyncGenerator<Note[]>;
export async function runDaysExpire(client, opts: { rules; exportedNotes?; dryRun; signal; progress; logger }): Promise<DaysExpireResult>;

// export
export function parseExportedNotes(json: unknown): ExportedNote[];      // 配列 / { notes } 両対応
export function mergeNotes(apiNotes, exportedNotes): Note[];

// users
export function parseUserRef(line: string): { username; host: string | null };  // @ 先頭許容
export async function resolveUserIds(client, refs, opts): Promise<Array<{ ref; id: string | null }>>;
export async function runUserAction(client, action: 'mute' | 'block', ids, opts): Promise<UserActionResult>;

// client
export function createClient(opts: { origin; token; retry: RetryPolicy; fetch?; deps }): APIClient;
```

### 3.5 CLI

- 実行形式: `lm <command> [options]`。`packages/cli/package.json` の `bin` で定義し、`pnpm lm ...` で起動できるようにする。
- コマンド:
  - `lm days-expire [--dry-run] [--rules <path>] [--export <path|auto|none>] [--print-notes]`
  - `lm mute-from-list <file>` / `lm block-from-list <file>`（実装は 1 つ、action だけ違う）
- `--dry-run` は削除候補の件数と id を出して終了する。既定は実行（現行 crontab 運用との互換）。
- 引数解析は `node:util` の `parseArgs` を使う。commander でも結果は同じだが、`parseArgs` は依存が増えず簡潔に書ける。
- 設定は「CLI 引数 > 環境変数 > `.env`」の優先順で解決し、zod で検証してから core に渡す。`.env` の読み込みは Node 標準の `process.loadEnvFile()` を使う（dotenv 不要）。
- ログはコンソール（stderr）に出し、`LM_LOGFILE=true` ならファイルにも同じ内容を書く。日時は `LM_LOG_TIMEZONE` で整形する。
- 待機中は stderr にカウントダウンを 1 行で上書き表示する（現行 `sleepseconds` の UX を維持）。
- 実行方法: 開発中は `pnpm --filter @lm/cli dev -- days-expire --dry-run`（`tsx` 経由）。運用は `pnpm build` 後に `node packages/cli/dist/main.js`。
  Node 22.18 以降の型ストリップで `.ts` を直接実行することもできるが、workspace 越しの `.ts` 解決に制約があるため運用では `dist` を使う。

### 3.6 ツールチェーン

| 用途 | 採用 | 備考 |
|---|---|---|
| Node | 22 LTS 以上 | `process.loadEnvFile`、標準 fetch |
| パッケージ管理 | pnpm（workspace） | |
| 型検査・ビルド | tsc（project references、`tsc -b`） | |
| テスト | vitest | misskey-js 自身も vitest |
| lint / format | Biome | eslint + prettier でも結果は同じだが Biome 1 つの方が設定が簡潔 |
| スキーマ | zod | ルールファイルと設定の両方 |
| CI | GitHub Actions | `pnpm install` → lint → typecheck → test → build |

## 4. フェーズ計画

各フェーズは独立した PR とする。完了条件を満たすまで次に進まない。

### Phase 0: 凍結と準備

- Python 版の最終コミットに `python-final` タグを打つ。
- ゴールデンデータの生成: Python の `step3` に対し、ピン留め・renote・reply・channel・各カウント・日数境界を網羅するノート配列とルール配列を与え、
  出力の削除 id 集合を `packages/core/test/fixtures/` に保存する。**ただし `reactionCount` の期待値は修正後の挙動（2.4）で手作りする**。
  生成スクリプトは使い捨てでよいが、フィクスチャとその由来はコミットする。
- （任意）移行期間中も Python 版を運用するなら、`reactionsCount` → `reactionCount` の修正だけを最小パッチで入れる。それ以外の Python 改修はしない。
- 完了条件: タグとフィクスチャがリポジトリにある。

### Phase 1: モノレポ骨格

- 3.1 の構成で `packages/core` と `packages/cli` を空に近い状態で作る。
- tsconfig / Biome / vitest / GitHub Actions を整備し、空テストで CI が緑になる。
- core の import 制約（3.2）を lint ルールとして入れる。
- Python ファイルはこの時点では残す（ルート直下にそのまま）。
- 完了条件: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` が CI で通る。

### Phase 2: core 実装

順序は依存の少ないものから。各モジュールは単体テストとセットで入れる。

1. `rules/`: zod スキーマと `evaluateRules`。Phase 0 のゴールデンデータで検証。境界（`day` ちょうど、カウントがしきい値ちょうど）のケースを追加。
2. `retry/`: `withRetry`。偽 fetch と偽 sleep で、2.3 と 3.3 の全行を表として網羅するテストを書く（`Retry-After` あり / `reset` のみ / どちらも無し 3 回連続 / 5xx 上限超過 / fetch 例外 / AbortSignal 中断）。
3. `users/`: `parseUserRef`（`name`、`name@host`、`@name@host`、空行）。
4. `export/`: 配列形式と `{ notes }` 形式、不明形式、重複時の API 優先。
5. `notes/`: `listAllNotes`（`untilId` ページング、空応答で終了）と `runDaysExpire`（dryRun で `notes/delete` を呼ばないこと、400 を 1 件ずつ握りつぶして続行すること）。misskey-js は偽 fetch で差し替える。
6. `client.ts`: `createClient`。`origin` 末尾の `/api` と `/` を除去する互換処理を含む。

- 完了条件: 上記全モジュールがテスト付きで入り、core が 3.2 の制約に違反していない。

### Phase 3: CLI 実装と同等性確認

- `config.ts`（5.1 の対応表どおり）、`logger.ts`、`main.ts`、各コマンド。
- **実サーバーでの同等性確認**: 同じアカウント・同じ `deleterule.json` に対して Python 版（`fake_step4` 有効化）と `lm days-expire --dry-run` を実行し、削除候補 id 集合を比較する。
  `reactionCount` 修正による差分以外が無いことを確認する。差分があれば理由を説明できるまで Phase 4 に進まない。
- mute / block は使い捨てのテスト用アカウントかごく少数の対象で実際に動かす。
- 完了条件: 同等性確認の結果（件数と差分の説明）が PR に記録されている。

### Phase 4: 切り替えと Python 削除

- README を TS 版の構成・コマンド・設定に合わせて全面更新する。ルール比較が「以上」であることを明記する。
- `.env.example` を 5.1 に合わせて更新する。
- crontab のコマンドを `node packages/cli/dist/main.js days-expire` に切り替える。
- `*.py` / `Pipfile` / `setup.cfg` を削除する。履歴は `python-final` タグで辿れる。
- 完了条件: Python ファイルがリポジトリに無く、README の手順だけで新規環境にセットアップできる。

### Phase 5（予約）: Web パッケージ

本計画のスコープ外。着手時の前提確認として次を先にスパイクする。

- 対象インスタンスがブラウザからの直接 API 呼び出しを CORS で許可しているか。
- MiAuth によるトークン取得フロー。
- バックグラウンドタブでのタイマー抑制下で、長時間の待機を伴う処理が継続できるか（できない場合も、そのために CLI 版を残している）。

## 5. 設定の対応表

### 5.1 `.env` 変数の新旧対応

| 旧 | 新 | 備考 |
|---|---|---|
| `LM_BASE_URL` | `LM_ORIGIN` | `https://misskey.io` 形式。旧名も受け付け、末尾 `/api` は自動除去して警告を出す |
| `LM_API_TOKEN` | 同名 | |
| `LM_POLL_BASE` | 同名 | |
| `LM_POLL_NETERROR` | 同名 | 5xx と接続エラーの両方に適用 |
| `LM_POLL_RATELIMIT_BASE` / `_MAX` | 同名 | フォールバック指数バックオフ用 |
| （新設） | `LM_NETERROR_MAX_RETRIES` | 既定 5 |
| `LM_LOGLEVEL` | 同名 | `debug` / `info` / `warn` / `error` |
| `LM_LOGFILE` / `LM_LOGFILENAME` | 同名 | |
| `LM_LOG_TIMEZONE` | 同名 | `Intl.DateTimeFormat` で解決 |
| `LM_DEBUGLEVEL` | 廃止 | 本体を出力する経路は作らない。`LM_LOGLEVEL=debug` で method / endpoint / status を出す |
| `LM_USERAGENT` | 廃止 | ブラウザ偽装の必要はない。CLI は `lm-misskeyutils/<version>` を送る |
| `LM_DELETERULE` | 同名 | CLI の `--rules` が優先 |
| `LM_DELETE_STEP2PRINT` | 同名 | CLI の `--print-notes` が優先 |

### 5.2 `deleterule.json`

形式は変更しない。キーは `day`（必須）, `renoteCount`, `repliesCount`, `reactionCount`, `pinned`, `renote`, `reply`, `inChannel`。
未知のキーは zod の `strict()` でエラーにする（現行は無視していたため、typo を検出できるようになる）。

## 6. 検証方針

- core は全モジュールを単体テストで覆う。ネットワークは偽 fetch、時間は偽 sleep / clock で差し替える。
- `evaluateRules` は Phase 0 のゴールデンデータを回帰テストとして固定する。
- 実サーバー検証は Phase 3 の dry-run 比較を正とし、削除系は比較が一致するまで実行しない。
- CI では実サーバーに接続しない。

### 6.1 備考: サーバーの API 定義と misskey-js の突き合わせスクリプト

misskey-js の型は本家（misskey-dev/misskey）の OpenAPI 定義から生成されており、本家のバージョンに追従する。
一方、misskey.io は本家からフォークして久しく、API に独自差分がある。本ツールは本家対応を優先するが io も無視できないため、
移行後の考慮事項として次のスクリプトを追加する（Phase 3 以降の任意タスク。本計画の完了条件には含めない）。

- Misskey サーバーは自身の OpenAPI 定義を `GET /api.json` で配布している（`/api-doc` で閲覧できるものと同じ）。フォークも同様に配布していることが多い。
- スクリプト（例: `scripts/check-api-compat.ts`、`pnpm check-api -- https://misskey.io`）は、対象サーバーの `api.json` を取得し、
  **本ツールが使う 6 エンドポイント**（`i`, `users/notes`, `notes/delete`, `users/show`, `mute/create`, `blocking/create`）について、
  misskey-js の `Endpoints[E]['req']` / `['res']` に対応する型情報と、リクエストパラメータ名・応答で参照するフィールド名
  （`id`, `createdAt`, `renoteId`, `replyId`, `channelId`, `renoteCount`, `repliesCount`, `reactionCount`, `pinnedNotes`）の有無を比較して差分を表示する。
- 全エンドポイントの完全比較はしない。ツールが依存する範囲に限定することで、フォーク差分のうち実害のあるものだけを検出する。
- 型と実サーバーの照合は tsc ではできない（型はコンパイル時、サーバー定義は実行時）ため、misskey-js の `autogen/types.d.ts` を読むのではなく、
  本家の `api.json` を misskey-js と同じバージョンの本家サーバーから取得して比較する、または本ツール側で使用パラメータ名を定数として列挙し
  それをサーバー定義と照合する方式にする。後者の方が実装が簡潔で、misskey-js 更新時のパラメータ名変更も同じ定数で追える。
- `POST /api/meta` の `version` もあわせて表示し、報告や切り分けに使えるようにする。
- 現在の運用先（io）と本家バニラのインスタンスの両方で実行し、結果を README か本ドキュメントに記録する。

## 7. 実施セッションへの指示

- 本ドキュメントの Phase を 1 つずつ、それぞれ別ブランチ・別 PR で進める。ブランチ名は `ts/phase-N-<topic>`。
- 各 PR の説明に「完了条件をどう確認したか」を書く。
- 2.3 / 2.4 / 2.5 の挙動を変更したくなった場合は、変更せず未決事項として本ドキュメントに追記して判断を仰ぐ。
- 本ドキュメント自体も PR で更新してよい（決定事項の追加、未決事項の解消）。

## 8. 未決事項

| # | 内容 | 現時点の扱い |
|---|---|---|
| 1 | 429 本体 `error.info.reset` の単位が epoch 秒か相対秒か | **暫定解決**: 両対応の判定を実装した（0 章「実装中に決めたこと」参照）。実サーバーの 429 応答をログで確認したら単純化する |
| 2 | エクスポートにしかないノートがカウント条件で保護されない件（2.5） | 現行踏襲。件数を警告ログに出す。将来 `notes/show` で補完するかは別途判断 |
| 3 | `--dry-run` を既定にして実行時に `--execute` を必須にするか | 現行互換を優先し既定は実行。安全側に倒すなら Phase 4 の README 更新時に再検討 |
| 4 | `mute/create` の `expiresAt` を CLI オプションで指定可能にするか | 現行は常に無期限。必要になったら追加 |
| 5 | ログライブラリ（pino 等）を入れるか | 入れない。コンソール + ファイルの自前実装で足りる規模 |
| 6 | Web パッケージのフレームワーク | スコープ外 |
| 7 | `withReplies` / `withChannelNotes` を明示した列挙で全ノートが揃う場合、エクスポート JSON マージ（2.5）を廃止するか | Phase 3 の同等性確認で API 列挙件数とエクスポート件数を比較して判断。揃うなら廃止し、コードと `exported_files/` を削除する |

## 9. 旧計画からの変更点

- 言語を Python から TypeScript に変更した。旧計画の Stage 1〜7（pyproject 化、src レイアウト、4 スペース化、pydantic 化、click 化など）はすべて不要になった。
- 旧計画の現状分析で挙げた問題（import 時副作用、camelCase、重複、コメントアウト式 dry-run、テスト・CI 不在、トークン露出）は、
  新構成では設計上発生しない形で解消する。
- 旧計画に無かった発見を 2 章に追加した: 未使用 API 関数 7 つ、`websockets` 未使用、`getI` がリトライ非経由、接続エラーが再試行されない、
  `sleepseconds` の 1 秒不足、`reactionCount` バグがノート側にもあること、エクスポートマージの意味論、`@name@host` の解析不良、
  `users/notes` の `includeReplies` が現行 API に存在しないこと（2.8）。
- 旧計画は「テスト整備」が Stage 6 と最後だったが、新計画では Phase 0 でゴールデンデータを作り、Phase 2 でテストと実装を同時に入れる。
- バックオフ戦略は「不要になった」のではなく「フォールバックに格下げ」とし、機構は残す。
