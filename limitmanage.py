import json
import logging
import os
import re
import sys
import time
from collections.abc import MutableMapping
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, ParamSpec, TypeVar
from urllib import error, request

from dotenv import dotenv_values

P = ParamSpec('P')
T = TypeVar('T')


# load configs from environment
env = {
    **dotenv_values('.env'),
    **os.environ,
}

# set log level and format
log_format = '%(asctime)s %(levelname)-8s %(message)s'
date_format = '%Y-%m-%d %H:%M:%S'
if env.get('LM_LOGFILE', 'False').upper() == 'TRUE':
  # Configure basic file logging
  logging.basicConfig(
      filename=env.get('LM_LOGFILENAME', 'limitmanage.log'),
      level=getattr(logging, env['LM_LOGLEVEL'], logging.INFO),
      format=log_format,
      datefmt=date_format)
  # Also add a console (stream) handler so logs are visible on stderr/stdout
  # TODO: これでログファイルとコンソール両方に出せるそうだが、FILE, CONSOLE, BOTH みたいな選択式にしたいよね
  console_handler = logging.StreamHandler()
  console_handler.setLevel(getattr(logging, env['LM_LOGLEVEL'], logging.INFO))
  console_formatter = logging.Formatter(fmt=log_format, datefmt=date_format)
  console_handler.setFormatter(console_formatter)
  logging.getLogger().addHandler(console_handler)
else:
  # No file: use basic config to output to console
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


def _get_log_timezone() -> timezone:
  """Return tzinfo based on `LM_LOG_TIMEZONE` environment value.

  Resolution order:
  - zoneinfo.ZoneInfo(name)
  - dateutil.tz.gettz(name)
  - parse fixed offset like +09:00
  - fallback to UTC
  """
  name = env.get('LM_LOG_TIMEZONE')
  if not name:
    return timezone.utc

  # Try zoneinfo (Python 3.9+)
  try:
    from zoneinfo import ZoneInfo  # type: ignore
    try:
      return ZoneInfo(name)
    except Exception:
      pass
  except Exception:
    pass

  # Try dateutil as a fallback
  try:
    from dateutil import tz as dateutil_tz  # type: ignore
    tzobj = dateutil_tz.gettz(name)
    if tzobj is not None:
      return tzobj
  except Exception:
    pass

  # Parse fixed offset like +09:00 or -0530
  m = re.match(r'^([+-])(\d{1,2})(?::?(\d{2}))?$', name)
  if m:
    sign = 1 if m.group(1) == '+' else -1
    hours = int(m.group(2))
    minutes = int(m.group(3) or 0)
    return timezone(timedelta(hours=sign * hours, minutes=sign * minutes))

  logging.warning(f'Invalid LM_LOG_TIMEZONE={name!r}, falling back to UTC')
  return timezone.utc


# Logging timezone (configurable via LM_LOG_TIMEZONE, fallback UTC)
LOG_TZ = _get_log_timezone()


def __remove_none_value_entry(data: Dict):
  '''remove none entry (compatible js undefined)'''
  return {key: value for key, value in data.items() if value is not None}


def __post_action(target_url: str, data: Dict, status_container: Optional[Dict] = None):
  '''Do POST to Misskey API'''
  req = request.Request(
      baseUrl + target_url,
      data=bytes(json.dumps(data), encoding="utf-8"), method='POST')
  req.add_header('Content-Type', 'application/json')
  req.add_header('user-agent', env['LM_USERAGENT'])

  try:
    with request.urlopen(req) as response:
      code = response.getcode()
      if isinstance(status_container, MutableMapping):
        status_container['http_status'] = code

      result = response.read().decode('utf-8')
      logging.debug(result)
      return result

  except error.HTTPError as e:
    if isinstance(status_container, MutableMapping):
      status_container['http_status'] = e.code

    logging.debug(e)
    raise e
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
                  include_replies=False, until_id=None, since_id=None):
  '''POST Misskey API /users/notes'''
  targetUrl = '/users/notes'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'includeReplies': include_replies,
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
  state_info = {}

  __post_action(targetUrl, data, state_info)

  return True if state_info.get('http_status') == 204 else False


def muteUser(user_id, expire=None):
  '''POST Misskey API /mute/create'''
  targetUrl = '/mute/create'
  data = {
      'i': env['LM_API_TOKEN'],
      'userId': user_id,
      'expiresAt': expire,
  }

  __post_action(targetUrl, data)


def blockUser(user_id):
  '''POST Misskey API /blocking/create'''
  targetUrl = '/blocking/create'
  data = {
      'i': env['LM_API_TOKEN'],
      'userId': user_id,
  }

  __post_action(targetUrl, data)


def getUserIdFromUserName(username: str, host: str = None) -> str:
  '''POST Misskey API /users/show'''
  targetUrl = '/users/show'
  data = {
      'i': env['LM_API_TOKEN'],
      'username': username,
      'host': host,
  }

  result = __post_action(targetUrl, __remove_none_value_entry(data))
  id = json.loads(result)['id']
  return id


def getFile(limit=100,
            folder_id=None, until_id=None, since_id=None, type=None):
  '''POST Misskey API /drive/files'''
  targetUrl = '/drive/files'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'folderId': folder_id,
      'untilId': until_id,
      'sinceId': since_id,
      'type': type,
  }
  return __post_action(targetUrl, __remove_none_value_entry(data))


def getFolder(limit=100,
              folder_id=None, until_id=None, since_id=None):
  '''POST Misskey API /drive/folders'''
  targetUrl = '/drive/folders'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'folderId': folder_id,
      'untilId': until_id,
      'sinceId': since_id,
  }
  return __post_action(targetUrl, __remove_none_value_entry(data))


def getAttachedNote(file_id,
                    limit=10, until_id=None, since_id=None):
  '''POST Misskey API /drive/files/attached-notes'''
  targetUrl = '/drive/files/attached-notes'
  data = {
      'i': env['LM_API_TOKEN'],
      'limit': limit,
      'fileId': file_id,
      'untilId': until_id,
      'sinceId': since_id,
  }
  return __post_action(targetUrl, __remove_none_value_entry(data))


def updateFile(file_id, folder_id=None, name=None,
               is_sensitive=None, comment=None):
  '''POST Misskey API /drive/files/update'''
  targetUrl = '/drive/files/update'
  data = {
      'i': env['LM_API_TOKEN'],
      'fileId': file_id,
      'folderId': folder_id,
      'name': name,
      'isSensitive': is_sensitive,
      'comment': comment
  }

  __post_action(targetUrl, __remove_none_value_entry(data))


def createFolder(name,
                 parent_id=None):
  '''POST Misskey API /drive/folders/create'''
  targetUrl = '/drive/folders/create'
  data = {
      'i': env['LM_API_TOKEN'],
      'name': name,
      'parentId': parent_id,
  }
  result = __post_action(targetUrl, __remove_none_value_entry(data))
  folder_id = json.loads(result)['folderId']
  return folder_id


def sleepseconds(sec) -> None:
  '''print to stderr with counting down'''
  logging.info(f'sleep {sec}sec')
  for t in range(1, sec):
    print('               ', end='\r', file=sys.stderr)
    print(f'wait {t}/{sec}', end='\r', file=sys.stderr)
    time.sleep(1)

  handler.terminator = '\n'


def net_runner(action: Callable[P, T], raise400=True, wait=None, **kwargs) -> Optional[T]:
  '''net_runnner treatment your network operation for rate limits'''
  logging.debug('start net runner')
  limit_sec = 0
  while True:
    try:
      logging.debug(f'call: {action.__name__}')
      logging.debug('args: ' + str(kwargs))
      result = action(**kwargs)
      sleepseconds(wait if wait is not None else int(env['LM_POLL_BASE']))
      return result

    except error.HTTPError as e:
      if e.code == 429:
        # Rate Limit
        logging.info('limit...')

        reset_epoch = None
        try:
          body = e.read()
          if body:
            payload = json.loads(body.decode('utf-8'))
            reset_epoch = payload.get('error', {}).get('info', {}).get('reset')
        except Exception as parse_error:
          logging.debug(f'failed to parse 429 body: {parse_error}')

        if reset_epoch is not None:
          try:
            reset_time = datetime.fromtimestamp(float(reset_epoch), tz=LOG_TZ).isoformat()
            logging.info(f'rate limit resets at {reset_time} (epoch: {reset_epoch})')
          except Exception:
            logging.info(f'rate limit resets at epoch: {reset_epoch}')

        retry_after = None
        if hasattr(e, 'headers') and e.headers is not None:
          header_value = e.headers.get('Retry-After')
          if header_value is not None:
            try:
              retry_after = int(header_value)
            except ValueError:
              logging.warning(f'invalid Retry-After header: {header_value}')

        if retry_after is not None:
          logging.info(f'429 rate limit with Retry-After seconds ({retry_after} + POLL_BASE)')
          sleepseconds(retry_after + int(env['LM_POLL_BASE']))
          continue

        logging.info('429 rate limit without retry information (use backoff strategy)')
        limit_sec += limit_sec if limit_sec > 0 else int(env['LM_POLL_RATELIMIT_BASE'])
        # limit_sec += limit_sec
        limit_sec = min(limit_sec, int(env['LM_POLL_RATELIMIT_MAX']))
        sleepseconds(limit_sec)

      elif e.code == 400:
        if raise400:
          logging.info('400 not exist? Raise to abort.')
          sleepseconds(int(env['LM_POLL_BASE']))
          raise e
        else:
          # may be previous state is success but not responded
          logging.info('400 not exist? ')
          sleepseconds(wait if wait is not None else int(env['LM_POLL_BASE']))
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
