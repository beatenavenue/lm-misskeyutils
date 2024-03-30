# Project LimitManage for Misskey
Yet another utils for Misskey

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
MIT License
