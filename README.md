# lm-misskeyutils — Limit Manage utilities for Misskey

Yet another set of batch utilities for [Misskey](https://misskey-hub.net/):

| Command | What it does |
| --- | --- |
| `lm days-expire` | Delete your old notes according to a rule file, for your safety from stalkers, trackers and more. |
| `lm mute-from-list` | Mute every account listed in a text file. |
| `lm block-from-list` | Block every account listed in a text file. |

Every command that writes to the server supports `--dry-run`.

The tools are a pnpm/TypeScript workspace: `packages/core` holds the
environment-independent logic (rules, retry/rate-limit handling, note
listing, user resolution) and `packages/cli` the Node command line. The
original Python scripts are preserved at the git tag `python-final`; see
`REFACTORING_PLAN.md` for the migration history and design notes.

## Requirements

* Node.js 22 or newer and [pnpm](https://pnpm.io/)
* A Misskey API token ([how to issue one](https://misskey-hub.net/en/docs/api/#manually-issue-an-access-token))

## Setup

```sh
git clone https://github.com/beatenavenue/lm-misskeyutils.git
cd lm-misskeyutils
pnpm install
pnpm build
cp .env.example .env   # then edit LM_ORIGIN and LM_API_TOKEN
node packages/cli/dist/main.js --help
```

`pnpm lm --help` runs the same binary (結果は同じだがより簡潔に書ける); the
examples below use it. `pnpm --filter @lm/cli dev -- <command>` runs the
TypeScript sources directly via `tsx` during development.

## Configuration

Copy `.env.example` to `.env` and set at least:

* `LM_ORIGIN` — your server origin, e.g. `https://misskey.io` (the old
  `LM_BASE_URL=https://misskey.io/api` still works and is converted with a warning)
* `LM_API_TOKEN` — your API token

Every setting can also be given as an environment variable; environment
variables take precedence over `.env`, and `--dotenv <path>` selects another
file. `.env.example` documents the remaining settings (polling intervals,
retry limits, logging). The request body — and therefore the token — is never
written to the log.

## lm days-expire

Deletes notes older than a configurable number of days unless a "keep"
condition matches. Rules live in `deleterule.json` (`LM_DELETERULE` or
`--rules <path>` select another file):

```json
[
  { "day": 30, "renoteCount": 1, "repliesCount": 1, "reactionCount": 1,
    "pinned": true, "renote": true, "reply": true, "inChannel": true },
  { "day": 60, "renoteCount": 5, "repliesCount": 5, "reactionCount": 5, "pinned": true },
  { "day": 180, "pinned": true }
]
```

| Key | Type | Meaning |
| --- | --- | --- |
| `day` | number (required) | the rule applies to notes older than this many days |
| `renoteCount` | number | keep the note if its renote count is **greater than or equal to** this value |
| `repliesCount` | number | keep the note if its reply count is greater than or equal to this value |
| `reactionCount` | number | keep the note if its reaction count is greater than or equal to this value |
| `pinned` | boolean | keep pinned notes |
| `renote` | boolean | keep renotes / quotes |
| `reply` | boolean | keep replies |
| `inChannel` | boolean | keep notes posted in a channel |

Rules are evaluated from the smallest `day` upwards; the first rule whose age
condition holds and whose keep conditions do not apply deletes the note.
Unknown keys are rejected, so typos are caught before anything is deleted.

```sh
pnpm lm days-expire --dry-run      # list the candidates (count and ids on stdout), delete nothing
pnpm lm days-expire                # delete
pnpm lm days-expire --print-notes  # also dump every fetched note as JSON to stdout (backup)
pnpm lm days-expire --export none  # ignore export files (see below)
```

### Merging a Misskey note export

The API listing may miss notes. By default (`--export auto`) the newest
`exported_files/notes-YYYY-MM-DD-HH-mm-SS.json` (a Misskey note export placed in
that directory) is merged into the list before the rules run; API data wins
for duplicate ids. `--export <path>` uses a specific file and `--export none`
skips the merge. Exported notes carry no renote / reply / reaction counts, so
notes that exist only in the export are judged by `day`, `pinned`, `renote`,
`reply` and `inChannel` alone; the log warns how many such notes there are.

### Running from cron

```
0 4 * * * cd /path/to/lm-misskeyutils && node packages/cli/dist/main.js days-expire --no-progress >> cron.log 2>&1
```

## lm mute-from-list / lm block-from-list

Put one account per line into `mute.txt` (or `block.txt`, or any file given as
the argument). `user@host` selects a remote account, a leading `@` is
allowed, blank lines are ignored.

```sh
pnpm lm mute-from-list --dry-run     # resolve the accounts, mute nobody
pnpm lm mute-from-list               # mute the accounts in mute.txt
pnpm lm block-from-list others.txt   # block the accounts in another file
```

Accounts the server does not know are reported and skipped; an account that
is already muted or blocked (HTTP 400) counts as done.

## Rate limiting and errors

Every API call is paced by `LM_POLL_BASE` seconds. On `429 Too Many Requests`
the `Retry-After` header (or the `reset` information in the error body) is
honoured; without either, the wait starts at `LM_POLL_RATELIMIT_BASE` seconds
and doubles up to `LM_POLL_RATELIMIT_MAX`. Server (5xx) and network errors are
retried after `LM_POLL_NETERROR` seconds, up to `LM_NETERROR_MAX_RETRIES`
times. Other client errors abort the command with exit code 1. Ctrl-C aborts
cleanly, even during a wait.

## Development

```sh
pnpm lint        # biome
pnpm typecheck   # tsc -b + test sources
pnpm test        # vitest
pnpm build       # tsc -b
```

`packages/core` must stay usable from a browser: it imports no Node modules
and reads no environment (enforced by Biome rules and
`packages/core/test/constraints.test.ts`). The `evaluateRules` behaviour is
pinned by golden data generated from the Python implementation
(`packages/core/test/fixtures/evaluate-rules/`).

## License

MIT License
