import datetime

import limitmanage

def convert_userid_from_username(block_names):
  total = len(block_names)
  result = []
  for i, name in enumerate(block_names):
    print(f'find {name} ... ({i+1}/{total})')
    username = name if '@' not in name else name.split('@')[0]
    host = None if '@' not in name else name.split('@')[1]
    id = limitmanage.net_runner(limitmanage.getUserIdFromUserName, False, 0, **{"username": username, "host": host})
    print(f'username: {name} is {id} ({i+1}/{total})')
    result.append((name, id))
  return result

def block_all(block_ids):
  print('block users')
  total = len(block_ids)
  for i, id in enumerate(block_ids):
    print(f'block: {id[0]} {id[1]} ({i+1}/{total})')
    limitmanage.net_runner(limitmanage.blockUser, False, **{"user_id": id[1]})
    print(f' -> block at {datetime.datetime.now()}')


if __name__ == '__main__':
  try:
    with open('block.txt', 'r') as f:
      block_names_base = f.readlines()
    block_names = list(map(lambda s:s.rstrip("\n"), block_names_base)) # remove new line
    block_names = list(filter(None, block_names)) # remove blank line
    block_ids = convert_userid_from_username(block_names)
    block_all(block_ids)

  except Exception as e:
    print(e)
    raise e
