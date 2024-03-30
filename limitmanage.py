import json
import logging
import os
import sys
import time
from typing import Callable, Dict
from urllib import error, request

from dotenv import dotenv_values

# load configs from environment
env = {
    **dotenv_values('.env'),
    **os.environ,
}

# set log level and format
log_format = '%(asctime)s %(levelname)-8s %(message)s'
date_format = '%Y-%m-%d %H:%M:%S'
if env.get('LM_LOGFILE', 'False').upper() == 'TRUE':
  logging.basicConfig(
      filename=env.get('LM_LOGFILENAME', 'limitmanage.log'),
      level=getattr(logging, env['LM_LOGLEVEL'], logging.INFO),
      format=log_format,
      datefmt=date_format)
else:
  logging.basicConfig(
      level=getattr(logging, env['LM_LOGLEVEL'], logging.INFO),
      format=log_format,
      datefmt=date_format)

# set http debug option
debuglevel = int(env['LM_DEBUGLEVEL'])
handler = request.HTTPHandler(debuglevel)
try:
  import ssl  # noqa: F401
  handler_s = request.HTTPSHandler(debuglevel)
  opener = request.build_opener(handler, handler_s)
except ImportError:
  logging.warn('can\'t use ssl')
  opener = request.build_opener(handler)
request.install_opener(opener)

# set base url
baseUrl = env['LM_BASE_URL']


def __remove_none_value_entry(data: Dict):
  '''remove none entry (compatible js undefined)'''
  return {key: value for key, value in data.items() if value is not None}


def __post_action(target_url, data):
  '''Do POST to Misskey API'''
  req = request.Request(
      baseUrl + target_url,
      data=bytes(json.dumps(data), encoding="utf-8"), method='POST')
  req.add_header('Content-Type', 'application/json')
  req.add_header('user-agent', env['LM_USERAGENT'])

  try:
    with request.urlopen(req) as response:
      result = response.read().decode('utf-8')
      logging.debug(result)
      return result

  except Exception as e:
    logging.debug(e)
    raise e


def getNotes(user_id, until_id, limit=1):
  '''POST Misskey API /notes'''
  targetUrl = '/notes'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'untilId': until_id,
      'userId': user_id,
  }

  return __post_action(targetUrl, data)


def getNotesShow(note_id):
  '''POST Misskey API /notes/show'''
  targetUrl = '/notes/show'
  data = {'i': env['LM_API_TOKEN'], 'noteId': note_id}

  return __post_action(targetUrl, data)


def getUsersNotes(user_id, limit=100,
                  with_replies=False, with_renotes=False, with_channel_notes=False,
                  until_id=None, since_id=None):
  '''POST Misskey API /users/notes'''
  targetUrl = '/users/notes'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'withReplies': with_replies,
      'withRenotes': with_renotes,
      'withChannelNotes': with_channel_notes,
      'untilId': until_id,
      'sinceId': since_id,
      'userId': user_id,
  }
  return __post_action(targetUrl, __remove_none_value_entry(data))


def getI():
  '''POST Misskey API /i'''
  targetUrl = '/i'
  data = {'i': env['LM_API_TOKEN']}

  return __post_action(targetUrl, data)


def deleteNote(note_id):
  '''POST Misskey API /notes/delete'''
  targetUrl = '/notes/delete'
  data = {'i': env['LM_API_TOKEN'], 'noteId': note_id}

  __post_action(targetUrl, data)


def muteUser(user_id, expire=None):
  '''POST Misskey API /mute/create'''
  targetUrl = '/mute/create'
  data = {
      'i': env['LM_API_TOKEN'],
      'userId': user_id,
      'expiresAt': expire,
  }

  __post_action(targetUrl, data)


def getUserIdFromUserName(username: str) -> str:
  '''POST Misskey API /users/show'''
  targetUrl = '/users/show'
  data = {
      'i': env['LM_API_TOKEN'],
      'username': username,
  }

  result = __post_action(targetUrl, data)
  id = json.loads(result)['id']
  return id


def sleepseconds(sec) -> None:
  '''print to stderr with counting down'''
  logging.info(f'sleep {sec}sec')
  for t in range(1, sec):
    print('               ', end='\r', file=sys.stderr)
    print(f'wait {t}/{sec}', end='\r', file=sys.stderr)
    time.sleep(1)

  handler.terminator = '\n'


def net_runner(action: Callable, raise400=True, **kwargs) -> None:
  '''net_runnner treatment your network operation for rate limits'''
  logging.debug('start net runner')
  limit_sec = 0
  while True:
    try:
      logging.debug(f'call: {action.__name__}')
      logging.debug('args: ' + str(kwargs))
      result = action(**kwargs)
      sleepseconds(int(env['LM_POLL_BASE']))
      return result

    except error.HTTPError as e:
      if e.code == 429:
        # Rate Limit
        logging.info('limit...')
        limit_sec = limit_sec if limit_sec > 0 else int(env['LM_POLL_RATELIMIT_BASE'])
        limit_sec += limit_sec
        limit_sec = min(limit_sec, int(env['LM_POLL_RATELIMIT_MAX']))
        sleepseconds(limit_sec)

      elif e.code == 400:
        if raise400:
          raise e
        else:
          # may be previous state is success but not responded
          logging.info('400 not exist? ')
          sleepseconds(int(env['LM_POLL_BASE']))
          break

      elif e.code < 500:
        # ClientError [TO ABORT] because suspect invalid params
        logging.error('client error: ')
        logging.error(e)
        raise e

      else:
        # NetworkError or Other Connection Problem
        logging.warning('HTTP failure: ')
        logging.warning(e)
        sleepseconds(int(env['LM_POLL_NETERROR']))

    except Exception as e:
      logging.error(e)
      raise e
