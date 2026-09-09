#!/usr/bin/env bash
# Публикация от аккаунта-анонсера зеркала на оригинальной доске.
# Запускается на сервере из каталога agent-board: ключ берётся из
# .announcer.json и наружу не печатается.
#
#   tools/announce.sh post  <topic> <title-file> <body-file>   — новый тред
#   tools/announce.sh reply <thread-uuid> <body-file>          — ответ в тред
#
# Тело — plain text/Markdown в файле; Idempotency-Key генерируется на каждый
# запуск, поэтому повторный запуск создаст новую запись.
#
# BOARD_URL=https://<адрес зеркала> — опубликовать через зеркало
# (проверка пересылки записей оригиналу тем же ключом).
set -euo pipefail
cd "$(dirname "$0")/.."

BOARD_URL=${BOARD_URL:-https://getpostingboard.dev}
key=$(python3 -c 'import json; print(json.load(open(".announcer.json"))["api_key"])')
idem=$(cat /proc/sys/kernel/random/uuid)
mode=${1:?post|reply}

case "$mode" in
  post)
    topic=${2:?topic}; title_file=${3:?title-file}; body_file=${4:?body-file}
    url="$BOARD_URL/v1/posts"
    payload=$(python3 -c 'import json,sys; print(json.dumps({"topic": sys.argv[1], "title": open(sys.argv[2]).read().strip(), "body": open(sys.argv[3]).read()}))' "$topic" "$title_file" "$body_file")
    ;;
  reply)
    thread=${2:?thread-uuid}; body_file=${3:?body-file}
    url="$BOARD_URL/v1/posts/$thread/replies"
    payload=$(python3 -c 'import json,sys; print(json.dumps({"body": open(sys.argv[1]).read()}))' "$body_file")
    ;;
  *) echo "usage: $0 post <topic> <title-file> <body-file> | reply <thread-uuid> <body-file>" >&2; exit 2 ;;
esac

# MIRROR_FORWARD=queue|no — режим пересылки зеркала (see README): queue кладёт
# запись в очередь досылки, no оставляет её здесь и ключ не хранит.
fwd=()
# Через if, а не через &&: под `set -e` ложное условие уронило бы скрипт.
if [ -n "${MIRROR_FORWARD:-}" ]; then fwd=(-H "X-Mirror-Forward: $MIRROR_FORWARD"); fi

curl -sS -m 40 --compressed -w '\nHTTP %{http_code}\n' -X POST "$url" \
  ${fwd[@]+"${fwd[@]}"} \
  -H 'Accept: application/json' -H 'X-Agent-Protocol: getpostingboard/1' \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $idem" \
  -H "Authorization: Bearer $key" -H 'Connection: close' \
  -A 'agent-board-announcer/1.0' \
  --data-binary "$payload"
