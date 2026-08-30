# リファクタリング計画

## 背景

長期運用の中で実験的な変更が積み重なり、以下のような「一般的なPythonプロジェクトの作法」から外れた状態になっている。本ドキュメントは現状の問題点を整理し、段階的なリファクタリング計画をまとめたものである。

（本来はGitHub Issueとして個別管理する想定だったが、このリポジトリではIssue作成権限がなかったため、作業計画としてこのMarkdownをまとめてPRを作成した。各Stageは今後Issue化してもよいし、このドキュメントのチェックリストで進捗管理してもよい。）

## 現状の問題点

### 構成・パッケージング
- パッケージ構成を持たないフラットなスクリプト群（`limitmanage.py` / `days_expire.py` / `mute_from_list.py` / `block_from_list.py`）。`src/`レイアウトも`__init__.py`もない。
- `pyproject.toml` が存在せず、`Pipfile`（Pipenv）のみで依存管理している。プロジェクトメタデータ（バージョン、エントリポイント等）が定義できていない。
- コンソールスクリプト（`console_scripts`）が定義されておらず、`pipenv run python days_expire.py` のように直接ファイルを叩く運用になっている。

### コードスタイル
- インデントが2スペース（PEP8は4スペース基準）。`setup.cfg` の flake8設定で `E111, E114`（インデント不正）を意図的に無視しており、標準的なPythonコードと見た目が異なる。
- API関数名が `getNotes` / `getUsersNotes` / `muteUser` / `getUserIdFromUserName` のようにcamelCaseで、PEP8のsnake_case命名規約に反する。
- `__post_action` や `__remove_none_value_entry` のようにモジュール内関数にダブルアンダースコア接頭辞（name-mangling対象ではない場所での誤用）が使われている。

### アーキテクチャ
- `limitmanage.py` が「.env読み込み」「ロギング初期化（`logging.basicConfig`）」「HTTPオープナーのグローバルインストール（`request.install_opener`）」をすべて**モジュールimport時の副作用**として実行している。これにより:
  - このモジュールをテストコードやライブラリとして安全にimportできない（importするだけでロギング設定やネットワーク設定が書き換わる）。
  - `.env` がカレントディレクトリに存在しないと即座に壊れる。
- 生の `urllib.request` / `urllib.error` を使ってAPIクライアントを自作している。`requests` や `httpx` のような標準的なHTTPクライアントライブラリを使えば、セッション管理・リトライ・タイムアウト設定などが大幅に簡潔になる。
- 全APIエンドポイントの呼び出しがトップレベル関数として `limitmanage.py` に集約されており（400行）、「設定」「ロギング」「HTTPクライアント」「Misskey APIバインディング」「レート制限つきランナー」という異なる関心事が1ファイルに同居している。

### 重複コード
- `block_from_list.py` と `mute_from_list.py` はほぼ完全なコピペ重複（`convert_userid_from_username` 関数などが1行も変わらず重複している）。差分は呼び出すAPI（`blockUser` / `muteUser`）とファイル名（`block.txt` / `mute.txt`）だけ。

### CLI・UX
- click/typer/argparse等のCLIフレームワークが使われておらず、コマンドライン引数を一切受け付けない。
- 動作モードの切り替え（例: dry-run）が `days_expire.py` 内で `fake_step4(delete_ids)` の呼び出し行をコメントアウト/インする方式になっており、コードを書き換えないとdry-runができない。
- 設定はすべて `.env` 編集のみで、実行時オプション（例: `--config`, `--dry-run`, `--limit`）が存在しない。

### バグ・データ整合性
- `deleterule.json` およびREADMEで定義されているキー名は `reactionCount`（単数形）だが、`days_expire.py` の `is_valid_config` と `step3` は `reactionsCount`（複数形）を検証・参照しており、**ユーザーが設定したreactionCountルールが実質的に一切機能しない**バグが潜在している。
- 設定ファイル（`deleterule.json`）の検証が手書きの `key_type_is` 関数の羅列で行われており、型安全性・保守性が低い（pydantic等のスキーマ検証ライブラリを使えば大幅に簡潔・安全になる）。

### テスト・CI
- テストコードが1つも存在しない。
- `.github/workflows` が存在せず、lint/型チェック/テストを自動実行するCIがない。

### ロギング・秘匿情報
- `logging.warn`（非推奨エイリアス）が使われている箇所がある。
- APIトークン（`LM_API_TOKEN`）が全リクエストのペイロードに直接埋め込まれ、`LM_DEBUGLEVEL` を上げるとHTTPヘッダ・ボディがログに出力される経路がある。トークンのマスキングが行われていない。

## 段階的リファクタリング計画

一度に書き直すとレビューが困難でリグレッションリスクも高いため、以下の順序で段階的に進める。

### Stage 1: プロジェクト基盤整備
- `Pipfile` → `pyproject.toml`（PEP 621）へ移行。Pipenv継続かuv/Poetry等への切り替えは別途検討。
- `src/lm_misskeyutils/` のようなパッケージレイアウトを導入。
- lint/format/型チェックツールを整備（例: ruff + mypy）。2スペースインデントをやめ、PEP8準拠の4スペースに統一（`setup.cfg` のE111/E114無視設定を撤廃）。
- GitHub Actions CIを追加し、lint・型チェック・テストをPR毎に自動実行。

### Stage 2: 設定・ロギング層の刷新
- `.env` 読み込み・ロギング初期化・HTTPオープナー設置をモジュールimport時の副作用から関数化（例: `load_settings()`, `configure_logging()`）し、明示的な呼び出しに変更。
- 設定値をpydantic-settings（またはdataclass）でスキーマ化し、型・必須項目のバリデーションを型システムに委譲。
- ログにトークン等の秘匿情報が出力されないようマスキング処理を追加。

### Stage 3: APIクライアント層の刷新
- `limitmanage.py` を分割: `config.py` / `logging_setup.py` / `http_client.py`（`requests`または`httpx`ベース）/ `api/`（Misskey APIバインディング）/ `rate_limiter.py`。
- API関数名をsnake_caseへ統一（`getNotes` → `get_notes` 等）。
- レート制限・リトライ処理を自作の `net_runner` から `tenacity` 等の実績あるライブラリ利用に置き換えるか、少なくとも単体テスト可能な形に整理。

### Stage 4: CLI統一化・重複スクリプトの解消
- click または typer を導入し、`lm-days-expire` / `lm-mute-from-list` / `lm-block-from-list` のようなコンソールスクリプトとして定義。
- `--dry-run` フラグをコードコメントアウトではなくCLIオプションとして提供。
- `block_from_list.py` と `mute_from_list.py` の重複を解消し、共通の「ユーザー名リストからアクションを実行する」ロジックに統合（アクション種別・対象ファイルパスをパラメータ化）。

### Stage 5: 設定バグ修正・ルール検証のモデル化
- `reactionCount` / `reactionsCount` のキー不一致バグを修正（どちらのキー名を正とするか決め、README・`deleterule.json`・実装を統一）。
- 削除ルール（`deleterule.json`）をpydanticモデルとして定義し、`key_type_is` の手書き検証を置き換え。

### Stage 6: テスト整備
- pytest を導入し、HTTPモック（`responses` や `respx` 等）を使ってAPIクライアント・レート制限ロジック・ルール判定ロジック（`step3`相当）を単体テスト化。
- CIでのテスト自動実行をStage 1のCIに組み込む。

### Stage 7: ドキュメント刷新
- README を新しい構成・CLIコマンドに合わせて全面更新。
- CONTRIBUTING.md / CHANGELOG.md を追加し、開発フロー・変更履歴を明文化。

## 進め方の補足

- 各Stageは独立したPRとして進め、都度動作確認（実サーバーへの副作用があるため、可能な範囲でdry-run/モックでの検証を優先する）を行う。
- Stage順は依存関係を考慮した順序だが、厳密な直列実行は必須ではない（例: Stage 6のテスト整備はStage 3以降であれば並行して着手可能）。
