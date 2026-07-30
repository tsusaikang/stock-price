// 화면 로직. 프레임워크·차트 라이브러리 없이 DOM + SVG로 직접 그린다.

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n ?? 0).toLocaleString('ko-KR');
const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Array.prototype.at()은 Chrome 92(2021) 이상이라 구형 안드로이드에서 터진다.
const lastOf = (arr) => arr[arr.length - 1];

const RANGES = { '1개월': 22, '3개월': 65, '1년': 400 };

const state = {
  home: null,
  tab: 'up',
  favs: JSON.parse(localStorage.getItem('favs') || '[]'),
  favData: [],
  open: null, // { anchor, stack: [code], range, data }
};

// ── 즐겨찾기 ──────────────────────────────────────────────────────────
const isFav = (code) => state.favs.includes(code);
function toggleFav(code) {
  state.favs = isFav(code) ? state.favs.filter((c) => c !== code) : [...state.favs, code];
  localStorage.setItem('favs', JSON.stringify(state.favs));
  loadFavs();
}

// ── 차트 그리기 ───────────────────────────────────────────────────────
function sparkline(values) {
  if (!values || values.length < 2) return '<svg class="spark"></svg>';
  const w = 62;
  const h = 26;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`)
    .join(' ');
  const dir = lastOf(values) - values[0];
  return `<svg class="spark ${cls(dir)}" viewBox="0 0 ${w} ${h}"
    preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"
      vector-effect="non-scaling-stroke"
      stroke-linejoin="round" stroke-linecap="round" opacity=".9"/></svg>`;
}

function priceChart(rows, id) {
  if (!rows || rows.length < 2) return '<p class="muted">차트 데이터가 없습니다.</p>';

  const W = 700, H = 250, PL = 8, PR = 52, PT = 14, PB = 18, VOL_H = 38, GAP = 10;
  const priceH = H - PT - PB - VOL_H - GAP;
  const innerW = W - PL - PR;

  const closes = rows.map((r) => r.c);
  const lo = Math.min(...rows.map((r) => r.l));
  const hi = Math.max(...rows.map((r) => r.h));
  const span = hi - lo || 1;
  const maxV = Math.max(...rows.map((r) => r.v)) || 1;

  const x = (i) => PL + (i / (rows.length - 1)) * innerW;
  const y = (v) => PT + (1 - (v - lo) / span) * priceH;

  const line = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.c).toFixed(1)}`).join(' ');
  const area = `${PL},${(PT + priceH).toFixed(1)} ${line} ${(PL + innerW).toFixed(1)},${(PT + priceH).toFixed(1)}`;

  const first = closes[0];
  const last = lastOf(closes);
  const dir = cls(last - first);
  const baseY = y(first);

  const volTop = PT + priceH + GAP;
  const barW = Math.max(1, innerW / rows.length - 0.6);
  const bars = rows
    .map((r, i) => {
      const bh = (r.v / maxV) * VOL_H;
      const up = i === 0 || r.c >= rows[i - 1].c;
      return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${(volTop + VOL_H - bh).toFixed(1)}"
        width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
        class="${up ? 'up' : 'down'}" fill="currentColor" opacity=".35"/>`;
    })
    .join('');

  const dateAt = (i) => `${rows[i].d.slice(4, 6)}/${rows[i].d.slice(6, 8)}`;
  const ticks = [0, Math.floor(rows.length / 2), rows.length - 1]
    .map(
      (i) =>
        `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-size="10" fill="var(--faint)"
          text-anchor="${i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}">${dateAt(i)}</text>`
    )
    .join('');

  return `
<svg class="${dir}" viewBox="0 0 ${W} ${H}" data-chart="${id}" preserveAspectRatio="none"
     role="img" aria-label="주가 차트">
  <defs>
    <linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="currentColor" stop-opacity=".22"/>
      <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <line x1="${PL}" y1="${baseY.toFixed(1)}" x2="${PL + innerW}" y2="${baseY.toFixed(1)}"
        stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>

  <polygon points="${area}" fill="url(#g-${id})"/>
  <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linejoin="round" stroke-linecap="round"/>
  ${bars}

  <text x="${W - PR + 6}" y="${(y(hi) + 4).toFixed(1)}" font-size="10" fill="var(--faint)">${fmt(hi)}</text>
  <text x="${W - PR + 6}" y="${(y(lo) + 4).toFixed(1)}" font-size="10" fill="var(--faint)">${fmt(lo)}</text>
  <text x="${W - PR + 6}" y="${(baseY + 4).toFixed(1)}" font-size="10" fill="var(--faint)" opacity=".8">${fmt(first)}</text>
  ${ticks}

  <line class="cross" x1="0" y1="${PT}" x2="0" y2="${PT + priceH}" stroke="var(--faint)"
        stroke-width="1" opacity="0"/>
  <circle class="dot" r="3" fill="currentColor" opacity="0"/>
</svg>`;
}

/** 차트에 손가락/마우스를 대면 그 날짜의 값을 읽어준다. */
function bindCrosshair(box, rows) {
  const svg = box.querySelector('svg[data-chart]');
  const readout = box.querySelector('.readout');
  if (!svg || !rows?.length) return;

  const W = 700, PL = 8, PR = 52;
  const innerW = W - PL - PR;
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');

  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const ratio = Math.min(1, Math.max(0, (px - PL) / innerW));
    const i = Math.round(ratio * (rows.length - 1));
    const r = rows[i];
    if (!r) return;

    const cx = PL + (i / (rows.length - 1)) * innerW;
    const lo = Math.min(...rows.map((v) => v.l));
    const hi = Math.max(...rows.map((v) => v.h));
    const cy = 14 + (1 - (r.c - lo) / (hi - lo || 1)) * (250 - 14 - 18 - 38 - 10);

    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('opacity', '.6');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('opacity', '1');

    const prev = rows[i - 1]?.c ?? r.c;
    const chg = prev ? ((r.c - prev) / prev) * 100 : 0;
    readout.innerHTML = `${r.d.slice(0, 4)}.${r.d.slice(4, 6)}.${r.d.slice(6)} · <b>${fmt(r.c)}</b>
      <span class="${cls(chg)}">${sign(chg)}${Math.abs(chg).toFixed(2)}%</span> · 거래량 ${fmt(r.v)}`;
  };

  const leave = () => {
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    readout.textContent = '';
  };

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

// ── 행 렌더 ───────────────────────────────────────────────────────────
function rowHTML(s, rank) {
  const tag = s.limitUp ? '<span class="tag up">상한</span>'
            : s.limitDown ? '<span class="tag down">하한</span>' : '';
  return `
<div class="row ${state.open?.anchor === s.code ? 'open' : ''}" data-code="${s.code}">
  <span class="rank">${rank ?? (isFav(s.code) ? '★' : '')}</span>
  <span class="nm">${esc(s.name)}${tag}<span class="mk">${esc(s.market ?? '')}</span></span>
  ${sparkline(s.spark)}
  <span class="right">
    <div class="pv">${fmt(s.price)}</div>
    <div class="ch ${cls(s.rate)}">${sign(s.rate)}${Math.abs(s.rate).toFixed(2)}%
      <span style="opacity:.7">${sign(s.rate)}${fmt(Math.abs(s.diff))}</span></div>
  </span>
</div>`;
}

function renderList() {
  const items = state.home?.lists?.[state.tab] ?? [];
  const showRank = state.tab === 'up' || state.tab === 'down';
  $('#list').innerHTML = items.length
    ? items.map((s, i) => rowHTML(s, showRank ? i + 1 : i + 1)).join('')
    : '<div class="skel">불러오는 중…</div>';
  mountDetail();
}

function renderFavs() {
  const box = $('#favs');
  if (!state.favs.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    `<h2>★ 관심종목</h2><div class="list">` +
    (state.favData.length
      ? state.favData.map((s) => rowHTML(s, '★')).join('')
      : '<div class="skel">불러오는 중…</div>') +
    `</div>`;
  mountDetail();
}

/** 한국 시간 기준으로 쪼갠 날짜 조각 (사용자가 어느 시간대에 있든 장 시간은 KST다) */
function seoulParts(date) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/**
 * 지금 보고 있는 값이 "언제 시점의 시세인지" 표시한다.
 *
 * 화면에 받아온 시각이 아니라, 네이버가 응답에 함께 실어주는 기준 시각
 * (localTradedAt)을 쓴다. 캐시와 SWR 때문에 둘은 몇 분씩 벌어질 수 있는데,
 * 받아온 시각을 띄우면 묵은 값을 방금 값으로 착각하게 된다.
 * (필드 이름의 'Traded'는 주문 체결과는 무관하다. 지수에는 체결이 없다.)
 */
function renderStamp() {
  const el = $('#stamp');
  const idx = state.home?.indices?.find((x) => x.tradedAt);
  if (!idx) {
    el.textContent = '';
    el.classList.remove('live');
    return;
  }

  const t = seoulParts(new Date(idx.tradedAt));
  const now = seoulParts(new Date());
  const sameDay = t.year === now.year && t.month === now.month && t.day === now.day;
  const live = idx.marketStatus === 'OPEN';
  const hhmm = `${t.hour}:${t.minute}`;

  el.classList.toggle('live', live);
  el.textContent = sameDay
    ? live
      ? `${hhmm} 기준`
      : `${hhmm} 장마감`
    : `${+t.month}/${+t.day}(${t.weekday}) 종가`;
  el.title = `시세 시점: ${t.year}.${t.month}.${t.day} ${hhmm} (한국시간)`;
}

function renderIndices() {
  renderStamp();
  $('#indices').innerHTML = (state.home?.indices ?? [])
    .map(
      (x) => `<div class="idx">
        <div class="nm">${esc(x.name)}</div>
        <div class="pv ${cls(x.rate)}">${x.price.toLocaleString('ko-KR', { minimumFractionDigits: 2 })}</div>
        <div class="ch ${cls(x.rate)}">${sign(x.rate)}${fmt(Math.abs(x.diff).toFixed(2))} (${sign(x.rate)}${Math.abs(x.rate).toFixed(2)}%)</div>
      </div>`
    )
    .join('');
}

// ── 상세 ──────────────────────────────────────────────────────────────
function chipHTML(s, showCorr) {
  return `<button class="chip" data-goto="${s.code}">
    <span>${esc(s.name)}</span>
    <span class="r ${cls(s.rate)}">${sign(s.rate)}${Math.abs(s.rate ?? 0).toFixed(1)}%</span>
    ${showCorr ? `<span class="c">${s.corr > 0 ? '+' : ''}${s.corr}</span>` : ''}
  </button>`;
}

function detailHTML() {
  const o = state.open;
  if (!o) return '';
  if (!o.data) return '<div class="detail"><div class="skel">불러오는 중…</div></div>';

  const d = o.data;
  const days = RANGES[o.range];
  const rows = d.ohlcv.slice(-days);
  const pick = (k) => d.totals?.find((t) => t.code === k)?.value ?? '-';
  const back = o.stack.length > 1;

  const rel = d.related ?? {};
  const relBlock = (title, note, items, showCorr) =>
    items?.length
      ? `<div class="rel"><h3>${title}<small>${note}</small></h3>
         <div class="chips">${items.map((s) => chipHTML(s, showCorr)).join('')}</div></div>`
      : '';

  return `
<div class="detail">
  <div class="detail-head">
    <div style="display:flex;align-items:center;gap:8px;min-width:0">
      ${back ? `<button class="chip" data-back="1">← 뒤로</button>` : ''}
      <strong style="letter-spacing:-.02em">${esc(d.name)}</strong>
      <span class="ch ${cls(d.rate)}">${sign(d.rate)}${Math.abs(d.rate).toFixed(2)}%</span>
    </div>
    <button class="star ${isFav(d.code) ? 'on' : ''}" data-fav="${d.code}"
      title="관심종목">${isFav(d.code) ? '★' : '☆'}</button>
  </div>

  <div class="ranges">
    ${Object.keys(RANGES).map((r) => `<button data-range="${r}" class="${r === o.range ? 'on' : ''}">${r}</button>`).join('')}
  </div>

  <div class="chart-box" style="margin-top:8px">
    <div class="readout"></div>
    ${priceChart(rows, d.code)}
  </div>

  <div class="stats">
    <div><div class="k">시가</div><div class="v">${pick('openPrice')}</div></div>
    <div><div class="k">고가</div><div class="v up">${pick('highPrice')}</div></div>
    <div><div class="k">저가</div><div class="v down">${pick('lowPrice')}</div></div>
    <div><div class="k">거래량</div><div class="v">${pick('accumulatedTradingVolume')}</div></div>
  </div>

  ${relBlock('같은 업종', '네이버 업종 분류', rel.industry, false)}
  ${relBlock('같이 움직이는 종목', `최근 ${rel.basis ?? 0}거래일 상관계수`, rel.together, true)}
  ${relBlock('반대로 움직이는 종목', '이게 빠질 때 버틴 종목', rel.opposite, true)}
</div>`;
}

/** 열려 있는 종목의 상세를 해당 행 아래에 붙인다. */
function mountDetail() {
  document.querySelectorAll('.detail').forEach((el) => el.remove());
  if (!state.open) return;
  const row = document.querySelector(`.row[data-code="${state.open.anchor}"]`);
  if (!row) return;
  row.insertAdjacentHTML('afterend', detailHTML());

  const box = document.querySelector('.detail .chart-box');
  if (box && state.open.data) {
    bindCrosshair(box, state.open.data.ohlcv.slice(-RANGES[state.open.range]));
  }
}

async function loadDetail() {
  const code = lastOf(state.open.stack);
  state.open.data = null;
  mountDetail();
  try {
    const res = await fetch(`/api/stock?code=${code}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '불러오기 실패');
    if (!state.open || lastOf(state.open.stack) !== code) return; // 그새 다른 종목으로 넘어갔으면 버림
    state.open.data = data;
  } catch (e) {
    state.open.data = null;
    mountDetail();
    const el = document.querySelector('.detail');
    if (el) el.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    return;
  }
  mountDetail();
}

function openStock(anchor, code = anchor) {
  if (state.open?.anchor === anchor && lastOf(state.open.stack) === code) {
    state.open = null; // 같은 걸 또 누르면 접는다
    renderAll();
    return;
  }
  state.open = { anchor, stack: [code], range: '3개월', data: null };
  renderAll();
  loadDetail();
}

// ── 데이터 로드 ───────────────────────────────────────────────────────
const STALE_LIMIT_SEC = 90;

/**
 * 서버는 만료된 값을 즉시 돌려주고 갱신은 뒤에서 한다(SWR). 그래서 첫 요청은
 * 한 박자 지난 시세를 받을 수 있다. 표시한 시각이 너무 옛것이면 조용히 한 번만
 * 다시 받는다 — 그 사이 서버의 백그라운드 갱신이 끝나 있다.
 */
function freshenIfStale() {
  const idx = state.home?.indices?.find((x) => x.tradedAt);
  if (!idx || idx.marketStatus !== 'OPEN') return; // 장 마감 뒤엔 안 바뀐다
  const ageSec = (Date.now() - new Date(idx.tradedAt).getTime()) / 1000;
  if (ageSec < STALE_LIMIT_SEC) return;
  setTimeout(() => loadHome({ retry: true }), 1500);
}

async function loadHome({ retry = false } = {}) {
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    const res = await fetch('/api/home');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '불러오기 실패');
    state.home = data;
    // 상단 표시가 "시세 시점"이라면 이쪽은 "받아온 시각". 둘은 다르다.
    $('#updated').textContent = `화면에 받아온 시각 ${new Date(data.updatedAt).toLocaleTimeString('ko-KR')}`;
  } catch (e) {
    $('#list').innerHTML = `<div class="err">시세를 못 불러왔습니다 · ${esc(e.message)}</div>`;
  } finally {
    btn.classList.remove('spin');
  }
  renderIndices();
  renderList();
  if (!retry) freshenIfStale(); // 재시도는 한 번만
}

async function loadFavs() {
  if (!state.favs.length) {
    state.favData = [];
    renderFavs();
    return;
  }
  renderFavs();
  try {
    const res = await fetch(`/api/quotes?codes=${state.favs.join(',')}`);
    state.favData = await res.json();
  } catch {
    state.favData = [];
  }
  renderFavs();
}

function renderAll() {
  renderIndices();
  renderList();
  renderFavs();
}

// ── 이벤트 ────────────────────────────────────────────────────────────
document.addEventListener('click', (ev) => {
  const back = ev.target.closest('[data-back]');
  if (back) {
    state.open.stack.pop();
    loadDetail();
    return;
  }

  const goto = ev.target.closest('[data-goto]');
  if (goto) {
    state.open.stack.push(goto.dataset.goto);
    loadDetail();
    return;
  }

  const fav = ev.target.closest('[data-fav]');
  if (fav) {
    toggleFav(fav.dataset.fav);
    fav.classList.toggle('on');
    fav.textContent = isFav(fav.dataset.fav) ? '★' : '☆';
    return;
  }

  const range = ev.target.closest('[data-range]');
  if (range) {
    state.open.range = range.dataset.range;
    mountDetail();
    return;
  }

  const tab = ev.target.closest('#tabs button');
  if (tab) {
    state.tab = tab.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b === tab));
    state.open = null;
    renderList();
    return;
  }

  const row = ev.target.closest('.row');
  if (row) openStock(row.dataset.code);
});

$('#refresh').addEventListener('click', () => {
  loadHome();
  loadFavs();
});

// 탭을 다시 열었을 때 옛 시세를 그대로 보고 있지 않게 한다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') freshenIfStale();
});

// 검색
let searchTimer;
const suggest = $('#suggest');

$('#search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const q = ev.target.value.trim();
  if (!q) {
    suggest.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const items = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      suggest.innerHTML = items.length
        ? items.map((s) => `<li data-code="${s.code}"><span>${esc(s.name)}</span><span class="mk">${esc(s.market)}</span></li>`).join('')
        : '<li class="muted" style="cursor:default">검색 결과 없음</li>';
      suggest.hidden = false;
    } catch {
      suggest.hidden = true;
    }
  }, 220);
});

suggest.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-code]');
  if (!li) return;
  suggest.hidden = true;
  $('#search').value = '';
  showSearched(li.dataset.code);
});

/**
 * 검색한 종목을 맨 위 전용 카드로 띄운다.
 * 목록(탭)에 그 종목이 있든 없든 항상 여기에 그린다 — 지금 안 열려 있는 탭의
 * 행을 재사용하려 들면 붙일 자리가 없어서 아무것도 안 열린다.
 */
async function showSearched(code) {
  const box = $('#searched');
  box.hidden = false;
  box.innerHTML = `<h2>검색한 종목</h2><div class="list"><div class="skel">불러오는 중…</div></div>`;
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });

  let list = [];
  try {
    list = await (await fetch(`/api/quotes?codes=${code}`)).json();
  } catch {
    /* 아래에서 처리 */
  }
  if (!list.length) {
    box.querySelector('.list').innerHTML = '<div class="err">시세를 못 불러왔습니다</div>';
    return;
  }

  state.open = { anchor: code, stack: [code], range: '3개월', data: null };
  box.querySelector('.list').innerHTML = rowHTML(list[0], '');
  mountDetail();
  loadDetail();
}

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.search-wrap')) suggest.hidden = true;
});

loadHome();
loadFavs();
