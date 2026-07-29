// 관련 종목 추천.
//
// 두 갈래로 만든다.
//  1) 같은 업종  — 네이버가 주는 industryCompareInfo를 그대로 쓴다.
//  2) 같이 움직이는 종목 — 최근 일간수익률의 상관계수. 업종을 넘나드는 추천이
//     나오는 쪽이라 "꼭 같은 카테고리가 아니어도 되는" 발견은 여기서 나온다.
//     반대로 움직이는 종목(음의 상관)도 같이 보여준다. 방어주 찾기용.

import {
  cached,
  fetchRanking,
  fetchDaily,
  pool,
  isFund,
  isPreferred,
  sameIssuer,
  TTL,
} from './naver.js';

const UNIVERSE_SIZE = 200; // 시장별 시총 상위 N
const CORR_WINDOW = 60; // 상관계수 계산에 쓸 거래일 수
const MIN_OVERLAP = 30; // 이보다 겹치는 날이 적으면 신뢰할 수 없다고 보고 제외

/** 후보군: 시총 상위 + 오늘 급등/급락 + 검색 상위. 중복 제거. */
function fetchUniverse() {
  return cached('universe', TTL.quote, async () => {
    const lists = await Promise.all([
      fetchRanking('marketValue', UNIVERSE_SIZE),
      fetchRanking('up', 40),
      fetchRanking('down', 40),
      fetchRanking('searchTop', 30),
    ]);

    const seen = new Map();
    for (const s of lists.flat()) {
      if (!s?.code || seen.has(s.code)) continue;
      if (isFund(s.name) || isPreferred(s.code)) continue;
      seen.set(s.code, { code: s.code, name: s.name, market: s.market, rate: s.rate, price: s.price });
    }
    return [...seen.values()];
  });
}

/** 종가 배열 → 일간수익률 배열 */
function returns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].c;
    if (prev > 0) out.push((series[i].c - prev) / prev);
  }
  return out;
}

/** 피어슨 상관계수 (뒤에서부터 겹치는 구간만) */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OVERLAP) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);

  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = x[i] - mx;
    const b1 = y[i] - my;
    num += a1 * b1;
    dx += a1 * a1;
    dy += b1 * b1;
  }
  if (dx === 0 || dy === 0) return null;
  const r = num / Math.sqrt(dx * dy);
  return Number.isFinite(r) ? r : null;
}

/**
 * 기준 종목과 최근 움직임이 닮은/반대인 종목을 찾는다.
 * @returns {{together: object[], opposite: object[], basis: number}}
 */
export async function findRelated(code, { top = 6 } = {}) {
  const universe = (await fetchUniverse()).filter(
    (s) => s.code !== code && !sameIssuer(s.code, code)
  );

  const [baseSeries, seriesList] = await Promise.all([
    fetchDaily(code).catch(() => null),
    pool(universe, 8, (s) => fetchDaily(s.code)),
  ]);

  if (!baseSeries || baseSeries.length < MIN_OVERLAP + 1) {
    return { together: [], opposite: [], basis: 0 };
  }

  const baseRet = returns(baseSeries).slice(-CORR_WINDOW);

  const scored = [];
  for (let i = 0; i < universe.length; i++) {
    const series = seriesList[i];
    if (!series || series.length < MIN_OVERLAP + 1) continue;
    const r = correlation(baseRet, returns(series).slice(-CORR_WINDOW));
    if (r === null) continue;
    scored.push({ ...universe[i], corr: Number(r.toFixed(3)) });
  }

  scored.sort((a, b) => b.corr - a.corr);

  return {
    together: scored.slice(0, top),
    // 음의 상관이 뚜렷한 것만. 0 근처는 "관계 없음"이지 "반대"가 아니다.
    opposite: scored
      .filter((s) => s.corr < -0.1)
      .slice(-top)
      .reverse(),
    basis: baseRet.length,
  };
}

/** 서버 시작 직후 후보군 일봉을 미리 받아둔다 (첫 조회 지연 제거). */
export async function warmUp() {
  const t0 = Date.now();
  const universe = await fetchUniverse();
  await pool(universe, 8, (s) => fetchDaily(s.code));
  return { count: universe.length, ms: Date.now() - t0 };
}
