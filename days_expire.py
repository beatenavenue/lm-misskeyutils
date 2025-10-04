import json
import logging
import sys
from datetime import datetime, timedelta, timezone

import limitmanage

# Note: step2 uses the API to list notes, but the API may miss some notes.
# To compensate, step2 will attempt to merge notes from the latest exported
# `notes-YYYY-MM-DD-HH-mm-SS.json` file found next to this script. The merge
# deduplicates by note `id` and prefers API data when duplicates exist. If no
# export file is present, the merge step is skipped.


def key_type_is(data, keyname, data_type):
  if keyname in data and not isinstance(data[keyname], data_type):
    logging.error('Configulation error: '
                  f'\'{keyname}\' must be of type {data_type.__name__}')
    return False
  return True


def is_valid_config(config_data):
  '''Validate days expire mode ruleset'''
  if not isinstance(config_data, list):
    logging.error('Configulation error: toplevel is must list')
    return False

  for entry in config_data:
    if not isinstance(entry, dict):
      logging.error('Configulation error: list entries must be of type dict')
      return False

    if 'day' not in entry:
      logging.error('Configulation error: key \'day\' must be include')
      return False

    if not key_type_is(entry, 'day', int):
      return False

    if not key_type_is(entry, 'renoteCount', int):
      return False

    if not key_type_is(entry, 'repliesCount', int):
      return False

    if not key_type_is(entry, 'reactionsCount', int):
      return False

    if not key_type_is(entry, 'pinned', bool):
      return False

    if not key_type_is(entry, 'renote', bool):
      return False

    if not key_type_is(entry, 'reply', bool):
      return False

    if not key_type_is(entry, 'inChannel', bool):
      return False

  return True


def find_latest_exported_json():
  """Find the latest notes-YYYY-MM-DD-HH-mm-SS.json file by lexicographic order.
  Returns absolute path or None if none found."""
  import glob
  import os

  cwd = os.path.dirname(__file__)
  pattern = os.path.join(cwd, 'exported_files', 'notes-*.json')
  files = glob.glob(pattern)
  if not files:
    return None
  files.sort()
  return files[-1]


def step1():
  logging.info('step 1 get pinned notes')
  result_i = json.loads(limitmanage.getI())
  pinned_ids = [note['id'] for note in result_i['pinnedNotes']]
  logging.info('pinned notes: ' + str(pinned_ids))
  return pinned_ids, result_i['id']


def step2(user_id):
  logging.info('step 2 list all my notes')
  all_notes = []
  until_id = None
  while True:
    result_notes_raw = limitmanage.net_runner(limitmanage.getUsersNotes, **{
      'user_id': user_id,
      'until_id': until_id,
      'include_replies': True,
      'limit': 100,
    })
    result_notes = json.loads(result_notes_raw)
    all_notes += result_notes

    if len(result_notes) == 0:
      break

    until_id = result_notes[-1]['id']
    if until_id is None:
      break

  logging.info('all notes: ' + str(len(all_notes)))
  # Step 2.2: merge with latest exported JSON file if present
  try:
    latest_json = find_latest_exported_json()

    if latest_json is not None:
      logging.info(f'step 2.2 merge notes from json: {latest_json}')
      with open(latest_json, 'r') as jf:
        json_notes = json.load(jf)
      # json export may contain a list of notes or an object with notes; try to handle list
      if isinstance(json_notes, dict) and 'notes' in json_notes:
        json_notes_list = json_notes['notes']
      elif isinstance(json_notes, list):
        json_notes_list = json_notes
      else:
        logging.warning('exported json format not recognized, skipping merge')
        json_notes_list = []

      if json_notes_list:
        # Merge by note id. Prefer API-fetched note data (assumed more recent) over JSON.
        notes_by_id = {n['id']: n for n in json_notes_list}
        # update/overwrite with API notes
        for n in all_notes:
          notes_by_id[n['id']] = n

        merged = list(notes_by_id.values())
        logging.info('merged notes count: ' + str(len(merged)))
        return merged
    else:
      logging.info('no exported notes json found; skipping step2.2')
  except Exception as e:
    logging.warning(f'failed to merge exported json: {e}')

  return all_notes


def step3(all_notes, pinned_ids, config):
  logging.info('step 3 list delete target')
  delete_ids = []
  now = datetime.now(timezone(timedelta(hours=0)))
  for note in all_notes:
    for rule in config:
      id = note['id']
      date = datetime.fromisoformat(note['createdAt'])
      days = rule['day']

      if date + timedelta(days) < now:
        if rule.get('pinned', False) and id in pinned_ids:
          logging.debug(f'skip: {id} is pinned at rule{days}')
          continue
        else:
          logging.debug(f'not match: {id} is pinned at rule{days}')

        if rule.get('renote', False) and note.get('renoteId', None) is not None:
          logging.debug(f'skip: {id} is renote at rule{days}')
          logging.debug(f'  renoteId: {note.get("renoteId")}')
          continue
        else:
          logging.debug(f'not match: {id} is renote at rule{days}')

        if rule.get('reply', False) and note.get('replyId', None) is not None:
          logging.debug(f'skip: {id} is reply at rule{days}')
          logging.debug(f'  replyId: {note.get("replyId")}')
          continue
        else:
          logging.debug(f'not match: {id} is reply at rule{days}')

        if rule.get('inChannel', False) and note.get('channelId', None) is not None:
          logging.debug(f'skip: {id} in channel at rule{days}')
          logging.debug(f'  channelId: {note.get("channelId")}')
          continue
        else:
          logging.debug(f'not match: {id} in channel at rule{days}')

        if rule.get('renoteCount', sys.maxsize) <= note.get('renoteCount', 0):
          logging.debug(f'skip: {id} greater than renoteCount of rule{days}')
          continue
        else:
          logging.debug(f'not match: {id} greater than renoteCount of rule{days}')
          logging.debug(f'  RULE renoteCount: {rule.get("renoteCount", sys.maxsize)}')
          logging.debug(f'  NOTE renoteCount: {note.get("renoteCount", 0)}')

        if rule.get('repliesCount', sys.maxsize) <= note.get('repliesCount', 0):
          logging.debug(f'skip: {id} greater than repliesCount of rule{days}')
          continue
        else:
          logging.debug(f'not match: {id} greater than repliesCount of rule{days}')
          logging.debug(f'  RULE repliesCount: {rule.get("repliesCount", sys.maxsize)}')
          logging.debug(f'  NOTE repliesCount: {note.get("repliesCount", 0)}')

        # config uses 'reactionsCount' (plural). Use that key consistently.
        if rule.get('reactionsCount', sys.maxsize) <= note.get('reactionsCount', 0):
          logging.debug(f'skip: {id} greater than reactionsCount of rule{days}')
          continue
        else:
          logging.debug(f'not match: {id} greater than reactionsCount of rule{days}')
          logging.debug(f'  RULE reactionsCount: {rule.get("reactionsCount", sys.maxsize)}')
          logging.debug(f'  NOTE reactionsCount: {note.get("reactionsCount", 0)}')

        logging.debug(f'add target {id} at rule{days}')
        delete_ids.append(id)
        break
    else:
      logging.debug(f'skip: {id} is not match deletion rules')

  logging.info('delete targets: ' + str(len(delete_ids)))
  return delete_ids


def step4(delete_ids):
  logging.info('step 4 delete notes')
  total = len(delete_ids)
  for i, id in enumerate(delete_ids):
    logging.info(f'delete: {id} ({i + 1}/{total})')
    limitmanage.net_runner(limitmanage.deleteNote, False, **{"note_id": id})


def fake_step4(delete_ids):
  """Fake step4 for Dry-Run: do not call delete API.
  This logs and prints the list of candidate ids and returns them.
  """
  logging.info('fake step 4 (no delete) - listing delete ids')
  logging.info('delete targets (fake): ' + str(len(delete_ids)))
  # Print only the count to stdout so output is compact and easy to read
  # (avoid printing long JSON list of ids)
  print(len(delete_ids))
  return delete_ids


if __name__ == '__main__':
  with open(limitmanage.env['LM_DELETERULE'], 'r') as config_file:
    config_data = json.loads(config_file.read())
  if not is_valid_config(config_data):
    exit(1)
  config = sorted(config_data, key=lambda cd: cd['day'])

  try:
    pinned_ids, user_id = step1()
    all_notes = step2(user_id)

    if limitmanage.env['LM_DELETE_STEP2PRINT'].upper() == 'TRUE':
      print(json.dumps(all_notes))

    delete_ids = step3(all_notes, pinned_ids, config)
    step4(delete_ids)
    # fake_step4(delete_ids) # for dry-run

  except Exception as e:
    logging.fatal(e)
    raise e
