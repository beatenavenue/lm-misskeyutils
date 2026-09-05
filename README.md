# Project LimitManage for Misskey
Yet another utils for Misskey

> **TypeScript version (preview):** the tools are being migrated to a pnpm/TypeScript
> workspace (see `REFACTORING_PLAN.md`). The new CLI is usable but has not yet been
> verified against a real server side by side with the Python scripts, so the Python
> scripts below remain the supported way to run the tools until that check is done.
>
> ```
> pnpm install && pnpm build
> node packages/cli/dist/main.js days-expire --dry-run
> node packages/cli/dist/main.js mute-from-list mute.txt
> node packages/cli/dist/main.js --help
> ```
>
> Configuration is the same `.env` (`LM_BASE_URL` keeps working; `LM_ORIGIN=https://misskey.io`
> is the new name). Requires Node 22 and pnpm. Note: the count rules
> (`renoteCount` / `repliesCount` / `reactionCount`) keep a note when its count is
> **greater than or equal to** the configured value.

## System require
Python3.12 (Recommend Debian Trixie)  
Pipenv

## setup
* pipenv install
* edit .env
    * set your server to LM_BASE_URL
    * set your token to LM_API_TOKEN ([see](https://misskey-hub.net/docs/api/))

----------
## days_expire.py
can removing your old notes, for your safety from stalker tracker or more.

### setup
you must check deleterule.json
* day: REQUIRED NUMBER counts more than days
* renoteCount: NUMBER if more than counts not remove
* repliesCount: NUMBER if more than counts not remove
* reactionCount: NUMBER if more than counts not remove
* pinned: BOOLEAN if match to not remove
* renote: BOOLEAN if match to not remove
* reply: BOOLEAN if match to not remove
* inChannel: BOOLEAN if match to not remove

### how to use
run command, or entry your crontab.
```
pipenv run python days_expire.py
```

----------
## mute_from_list.py
create mutes from username list via limitmanage netrunner.

----------
MIT License
