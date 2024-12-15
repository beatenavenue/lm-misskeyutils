import datetime

import limitmanage

def convert_userid_from_username(mute_names):
  total = len(mute_names)
  result = []
  for i, name in enumerate(mute_names):
    print(f'find {name} ... ({i+1}/{total})')
    username = name if '@' not in name else name.split('@')[0]
    host = None if '@' not in name else name.split('@')[1]
    id = limitmanage.net_runner(limitmanage.getUserIdFromUserName, False, 0, **{"username": username, "host": host})
    print(f'username: {name} is {id} ({i+1}/{total})')
    result.append((name, id))
  return result

def mute_all(mute_ids):
  print('mute users')
  total = len(mute_ids)
  for i, id in enumerate(mute_ids):
    print(f'mute: {id[0]} {id[1]} ({i+1}/{total})')
    limitmanage.net_runner(limitmanage.muteUser, False, **{"user_id": id[1]})
    print(f' -> mute at {datetime.datetime.now()}')


if __name__ == '__main__':
  try:
    with open('mute.txt', 'r') as f:
      mute_names_base = f.readlines()
    mute_names = list(map(lambda s:s.rstrip("\n"), mute_names_base)) # remove new line
    mute_names = list(filter(None, mute_names)) # remove blank line
    mute_ids = convert_userid_from_username(mute_names)
    mute_all(mute_ids)

  except Exception as e:
    print(e)
    raise e
