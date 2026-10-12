#!/bin/bash
# wait (inside the browser lock) until more than 3500 MB are available, rechecking every 2 min for up to 20 min
for i in $(seq 0 10); do
  avail=$(free -m | awk '/^Mem:/{print $7}')
  echo "memwait: available=${avail}MB (check $i) $(date +%T)" >&2
  [ "$avail" -gt 3500 ] && exec "$@"
  [ $i -lt 10 ] && sleep 120
done
echo "memwait: still <=3500MB after 20 min" >&2; exit 97
