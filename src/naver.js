// 네이버 금융 비공식 JSON API. 캐시 없이 순수하게 받아오기만 한다(캐시는 store.js/D1).
// 공식 문서가 없는 엔드포인트라 응답 스키마가 바뀔 수 있음 → 파싱은 모두 방어적으로.
// 모든 호출은 Budget을 받아 한 번씩 차감한다 — 무료 플랜 호출당 외부 요청 50개 상한 때문.

import { pool } from './util.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const H_MOBILE = { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' };
const H_FINANCE = { 'User-Agent': UA, Referer: 'https://finance.naver.com/' };

export class UpstreamError extends Error {}

async function getText(url, headers, budget) {
  budget.take();
  // 리다이렉트도 외부 요청 1개로 세므로 따라가지 않는다. 막혔다면 보통 로그인/차단 페이지로 보낸다.
  // 요청 하나가 멈춰도 30초 시한을 다 잡아먹지 않게 5초에서 끊는다(서울 근처에서 보통 0.05~0.5초).
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new UpstreamError(`${res.status} ${new URL(url).host}${new URL(url).pathname}`);
  }
  return res.text();
}

async function getJSON(url, headers, budget) {
  const text = await getText(url, headers, budget);
  // 잘못된 경로나 차단은 200과 함께 HTML 셸을 돌려준다.
  if (text.trimStart().startsWith('<')) throw new UpstreamError(`HTML 응답: ${new URL(url).pathname}`);
  return JSON.parse(text);
}

// ── 종목 분류 ─────────────────────────────────────────────────────────
// 운용사 브랜드 + 공백으로 시작하면 ETF·ETN. 뒤의 \s가 중요하다 —
// 국내 종목명은 공백을 거의 쓰지 않아서 "삼성전자"·"KB금융"·"HK이노엔" 같은
// 실제 회사는 걸리지 않고 "삼성 인버스 2X …"만 걸린다.
const ETF_BRAND =
  /^(KODEX|TIGER|PLUS|ACE|RISE|SOL|HANARO|KOSEF|ARIRANG|KBSTAR|TIMEFOLIO|TIME|TREX|KIWOOM|키움|WOORI|WON|BNK|DAISHIN\d*|ITF|KTOP|SMART|UNICORN|VITA|FOCUS|KoAct|MIDAS|TRUE|1Q|HK|N2|DS|히어로즈|마이다스|네비게이터|파워|에셋플러스)\s/i;
// 브랜드 뒤에 바로 상품 유형이 붙는 형태 (예: "키움 인버스 2X …")
const ETF_PRODUCT = /(레버리지|인버스|\d+X\s|선물단일종목|커버드콜|액티브|채권|국고채|통안채|머니마켓|ETN|ETF)/i;

/** ETF·ETN인가 (종목코드로는 구분이 안 되므로 이름으로 추정) */
export const isFund = (name = '') => ETF_BRAND.test(name) || ETF_PRODUCT.test(name);

/** 우선주인가. 국내 보통주 코드는 6번째 자리가 '0'. */
export const isPreferred = (code = '') => code.length === 6 && code[5] !== '0';

/** 같은 회사인가 (보통주/우선주 관계) — 코드 앞 5자리가 같으면 동일 발행사. */
export const sameIssuer = (a, b) => a.slice(0, 5) === b.slice(0, 5);

// ── 정규화 ────────────────────────────────────────────────────────────
export const num = (v) => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** 등락폭의 부호를 등락률에 맞춘다(네이버는 상승일 때 부호를 생략한다). */
const signed = (diff, rate) => (rate < 0 ? -Math.abs(diff) : Math.abs(diff));

export function normStock(s) {
  const rate = num(s.fluctuationsRatioRaw ?? s.fluctuationsRatio);
  return {
    code: s.itemCode,
    name: s.stockName,
    market: s.stockExchangeType?.nameKor ?? (s.sosok === '1' ? '코스닥' : '코스피'),
    price: num(s.closePriceRaw ?? s.closePrice),
    diff: signed(num(s.compareToPreviousClosePriceRaw ?? s.compareToPreviousClosePrice), rate),
    rate,
    // 상한가/하한가 여부 (사이드카 구경용)
    limitUp: s.compareToPreviousPrice?.code === '1',
    limitDown: s.compareToPreviousPrice?.code === '4',
    marketValue: num(s.marketValue), // 억 단위 (랭킹 응답에만 있음)
  };
}

// ── 엔드포인트 ────────────────────────────────────────────────────────

/**
 * 코스피·코스닥을 외부 요청 1개로. 일괄 조회 엔드포인트도 지수에 대해서는 실제 시세 시각을
 * localTradedAt으로 준다(종목일 때는 요청 시각이라 다르다). 기존 /api/index/…/basic과 값이 같다.
 */
export async function fetchIndices(budget) {
  const j = await getJSON(
    'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ',
    H_MOBILE,
    budget
  );
  return (j.datas ?? []).map((x) => {
    const rate = num(x.fluctuationsRatioRaw ?? x.fluctuationsRatio);
    return {
      code: x.itemCode,
      name: x.stockName,
      price: num(x.closePriceRaw ?? x.closePrice),
      diff: signed(num(x.compareToPreviousClosePriceRaw ?? x.compareToPreviousClosePrice), rate),
      rate,
      marketStatus: x.marketStatus,
      tradedAt: x.localTradedAt,
    };
  });
}

/** 지수 하나 (진단용) */
export async function fetchIndex(code, budget) {
  const j = await getJSON(`https://m.stock.naver.com/api/index/${code}/basic`, H_MOBILE, budget);
  const rate = num(j.fluctuationsRatio);
  return {
    code,
    name: j.stockName,
    price: num(j.closePrice),
    diff: signed(num(j.compareToPreviousClosePrice), rate),
    rate,
    marketStatus: j.marketStatus,
    tradedAt: j.localTradedAt,
  };
}

/**
 * 랭킹 한 페이지. sort: up | down | searchTop | marketValue, market: KOSPI | KOSDAQ.
 * pageSize 상한은 100이고 넘기면 JSON 대신 HTML이 온다.
 */
async function fetchRankPage(sort, market, page, size, budget) {
  const j = await getJSON(
    `https://m.stock.naver.com/api/stocks/${sort}/${market}?page=${page}&pageSize=${Math.min(size, 100)}`,
    H_MOBILE,
    budget
  );
  return (j.stocks ?? []).map(normStock);
}

/**
 * 두 시장을 합친 랭킹. `ALL` 시장은 지원되지 않아 각각 받아 합친다.
 * ETF·ETN은 뺀다 — 지수가 크게 움직인 날엔 인버스/레버리지 상품이 급등·급락
 * 랭킹을 통째로 차지해서 "무슨 종목이 튀었나"를 가려버린다.
 * 외부 요청 수 = 2 × ceil(size/100).
 *
 * strict: 페이지가 하나라도 실패하면 예외. 반쪽짜리 목록(예: 코스피만)을 성공처럼 돌려주면
 * 멀쩡한 이전 값을 덮어쓰게 된다.
 */
export async function fetchRanking(sort, size, budget, { strict = false, markets = ['KOSPI', 'KOSDAQ'] } = {}) {
  const pages = Math.ceil(size / 100);
  const jobs = [];
  for (const market of markets) {
    for (let p = 1; p <= pages; p++) jobs.push({ market, p });
  }
  const got = await pool(jobs, 6, ({ market, p }) => fetchRankPage(sort, market, p, size, budget));
  if (strict && got.some((g) => g === null)) {
    throw new UpstreamError(`${sort} 랭킹 ${got.filter((g) => g === null).length}/${jobs.length}페이지 실패`);
  }

  const byMarket = { KOSPI: [], KOSDAQ: [] };
  jobs.forEach(({ market }, i) => {
    if (got[i]) byMarket[market].push(...got[i].filter((s) => !isFund(s.name)));
  });

  // searchTop은 순위 자체가 의미라 두 시장을 번갈아 섞는다(코스피 편중 방지).
  if (sort === 'searchTop') {
    const out = [];
    const { KOSPI: ks, KOSDAQ: kq } = byMarket;
    for (let i = 0; i < Math.max(ks.length, kq.length); i++) {
      if (ks[i]) out.push(ks[i]);
      if (kq[i]) out.push(kq[i]);
    }
    return out;
  }
  const merged = [...byMarket.KOSPI, ...byMarket.KOSDAQ];
  if (sort === 'up') merged.sort((a, b) => b.rate - a.rate);
  else if (sort === 'down') merged.sort((a, b) => a.rate - b.rate);
  else if (sort === 'marketValue') merged.sort((a, b) => b.marketValue - a.marketValue);
  return merged;
}

/** 종목 기본 시세 */
export async function fetchBasic(code, budget) {
  const j = await getJSON(`https://m.stock.naver.com/api/stock/${code}/basic`, H_MOBILE, budget);
  return { ...normStock(j), marketStatus: j.marketStatus, tradedAt: j.localTradedAt };
}

/**
 * 여러 종목 현재가를 한 번에. 200개까지 한 요청으로 받는 것을 확인했다(0.37초).
 * 관심종목·관련종목 칩처럼 종목 수만큼 요청하던 것을 외부 요청 1개로 줄인다.
 */
export async function fetchQuotes(codes, budget) {
  if (!codes.length) return [];
  const j = await getJSON(
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.slice(0, 200).join(',')}`,
    H_MOBILE,
    budget
  );
  return (j.datas ?? []).map((s) => ({ ...normStock(s), tradedAt: s.localTradedAt, marketStatus: s.marketStatus }));
}

/** 종목 상세: 시/고/저/거래량 + 동일 업종 종목 */
export async function fetchIntegration(code, budget) {
  const j = await getJSON(`https://m.stock.naver.com/api/stock/${code}/integration`, H_MOBILE, budget);
  return {
    totals: (j.totalInfos ?? []).map((t) => ({ key: t.key, value: t.value, code: t.code })),
    industryPeers: (j.industryCompareInfo ?? []).map(normStock).filter((s) => s.code !== code),
  };
}

const ROW = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(\d+)/g;

/**
 * 일봉 OHLCV. days는 달력 기준 일수(거래일은 약 0.68배).
 * 응답이 JS 리터럴 배열이라 JSON.parse가 안 된다. 행 단위로 뽑아낸다.
 */
export async function fetchDaily(code, days, budget) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86_400_000);
  const ymd = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  // 한국 날짜 경계를 넘기지 않도록 끝 날짜는 하루 여유를 둔다(미래 날짜는 무시된다).
  end.setUTCDate(end.getUTCDate() + 1);
  const text = await getText(
    `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}` +
      `&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`,
    H_FINANCE,
    budget
  );
  const rows = [];
  for (const m of text.matchAll(ROW)) {
    rows.push({ d: m[1], o: +m[2], h: +m[3], l: +m[4], c: +m[5], v: +m[6] });
  }
  return rows;
}

/** 종목 검색 자동완성 */
export async function search(query, budget) {
  const q = query.trim();
  if (!q) return [];
  const j = await getJSON(
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock&country=KOR`,
    H_MOBILE,
    budget
  );
  return (j.items ?? [])
    .filter((it) => it.category === 'stock' && it.nationCode === 'KOR')
    .slice(0, 12)
    .map((it) => ({ code: it.code, name: it.name, market: it.typeName }));
}
