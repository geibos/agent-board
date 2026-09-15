#!/usr/bin/env bash
# Забирает документы оригинала как есть, байт в байт, в upstream/.
# Ничего не подставляет и не переписывает — это делает tools/build-docs.sh.
#
# Зачем отдельный шаг. С российского маршрута крупный документ не доезжает:
# ответ приходит мгновенным всплеском ~20–26 КБ по проводу и обрывается
# навсегда. Замерено 2026-09-15 с Mac и с сервера, на HTTP/1.1 и HTTP/2, при
# gzip, br, zstd и без сжатия, на обоих адресах Cloudflare, с придушенной
# скоростью, — отсечки 19139…26255 байт, всегда в этой полосе. `Range`
# оригинал игнорирует (отвечает 200 и полным Content-Length), поэтому
# докачать кусками нельзя. Markdown-документы проходят потому, что хорошо
# жмутся: 45 КБ текста — это ~12 КБ по проводу. `openapi.json` на 767 839
# байт не влезает ни в одной кодировке, и по этой причине копия спеки на
# зеркале застряла на версии 1.7.0.
#
# Поэтому скачивание живёт в GitHub Actions (.github/workflows/upstream-docs.yml):
# раннер стоит на другом маршруте. Скрипт запускается и вручную — с любой
# машины, которой оригинал отдаёт документы целиком.
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN=${ORIGIN:-https://getpostingboard.dev}
OUT=${OUT:-upstream}
UA=${UA:-"agent-board-mirror-docs/1.0 (+https://github.com/geibos/agent-board)"}
DOCS=${DOCS:-"skill.md llms.txt openapi.json .well-known/getpostingboard.json mcp.md jovan.md pins.md meatproxy.md meatproxy-runtime.md politics.md b/guide"}

fail=0

for p in $DOCS; do
  mkdir -p "$OUT/$(dirname "$p")"
  tmp=$(mktemp)

  # Длину спрашиваем отдельным HEAD без сжатия: заголовки доезжают всегда,
  # даже когда тело обрывается, и это единственная доступная нам мера
  # целостности. Без неё оборванный документ выглядит как удачная загрузка —
  # ровно так копия politics.md однажды оказалась вдвое короче оригинала.
  want=$(curl -sS -I -A "$UA" -m 30 "$ORIGIN/$p" | tr -d '\r' \
         | awk 'tolower($1)=="content-length:" {print $2}' | tail -1)

  if ! curl -sSf --compressed -A "$UA" -m 300 -o "$tmp" "$ORIGIN/$p"; then
    echo "!! $p: загрузка не прошла" >&2
    rm -f "$tmp"; fail=1; continue
  fi

  got=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$got" -eq 0 ]; then
    echo "!! $p: пустой ответ" >&2
    rm -f "$tmp"; fail=1; continue
  fi
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "!! $p: оборван — получено $got байт, оригинал объявил $want" >&2
    rm -f "$tmp"; fail=1; continue
  fi

  # JSON обязан разбираться. Обрыв ровно по границе строки возможен, и
  # совпадение длины его бы не поймало.
  case "$p" in
    *.json)
      if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; then
        echo "!! $p: не разбирается как JSON" >&2
        rm -f "$tmp"; fail=1; continue
      fi
      ;;
  esac

  mv "$tmp" "$OUT/$p"
  printf '   %-40s %8s байт%s\n' "$p" "$got" "$([ -n "$want" ] && echo " (длина сошлась)" || echo " (длина не объявлена)")"
done

# Отметка происхождения: какой адрес, когда, и версия спеки — чтобы «свежесть»
# копии была числом, а не ощущением.
ver=$(python3 -c 'import json;print(json.load(open("'"$OUT"'/openapi.json"))["info"]["version"])' 2>/dev/null || echo unknown)
python3 - "$OUT" "$ORIGIN" "$ver" <<'PY'
import json, os, sys, time, hashlib
out, origin, ver = sys.argv[1], sys.argv[2], sys.argv[3]
files = {}
for root, _, names in os.walk(out):
    for n in sorted(names):
        p = os.path.join(root, n)
        rel = os.path.relpath(p, out)
        if rel == 'FETCHED.json':
            continue
        b = open(p, 'rb').read()
        files[rel] = {'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
json.dump({
    'origin': origin,
    'fetched_at': int(time.time()),
    'fetched_at_iso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'openapi_version': ver,
    'note': 'Verbatim copies of the origin documents. Nothing is substituted here; '
            'tools/build-docs.sh does that. Fetched from a route that delivers them whole.',
    'files': files,
}, open(os.path.join(out, 'FETCHED.json'), 'w'), ensure_ascii=False, indent=2)
print(f'\nopenapi {ver}, документов {len(files)}')
PY

[ "$fail" -eq 0 ] || { echo "часть документов не забрана — upstream/ обновлён только там, где загрузка прошла" >&2; exit 1; }
