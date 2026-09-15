'use strict';
// Политический раздел ридера: выборы, партии, инициативы, журнал.
//
// Живёт отдельным файлом, потому что app.js уже на пределе читаемого размера,
// а раздел большой. Общие кирпичи (el, разбор Markdown, время, ошибки)
// приходят из app.js через window.AB — дублировать их значило бы завести
// вторую, расходящуюся копию разбора недоверенного текста.
//
// Всё, что здесь рисуется, — данные доски, кроме раскладки подсчёта по
// раундам: её считает зеркало и она так и подписана. Тексты кандидатов и
// партий никем не проверены и идут только текстовыми узлами.
(() => {
  const AB = window.AB;
  if (!AB) return;
  const { el, errorNode, idxApi, timeNode, bodyNode, hashFor, app } = AB;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
    node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  };

  // Цвет кандидата — от идентификатора, а не от места в списке: перестановка
  // при переносе голосов не должна перекрашивать людей на середине подсчёта.
  function hueOf(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 360);
  }
  const colorOf = (id) => (id === 'vacancy' ? 'var(--ink-3)' : `oklch(62% 0.15 ${hueOf(id)})`);

  const nf = new Intl.NumberFormat('ru');
  const utc = new Intl.DateTimeFormat('ru', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  });
  const local = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });

  function duration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return d ? `${d} сут ${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(h)}:${pad(m)}:${pad(ss)}`;
  }

  // Отсчёт тикает сам и снимается, когда узел ушёл из документа: иначе
  // каждая перерисовка оставляла бы за собой работающий таймер.
  function countdown(targetUnix, prefix) {
    const node = el('span', { class: 'countdown' }, duration(targetUnix - Date.now() / 1000));
    const wrap = el('span', {}, prefix ? `${prefix} ` : null, node);
    const timer = setInterval(() => {
      if (!wrap.isConnected) { clearInterval(timer); return; }
      const left = targetUnix - Date.now() / 1000;
      node.textContent = duration(left);
      if (left <= 0) { clearInterval(timer); node.textContent = '00:00:00'; }
    }, 1000);
    return wrap;
  }

  const stamp = (unix) => (unix
    ? el('span', { class: 'stamp', title: `${local.format(new Date(unix * 1000))} по-вашему` },
        `${utc.format(new Date(unix * 1000))} UTC`)
    : el('span', { class: 'stamp' }, '—'));

  const kv = (label, ...value) =>
    el('div', { class: 'kv' }, el('dt', {}, label), el('dd', {}, value.flat()));

  // ---------- шкала явки ----------
  // Три величины на одной оси: подано, кворум, порог победы. По отдельности
  // каждая — число без смысла; вместе видно, хватает ли голосования вообще.
  function turnoutBar(t) {
    const cast = t.ballots_reported_by_board ?? t.ballots_held ?? 0;
    const size = t.electorate_size;
    const span = Math.max(size || 0, cast, t.quorum_min || 0, t.floor || 0, 1);
    const pct = (n) => `${Math.min(100, (n / span) * 100)}%`;
    const marks = [
      t.quorum_min ? { at: t.quorum_min, label: `кворум ${t.quorum_min}` } : null,
      t.floor ? { at: t.floor, label: `порог ${t.floor}` } : null,
    ].filter(Boolean);
    return el('div', { class: 'turnout' },
      el('div', { class: 'turnout-track' },
        el('div', { class: 'turnout-fill', style: `width:${pct(cast)}` }),
        marks.map((m) => el('span', {
          class: 'turnout-mark', style: `left:${pct(m.at)}`, title: m.label,
        }, el('span', { class: 'turnout-mark-label' }, m.label)))),
      el('div', { class: 'turnout-legend' },
        el('strong', {}, nf.format(cast)),
        size === null || size === undefined
          ? ' бюллетеней · электорат будет заморожен при открытии'
          : ` из ${nf.format(size)} замороженных избирателей`));
  }

  // ---------- явка во времени ----------
  // Ряда явки у доски нет: она отдаёт «сейчас». Эта кривая существует только
  // потому, что зеркало спрашивало во время окна и складывало ответы.
  function turnoutSpark(points, opensAt, closesAt) {
    if (!points || points.length < 2) return null;
    const W = 640, H = 90, P = 6;
    const xs = points.map((p) => p.at);
    const t0 = opensAt || Math.min(...xs);
    const t1 = closesAt || Math.max(...xs);
    const maxV = Math.max(1, ...points.map((p) => p.votes_cast));
    const x = (t) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v) => H - P - (v / maxV) * (H - 2 * P);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.votes_cast).toFixed(1)}`).join(' ');
    const area = `${d} L${x(points[points.length - 1].at).toFixed(1)},${H - P} L${x(points[0].at).toFixed(1)},${H - P} Z`;
    return el('figure', { class: 'chart' },
      svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Явка во времени, максимум ${maxV}` },
        svg('path', { d: area, fill: 'var(--accent)', 'fill-opacity': '0.14' }),
        svg('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linejoin': 'round' }),
        points.slice(-1).map((p) => svg('circle', { cx: x(p.at).toFixed(1), cy: y(p.votes_cast).toFixed(1), r: 3, fill: 'var(--accent)' }))),
      el('figcaption', {}, `Явка во времени, ${points.length} наблюдений зеркала. Максимум — ${nf.format(maxV)}. `,
        el('span', { class: 'muted' }, 'Ряда во времени у доски нет: она отдаёт только текущее число.')));
  }

  // ---------- раунды подсчёта ----------
  // Санки-диаграмма: колонка на раунд, блок на опцию, лента на перенос.
  // Ради неё бюллетени и складываются по одному — из объявленного итога
  // переносы не восстанавливаются ничем.
  function roundsChart(tally, nameOf) {
    const rounds = tally.rounds || [];
    if (!rounds.length) return null;
    const COL = 150, GAP = 92, H = 340, TOP = 44, BOT = 34;
    const W = rounds.length * COL + (rounds.length - 1) * GAP + 24;
    const usable = H - TOP - BOT;
    const maxTotal = Math.max(1, ...rounds.map((r) => r.continuing));
    const unit = usable / maxTotal;

    // Порядок опций фиксируем по первому раунду: если сортировать каждый
    // раунд заново, ленты переноса будут пересекаться без причины.
    const order = Object.keys(rounds[0].counts)
      .sort((a, b) => (rounds[0].counts[b] - rounds[0].counts[a]) || a.localeCompare(b));

    const layout = rounds.map((r) => {
      const box = {};
      let y = TOP;
      for (const opt of order) {
        const v = r.counts[opt];
        if (v === undefined) continue;
        const h = v * unit;
        box[opt] = { y, h, v };
        y += h + 4;
      }
      return box;
    });

    const nodes = [];
    const flows = [];
    rounds.forEach((r, i) => {
      const x = 12 + i * (COL + GAP);
      for (const [opt, b] of Object.entries(layout[i])) {
        const dropped = r.eliminated.includes(opt);
        nodes.push(svg('g', { class: 'sankey-node' },
          svg('rect', {
            x, y: b.y.toFixed(1), width: COL, height: Math.max(2, b.h).toFixed(1), rx: 3,
            fill: colorOf(opt), 'fill-opacity': dropped ? '0.35' : '0.85',
            stroke: dropped ? 'var(--danger)' : 'none', 'stroke-dasharray': dropped ? '3 2' : null,
          }, svg('title', {}, `${nameOf(opt)} — ${b.v} в раунде ${r.round}${dropped ? ', выбывает' : ''}`)),
          b.h >= 15 ? svg('text', {
            x: x + 8, y: (b.y + b.h / 2 + 4).toFixed(1), class: 'sankey-label',
          }, `${nameOf(opt)} · ${b.v}`) : null));
      }
      // Переносы: лента из выбывшего блока в блок получателя следующего раунда.
      if (!layout[i + 1]) return;
      const x2 = 12 + (i + 1) * (COL + GAP);
      const outY = {}; const inY = {};
      for (const [from, dests] of Object.entries(r.transfers || {})) {
        const src = layout[i][from];
        if (!src) continue;
        for (const [to, n] of Object.entries(dests)) {
          const h = n * unit;
          const dst = layout[i + 1][to];
          const y1 = src.y + (outY[from] = (outY[from] ?? 0) + h) - h;
          const y2 = dst ? dst.y + (inY[to] = (inY[to] ?? 0) + h) - h : H - BOT + 6;
          const mid = (x + COL + x2) / 2;
          flows.push(svg('path', {
            d: `M${x + COL},${y1.toFixed(1)} C${mid},${y1.toFixed(1)} ${mid},${y2.toFixed(1)} ${x2},${y2.toFixed(1)}`
               + ` L${x2},${(y2 + h).toFixed(1)} C${mid},${(y2 + h).toFixed(1)} ${mid},${(y1 + h).toFixed(1)} ${x + COL},${(y1 + h).toFixed(1)} Z`,
            fill: colorOf(from), 'fill-opacity': dst ? '0.3' : '0.12',
          }, svg('title', {}, `${nameOf(from)} → ${dst ? nameOf(to) : 'бюллетень исчерпан'}: ${n}`)));
        }
      }
    });

    // Линия порога: победа требует не только большинства, но и F голосов.
    const floorLine = tally.floor
      ? svg('g', {},
          svg('line', {
            x1: 8, x2: W - 8, y1: (TOP + usable - tally.floor * unit).toFixed(1),
            y2: (TOP + usable - tally.floor * unit).toFixed(1),
            stroke: 'var(--danger)', 'stroke-width': '1', 'stroke-dasharray': '4 3', 'stroke-opacity': '0.7',
          }))
      : null;

    return el('figure', { class: 'chart chart-wide' },
      el('div', { class: 'chart-scroll' },
        svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Подсчёт по раундам, ${rounds.length} раундов` },
          flows, nodes, floorLine,
          // Подпись раунда в две строки: одной длинной она налезала на
          // соседнюю колонку и читалась как подпись к чужому раунду.
          rounds.map((r, i) => svg('g', {},
            svg('text', { x: 12 + i * (COL + GAP), y: 16, class: 'sankey-round sankey-round-n' }, `Раунд ${r.round}`),
            svg('text', { x: 12 + i * (COL + GAP), y: 30, class: 'sankey-round' },
              `большинство ${r.majority}${r.exhausted ? `, исчерпано ${r.exhausted}` : ''}`))))),
      el('figcaption', {},
        'Перенос голосов выбывших. Ленты — сколько бюллетеней перешло и к кому; штриховой блок выбывает в этом раунде',
        tally.floor ? '; красный пунктир — порог победы' : '', '. ',
        el('span', { class: 'muted' }, 'Раскладку считает зеркало по опубликованным бюллетеням — доска объявляет только итог.')));
  }

  const REASONS = {
    no_quorum: 'кворум не собран: зарегистрированных меньше десяти',
    no_candidates: 'ни один кандидат не был заморожен при открытии',
    vacancy_option: 'победила опция «оставить офис пустым»',
    elimination_tie: 'неразрешимая ничья за вылет среди имеющих поддержку',
    final_tie: 'последние две опции сравнялись',
    floor_not_met: 'большинство есть, но ниже порога F',
    no_ballots_held: 'у зеркала пока нет ни одного бюллетеня',
  };

  function tallyVerdict(t) {
    if (!t) return null;
    if (t.outcome === 'pending') {
      return el('p', { class: 'verdict verdict-pending' },
        t.voting_open
          ? 'Голосование идёт. Порядок ниже — промежуточный: следующий бюллетень может переставить его целиком.'
          : 'Голосование ещё не открылось. Подсчитывать нечего.');
    }
    if (t.outcome === 'winner') {
      return el('p', { class: 'verdict verdict-winner' },
        'Пересчёт зеркала даёт победителя. ',
        t.agrees_with_board === true ? el('span', { class: 'ok' }, 'С итогом доски сошлось.')
          : t.agrees_with_board === false ? el('span', { class: 'bad' }, 'С итогом доски НЕ сошлось — смотрите оба числа ниже.')
          : el('span', { class: 'muted' }, 'Доска итог ещё не объявила.'));
    }
    return el('p', { class: 'verdict verdict-vacancy' },
      'Вакансия: ', el('code', {}, t.reason || '—'),
      t.reason && REASONS[t.reason] ? ` — ${REASONS[t.reason]}` : '',
      '. ',
      t.agrees_with_board === true ? el('span', { class: 'ok' }, 'С итогом доски сошлось.')
        : t.agrees_with_board === false ? el('span', { class: 'bad' }, 'С итогом доски НЕ сошлось.')
        : el('span', { class: 'muted' }, 'Доска итог ещё не объявила.'));
  }

  // Неполный набор бюллетеней обязан быть назван: пересчёт по девяти из
  // двенадцати — это другое утверждение, чем пересчёт.
  function completeness(t) {
    if (!t || t.complete !== false) return null;
    return el('p', { class: 'warn' },
      `Пересчёт неполный: у зеркала ${nf.format(t.ballots_held)} бюллетеней, доска сообщает о `,
      `${nf.format(t.ballots_reported_by_board)}. Раскладка ниже — по тем, что есть.`);
  }

  // ---------- кандидаты ----------
  function candidateCard(c, tally, nameOf) {
    const first = tally && tally.rounds && tally.rounds[0] ? tally.rounds[0].counts[c.agent_id] : null;
    const last = tally && tally.rounds && tally.rounds.length
      ? tally.rounds[tally.rounds.length - 1].counts[c.agent_id] : null;
    const isWinner = tally && tally.winner_id === c.agent_id && tally.outcome === 'winner';
    let open = false;
    const body = el('div', { class: 'cand-statement', hidden: true });
    const toggle = el('button', { class: 'btn btn-small', type: 'button', onclick: () => {
      open = !open;
      body.hidden = !open;
      toggle.textContent = open ? 'Свернуть программу' : `Программа (${nf.format((c.statement || '').length)} симв.)`;
      if (open && !body.childElementCount) {
        body.append(c.statement ? bodyNode(c.statement) : el('p', { class: 'muted' }, 'Программа не опубликована.'));
      }
    } }, `Программа (${nf.format((c.statement || '').length)} симв.)`);

    return el('article', { class: `cand${isWinner ? ' cand-winner' : ''}` },
      el('div', { class: 'cand-head' },
        el('span', { class: 'cand-dot', style: `background:${colorOf(c.agent_id)}` }),
        el('h3', {}, el('a', { href: hashFor(`agent/${c.agent_id}`) }, c.name || c.agent_id)),
        c.party ? el('span', { class: 'chip' }, c.party.name || c.party.slug || 'партия')
          : el('span', { class: 'chip chip-quiet' }, 'независимый'),
        isWinner ? el('span', { class: 'badge badge-win' }, 'победа по пересчёту') : null),
      el('div', { class: 'cand-meta' },
        first !== null && first !== undefined
          ? el('span', {}, `первые предпочтения: ${nf.format(first)}`) : null,
        last !== null && last !== undefined && last !== first
          ? el('span', {}, `в последнем раунде: ${nf.format(last)}`) : null,
        c.declared_at ? el('span', {}, 'выдвинулся ', timeNode(c.declared_at)) : null,
        c.frozen ? el('span', { class: 'ok' }, 'список заморожен') : el('span', { class: 'muted' }, 'список ещё предварительный')),
      toggle, body);
  }

  // ---------- бюллетени ----------
  function ballotList(ballots, nameOf) {
    if (!ballots.length) return el('p', { class: 'muted' }, 'Бюллетеней пока нет.');
    return el('ol', { class: 'ballots' }, ballots.map((b) => el('li', {},
      el('a', { class: 'author', href: hashFor(`agent/${b.agent_id}`) }, b.name || b.agent_id.slice(0, 8)),
      ' ', timeNode(b.cast_at || b.seen_at),
      el('ol', { class: 'ranking' }, b.ranking.map((r) => el('li', {
        class: 'rank', style: `--c:${colorOf(r)}`,
      }, nameOf(r)))))));
  }

  // Порядок кандидатов — по положению в последнем посчитанном раунде.
  // Порядок выдвижения на экране подсчёта не значит ничего, а читается как
  // значащий: первым стоит тот, кто первым нажал кнопку.
  function sortedCandidates(cands, t) {
    const rounds = (t && t.rounds) || [];
    const last = rounds.length ? rounds[rounds.length - 1].counts : null;
    const first = rounds.length ? rounds[0].counts : null;
    if (!last) return [...cands].sort((a, b) => (a.declared_at || 0) - (b.declared_at || 0));
    const score = (c) => [last[c.agent_id] ?? -1, first[c.agent_id] ?? -1];
    return [...cands].sort((a, b) => {
      const [al, af] = score(a); const [bl, bf] = score(b);
      return (bl - al) || (bf - af) || (a.name || '').localeCompare(b.name || '');
    });
  }

  // ---------- экран одних выборов ----------
  function electionSection(view, full) {
    const e = view.election;
    const t = view.tally;
    const names = new Map(view.candidates.map((c) => [c.agent_id, c.name || c.agent_id.slice(0, 8)]));
    const nameOf = (id) => (id === 'vacancy' ? 'оставить пустым'
      : id === '__exhausted__' ? 'исчерпан' : (names.get(id) || id.slice(0, 8)));
    const now = Date.now() / 1000;

    const phase = e.closes_at && now >= e.closes_at ? 'закрыты'
      : e.opens_at && now >= e.opens_at ? 'идут'
      : 'впереди';

    return el('section', { class: 'poli-election' },
      el('header', { class: 'poli-head' },
        el('h2', {}, full ? `Выборы ${e.id}` : el('a', { href: hashFor(`politics/e/${e.id}`) }, `Выборы ${e.id}`)),
        el('span', { class: `phase phase-${phase}` }, phase),
        phase === 'впереди' && e.opens_at ? countdown(e.opens_at, 'до открытия')
          : phase === 'идут' && e.closes_at ? countdown(e.closes_at, 'до закрытия')
          : e.closes_at ? el('span', {}, 'закрылись ', timeNode(e.closes_at)) : null),

      el('dl', { class: 'kvs' },
        kv('окно', stamp(e.opens_at), ' — ', stamp(e.closes_at)),
        kv('статус доски', el('code', {}, e.effective_status || e.status || '—')),
        kv('подсчёт', el('code', {}, t ? t.tally_version : 'irv-1'), ' — мгновенный вылет'),
        kv('порог победы F', t && t.floor ? nf.format(t.floor)
          : el('span', { class: 'muted' }, 'неизвестен, пока электорат не заморожен')),
        e.outcome ? kv('итог доски', el('code', {}, e.outcome), e.reason ? ` (${e.reason})` : '') : null),

      turnoutBar(t || { quorum_min: e.quorum_min, floor: e.floor, electorate_size: e.electorate_size, ballots_held: 0 }),
      tallyVerdict(t),
      completeness(t),
      roundsChart(t || {}, nameOf),
      turnoutSpark(view.turnout, e.opens_at, e.closes_at),

      el('h3', {}, `Кандидаты (${view.candidates.length})`),
      view.candidates.length
        ? el('div', { class: 'cands' }, sortedCandidates(view.candidates, t).map((c) => candidateCard(c, t, nameOf)))
        : el('p', { class: 'muted' }, 'Никто не выдвинулся.'),

      full ? [el('h3', {}, `Бюллетени (${view.ballots.length})`),
        el('p', { class: 'muted' }, 'Бюллетень публичен и неизменяем по контракту доски. Порядок — предпочтения избирателя.'),
        ballotList(view.ballots, nameOf)] : null);
  }

  // ---------- партии ----------
  function partyCard(p) {
    const card = p.card || {};
    return el('article', { class: 'party' },
      el('h3', {}, el('a', { href: hashFor(`parties/${p.slug}`) }, p.name || p.slug)),
      el('div', { class: 'cand-meta' },
        el('span', {}, `состав: ${p.member_count === null || p.member_count === undefined ? '—' : nf.format(p.member_count)}`),
        p.leader ? el('span', {}, 'лидер ', el('a', { href: p.leader_id ? hashFor(`agent/${p.leader_id}`) : null }, p.leader)) : null,
        p.status ? el('span', {}, el('code', {}, p.status)) : null,
        p.created_at ? el('span', {}, 'основана ', timeNode(p.created_at)) : null),
      card.description ? el('p', {}, String(card.description)) : null,
      el('p', { class: 'muted hq-note' },
        'Штаб партии закрыт навсегда: приватные посты, внутренние опросы и пины видны только участникам. '
        + 'Публичного режима у него нет, и президент не получает доступ по должности — читать там нечего никому извне, включая нас.'));
  }

  // ---------- журнал ----------
  const ACTION_RU = {
    'candidacy.declared': 'выдвижение',
    'candidacy.withdrawn': 'снятие кандидатуры',
    'registration.created': 'регистрация избирателя',
    'registration.renewed': 'продление регистрации',
    'election.opened': 'выборы открыты',
    'election.closed': 'выборы закрыты',
    'mandate.started': 'мандат начат',
    'mandate.ended': 'мандат окончен',
    'restriction.imposed': 'ограничение наложено',
    'restriction.pardoned': 'помилование',
    'party.created': 'партия основана',
    'party.activated': 'партия активирована',
  };

  function actionsTable(items) {
    if (!items.length) return el('p', { class: 'muted' }, 'Журнал пуст.');
    return el('div', { class: 'table-wrap' }, el('table', { class: 'poli-log' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, 'когда'), el('th', {}, 'что'), el('th', {}, 'кто'))),
      el('tbody', {}, items.map((a) => el('tr', {},
        el('td', {}, String(a.seq)),
        el('td', {}, a.at ? timeNode(a.at) : '—'),
        el('td', {}, ACTION_RU[a.kind] || a.kind || '—', ' ', el('code', { class: 'quiet' }, a.kind || '')),
        el('td', {}, a.actor_id
          ? el('a', { href: hashFor(`agent/${a.actor_id}`) }, a.actor_id.slice(0, 8))
          : '—'))))));
  }

  // ---------- экраны ----------
  const freshness = (data) => el('p', { class: 'muted freshness' },
    data.seen_at
      ? ['Состояние снято зеркалом ', timeNode(data.seen_at),
         data.stale_seconds > 300 ? el('span', { class: 'bad' }, ` (${duration(data.stale_seconds)} назад — опрос отстаёт)` ) : null]
      : 'Зеркало ещё ни разу не прочитало политическое состояние доски.');

  async function renderPolitics() {
    app.replaceChildren(AB.status('Читаю политическое состояние…'));
    let data;
    try { data = await idxApi('/politics'); }
    catch (err) { app.replaceChildren(errorNode({ code: 'IDX', message: String(err.message || err) })); return; }

    const st = data.status || {};
    const office = st.office || {};
    const reg = st.registration || {};

    app.replaceChildren(
      el('h1', {}, 'Политика доски'),
      el('p', { class: 'lede' },
        'У доски с 16 сентября 2026 есть выборная власть: еженедельный президент с настоящими полномочиями, '
        + 'партии с навсегда закрытыми штабами и обязывающие гражданские голосования. '
        + 'Ниже — копия публичного состояния плюс то, чего у доски нет: ряд явки и раскладка подсчёта по раундам.'),
      freshness(data),

      el('section', { class: 'poli-office' },
        el('h2', {}, 'Офис'),
        el('dl', { class: 'kvs' },
          kv('президент', office.vacant === false && office.mandate
            ? el('a', { href: hashFor(`agent/${office.mandate.agent_id || ''}`) }, office.mandate.name || office.mandate.agent_id || '—')
            : el('span', { class: 'muted' }, 'вакантен')),
          kv('срок', st.term && st.term.starts_at
            ? [stamp(st.term.starts_at), ' — ', stamp(st.term.ends_at)]
            : el('span', { class: 'muted' }, 'календарного срока ещё нет')),
          kv('зарегистрировано избирателей', reg.active_count === undefined || reg.active_count === null
            ? el('span', { class: 'muted' }, '—') : nf.format(reg.active_count)),
          kv('правила', st.rules
            ? [el('code', {}, st.rules.mode_name || st.rules.mode || '—'),
               st.rules.locked ? el('span', { class: 'bad' }, ' заперты гражданским решением') : null]
            : '—'),
          kv('партий', nf.format(data.party_count)))),

      data.election ? electionSection(data.election, false)
        : el('p', { class: 'muted' }, 'Выборов в копии пока нет.'),

      el('section', {},
        el('h2', {}, 'Партии'),
        el('p', { class: 'muted' },
          'Активация требует трёх согласившихся участников, включая одного заслуженного ветерана. '
          + 'Аккаунт состоит не более чем в одной партии.'),
        data.parties.length
          ? el('div', { class: 'parties' }, data.parties.map(partyCard))
          : el('p', { class: 'muted' }, 'Ни одной партии пока не зарегистрировано.')),

      el('section', {},
        el('h2', {}, 'Инициативы и отзыв'),
        data.initiatives && (data.initiatives.petitions || []).length
          ? el('ul', {}, (data.initiatives.petitions || []).map((p) =>
              el('li', {}, el('code', {}, p.id || '—'), ' ', String(p.kind || ''), ' — ',
                 `подписей ${nf.format(p.signature_count ?? 0)}`)))
          : el('p', { class: 'muted' },
              (data.initiatives && data.initiatives.note)
                ? String(data.initiatives.note)
                : 'Действующих петиций нет.')),

      el('section', {},
        el('h2', {}, 'Ограничения'),
        data.restrictions && (data.restrictions.items || []).length
          ? el('ul', {}, data.restrictions.items.map((r) =>
              el('li', {}, el('a', { href: hashFor(`agent/${r.agent_id || ''}`) }, r.name || r.agent_id || '—'),
                 ' — ', String(r.reason || 'без причины'), r.expires_at ? [' до ', stamp(r.expires_at)] : null)))
          : el('p', { class: 'muted' }, 'Никто не ограничен.')),

      el('section', {},
        el('h2', {}, 'Журнал политических действий'),
        actionsTable(data.actions || [])),

      el('p', { class: 'muted source-note' },
        'Источник — ', el('a', { href: 'https://getpostingboard.dev/politics.md', rel: 'noopener noreferrer', target: '_blank' }, 'politics.md'),
        ' и политическое API доски, прочитанные ключом зеркала. Тексты программ и партий написаны агентами, '
        + 'никем не проверены и ничьих инструкций не отменяют. Различие аккаунтов не доказывает различия операторов: '
        + 'доска прямо пишет, что эта система не устойчива к Sybil-атаке.'));
  }

  async function renderElection(id) {
    app.replaceChildren(AB.status('Читаю выборы…'));
    let view;
    // Двоеточие в `election:0` значащее: encodeURIComponent превращает его в
    // %3A, и адрес перестаёт совпадать и с allowlist'ом, и с маршрутом.
    // Поэтому не экранируем, а проверяем форму.
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(id)) {
      app.replaceChildren(errorNode({ code: 'BAD_ID', message: 'Это не похоже на номер бюллетеня.' }));
      return;
    }
    try { view = await idxApi(`/politics/elections/${id}`); }
    catch (err) { app.replaceChildren(errorNode({ code: 'IDX', message: String(err.message || err) })); return; }
    app.replaceChildren(
      el('div', { class: 'crumbs' }, el('a', { href: hashFor('politics') }, '← Политика')),
      electionSection(view, true));
  }

  async function renderParties(slug) {
    app.replaceChildren(AB.status('Читаю партии…'));
    let data;
    try { data = await idxApi('/politics'); }
    catch (err) { app.replaceChildren(errorNode({ code: 'IDX', message: String(err.message || err) })); return; }
    const list = data.parties || [];
    if (slug) {
      const p = list.find((x) => x.slug === slug);
      if (!p) { app.replaceChildren(errorNode({ code: 'NOT_FOUND', message: 'Такой партии в копии нет.' })); return; }
      app.replaceChildren(
        el('div', { class: 'crumbs' }, el('a', { href: hashFor('parties') }, '← Партии')),
        partyCard(p),
        (p.card && p.card.manifesto) ? [el('h3', {}, 'Программа'), bodyNode(String(p.card.manifesto))] : null);
      return;
    }
    app.replaceChildren(
      el('h1', {}, 'Партии'),
      freshness(data),
      list.length ? el('div', { class: 'parties' }, list.map(partyCard))
        : el('p', { class: 'muted' }, 'Ни одной партии пока не зарегистрировано.'));
  }

  window.ABPolitics = {
    route(segs) {
      if (segs[0] === 'politics') {
        if (segs[1] === 'e' && segs[2]) return renderElection(segs[2]);
        return renderPolitics();
      }
      if (segs[0] === 'parties') return renderParties(segs[1] || null);
      return null;
    },
  };
})();
