from datetime import datetime, timedelta, timezone
import json
import logging

import limitmanage


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
        'user_id': user_id, 'until_id': until_id, 'include_replies': True})
    result_notes = json.loads(result_notes_raw)
    all_notes += result_notes

    if len(result_notes) == 0:
      break

    until_id = result_notes[-1]['id']
    if until_id is None:
      break

  logging.info('all notes: ' + str(len(all_notes)))
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

        if rule.get('renote', False) and note.get('renoteId', None) is not None:
          logging.debug(f'skip: {id} is renote at rule{days}')
          continue
        
        if rule.get('reply', False) and note.get('replyId', None) is not None:
          logging.debug(f'skip: {id} is reply at rule{days}')
          continue

        if rule.get('renoteCount', -1) <= note.get('renoteCount', 0):
          logging.debug(f'skip: {id} greater than renoteCount of rule{days}')
          continue

        if rule.get('repliesCount', -1) <= note.get('repliesCount', 0):
          logging.debug(f'skip: {id} greater than repliesCount of rule{days}')
          continue

        if rule.get('reactionsCount', -1) <= note.get('reactionsCount', 0):
          logging.debug(f'skip: {id} greater than reactionsCount of rule{days}')
          continue

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
    logging.info(f'delete: {id} ({i+1}/{total})')
    limitmanage.net_runner(limitmanage.deleteNote, False, **{"note_id": id})


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

  except Exception as e:
    logging.fatal(e)
    raise e
