// 관련 종목 추천 — 최근 일간수익률의 상관계수. 순수 계산만 한다(네트워크·저장 없음).
//
// 업종 분류(네이버 industryCompareInfo)와 별개로, 업종을 넘나들며 실제로 같이/반대로
// 움직인 종목을 찾는 쪽이다. "꼭 같은 카테고리가 아니어도 되는" 발견은 여기서 나온다.

import { sameIssuer } from './naver.js';

export const CORR_WINDOW = 60; // 거래일
const MIN_OVERLAP = 30; // 이보다 겹치는 날이 적으면 신뢰할 수 없다고 보고 제외
const MAX_LAG = 5; // 기준 종목보다 이만큼(거래일) 넘게 묵은 후보는 뺀다

function returns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) out.push((closes[i] - prev) / prev);
  }
  return out;
}

/** 피어슨 상관계수. 두 배열은 같은 날짜에서 끝나야 한다(뒤에서부터 겹치는 구간만 쓴다). */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OVERLAP) return null;
  const x = a.length === n ? a : a.slice(-n);
  const y = b.length === n ? b : b.slice(-n);

  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;

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
  if (dx === 0 || dy === 0) return null; // 거래정지 등으로 값이 안 움직였으면 상관계수가 없다
  const r = num / Math.sqrt(dx * dy);
  return Number.isFinite(r) ? r : null;
}

/**
 * 후보군을 상관계수 계산용으로 포장한다. 하루 한 번(후보군 재구축이 끝났을 때) 만든다.
 * 행마다 마지막 CORR_WINDOW개 수익률을 Float32로, 모자라면 앞을 NaN으로 채운다.
 * @returns {{meta: {window:number, rows:[code,name,market,last][]}, data: Float32Array}}
 */
export function buildPack(universe) {
  const W = CORR_WINDOW;
  const rows = [];
  const data = new Float32Array(universe.length * W).fill(NaN);
  universe.forEach((u, i) => {
    const r = returns(u.closes).slice(-W);
    data.set(r, i * W + (W - r.length));
    rows.push([u.code, u.name, u.market, u.last]);
  });
  return { meta: { window: W, rows }, data };
}

/** 포장본을 findRelated가 받는 모양으로 (행마다 수익률 배열을 바로 넘긴다 — 파싱 없음) */
export function unpack(pack) {
  const W = pack.meta.window;
  return pack.meta.rows.map(([code, name, market, last], i) => {
    const seg = pack.data.subarray(i * W, (i + 1) * W);
    let start = 0;
    while (start < W && Number.isNaN(seg[start])) start++;
    return { code, name, market, last, rets: seg.subarray(start) };
  });
}

/**
 * @param {string} code 기준 종목
 * @param {{d:string,c:number}[]} baseRows 기준 종목 일봉 (날짜 오름차순, 장중이면 오늘 봉 포함)
 * @param {{code,name,market,last,closes?:number[],rets?:Float32Array}[]} universe 후보군
 *   (마감된 봉만, last = 마지막 날짜). 포장본(unpack)이면 rets, D1 행이면 closes.
 *
 * 후보마다 자기 마지막 날짜(last)에 맞춰 기준 종목을 자른 뒤 비교한다. 위치로만 맞추면
 * 장중엔 기준 종목에만 오늘 봉이 붙어 있어서 하루씩 어긋난 값끼리 비교하게 된다
 * (그러면 삼성전자와 SK하이닉스가 "반대로 움직이는 종목"으로 나오기도 한다).
 */
export function findRelated(code, baseRows, universe, { top = 6 } = {}) {
  const empty = { together: [], opposite: [], basis: 0 };
  if (!universe.length || baseRows.length < MIN_OVERLAP + 1) return empty;

  const indexOf = new Map(baseRows.map((r, i) => [r.d, i]));
  const baseCloses = baseRows.map((r) => r.c);
  const lastIdx = baseRows.length - 1;
  const windows = new Map(); // 끝 인덱스 → 기준 종목 수익률 구간 (후보 대부분이 같은 날짜라 재사용)
  const used = new Map(); // 끝 인덱스 → 쓰인 횟수 (basis 표시용)

  const scored = [];
  for (const u of universe) {
    if (u.code === code || sameIssuer(u.code, code)) continue;
    const idx = indexOf.get(u.last);
    if (idx === undefined || lastIdx - idx > MAX_LAG) continue;

    let base = windows.get(idx);
    if (!base) {
      base = returns(baseCloses.slice(Math.max(0, idx - CORR_WINDOW), idx + 1));
      windows.set(idx, base);
    }
    const r = correlation(base, u.rets ?? returns(u.closes).slice(-CORR_WINDOW));
    if (r === null) continue;
    used.set(idx, (used.get(idx) ?? 0) + 1);
    scored.push({ code: u.code, name: u.name, market: u.market, corr: Number(r.toFixed(3)) });
  }
  if (!scored.length) return empty;
  scored.sort((a, b) => b.corr - a.corr);

  const commonIdx = [...used.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    together: scored.slice(0, top),
    // 음의 상관이 뚜렷한 것만. 0 근처는 "관계 없음"이지 "반대"가 아니다.
    opposite: scored
      .filter((s) => s.corr < -0.1)
      .slice(-top)
      .reverse(),
    basis: windows.get(commonIdx).length,
  };
}
