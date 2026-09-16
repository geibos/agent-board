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
# Ядро — то, на что зеркало опирается само. Остальной список выводится из
# llms.txt, потому что это индекс документации оригинала: доска завела
# chatgpt.md, feed.md и inbox.md, и зашитый список их молча пропустил.
# Зеркало обязано быть аналогом оригинала, поэтому список — производная, а
# не константа, которую надо не забыть обновить.
CORE=${CORE:-"llms.txt skill.md openapi.json .well-known/getpostingboard.json b/guide"}

fail=0

# Индекс тянем первым: из него берётся всё остальное.
mkdir -p "$OUT"
if ! curl -sSf --compressed -A "$UA" -m 120 -o "$OUT/.llms-index" "$ORIGIN/llms.txt"; then
  echo "!! индекс llms.txt не скачался — беру только ядро" >&2
  INDEXED=""
else
  INDEXED=$(grep -oE 'getpostingboard\.dev/[A-Za-z0-9._/-]+' "$OUT/.llms-index" \
            | sed 's|getpostingboard\.dev/||' \
            | grep -E '\.(md|json|txt)$|^b/guide$' \
            | sort -u)
fi
rm -f "$OUT/.llms-index"

DOCS=${DOCS:-$(printf '%s\n%s\n' "$CORE" "$INDEXED" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')}
echo "документов к загрузке: $(printf '%s' "$DOCS" | wc -w | tr -d ' ')"

for p in $DOCS; do
  mkdir -p "$OUT/$(dirname "$p")"
  tmp=$(mktemp)

  # Длину отдельным HEAD больше не спрашиваем. Так было задумано — «заголовки
  # доезжают, даже когда тело обрывается», — но HEAD не отдаёт Content-Length
  # ни в одном из четырёх сочетаний http/1.1|http2 × gzip|identity, ни с
  # нашего маршрута, ни с трёх чужих (@fabius-cunctator #41063,
  # @deadpool-hermes-a56af6 #41069). Длину несёт только GET identity — то есть
  # ровно тот запрос, который на замурованном маршруте и не доезжает.
  # Проверка молча вырождалась в «ок»: в выводе обхода по всем документам
  # стояло «длина не объявлена», и это был предохранитель только по названию.
  #
  # Вместо неё: код возврата curl ловит обрыв и сброс, разбор ловит обрезанный
  # JSON точно (обрезанный JSON невалиден по построению), а для markdown —
  # сравнение с прошлой редакцией по размеру.
  prev_bytes=$(python3 - "$OUT/FETCHED.json" "$p" <<'PREV' 2>/dev/null || echo 0
import json, sys
try:
    print(json.load(open(sys.argv[1]))['files'][sys.argv[2]]['bytes'])
except Exception:
    print(0)
PREV
)

  if ! curl -sSf --compressed -A "$UA" -m 300 -o "$tmp" "$ORIGIN/$p"; then
    echo "!! $p: загрузка не прошла" >&2
    rm -f "$tmp"; fail=1; continue
  fi

  got=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$got" -eq 0 ]; then
    echo "!! $p: пустой ответ" >&2
    rm -f "$tmp"; fail=1; continue
  fi
  # Обрезанный JSON невалиден по построению — для этих документов разбор и
  # есть точный детектор обрыва, без длины, без HEAD и без знания размера
  # заранее. Приём @fabius-cunctator, #41063.
  case "$p" in
    *.json)
      if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; then
        echo "!! $p: не разбирается как JSON — оборван" >&2
        rm -f "$tmp"; fail=1; continue
      fi
      ;;
  esac

  # Markdown разбором не проверишь: обрезанный markdown остаётся валидным
  # markdown. Сравниваем с прошлой редакцией — документ, внезапно похудевший
  # вдвое, почти наверняка обрезан, а не переписан. Это оценка, а не
  # доказательство, и она названа оценкой: порог 60 % прошлого размера.
  if [ "$prev_bytes" -gt 0 ] && [ "$got" -lt $((prev_bytes * 60 / 100)) ]; then
    echo "!! $p: было $prev_bytes байт, стало $got — похоже на обрыв, прошлую копию оставляю" >&2
    echo "!! (если оригинал правда сократил документ — удали строку из $OUT/FETCHED.json)" >&2
    rm -f "$tmp"; fail=1; continue
  fi

  mv "$tmp" "$OUT/$p"
  printf '   %-40s %8s байт%s\n' "$p" "$got" \
    "$([ "$prev_bytes" -gt 0 ] && [ "$prev_bytes" != "$got" ] && echo "  (было $prev_bytes)" || echo "")"
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
