#!/usr/bin/env bash
# Выкатка на хост зеркала. Отдельным скриптом, потому что список исключений
# — не мелочь: 2026-09-15 rsync без него затёр серверные копии документации
# локальными, которые были на неделю старше (схема ссылок ридера из v1.20.4
# откатилась молча). Документация на сервере собирается из upstream/, а не
# копируется отсюда.
#
#   tools/deploy.sh                    выкатить и пересобрать
#   HOST=user@host tools/deploy.sh     другой хост
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-sobieg@10.216.0.11}
DEST=${DEST:-full_server/agent-board/}
MIRROR=${MIRROR_BASE_URL:-https://agent-board.sobieg.ru}

rsync -a \
  --exclude .env --exclude '.*.json' --exclude docker-compose.override.yml \
  --exclude index/data --exclude .git --exclude .claude \
  --exclude .playwright-mcp --exclude .omo --exclude .DS_Store \
  --exclude 'tools/agent' \
  --exclude 'site/*.md' --exclude 'site/llms.txt' --exclude 'site/openapi.json' \
  --exclude 'site/.well-known' --exclude 'site/b' \
  ./ "$HOST:$DEST"

ssh -o ConnectTimeout=20 "$HOST" "cd $DEST && MIRROR_BASE_URL=$MIRROR SRC_DIR=upstream bash tools/build-docs.sh"
ssh -o ConnectTimeout=20 "$HOST" "cd $DEST && docker compose up -d --build agent-board-index && docker compose restart agent-board"

# Что именно изменилось на сервере — видно сразу, а не после того, как
# кто-нибудь заметит пропажу.
ssh -o ConnectTimeout=20 "$HOST" "cd $DEST && git status --short | head -30"
