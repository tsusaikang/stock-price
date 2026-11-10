// 첫 화면 데이터(지수 + 급등·급락·이슈·시총)와 스파크라인.
//
// 갱신은 두 번에 나눠 저장한다.
//   1) 가격: 지수 2 + 랭킹 8 = 외부 요청 10개. 스파크라인은 D1에 있는 것(+ 이전 화면 것)으로.
//      → 바로 저장. 사용자가 보는 가격은 여기서 최신이 된다.
//   2) 스파크라인 보충: D1에 없거나 묵은 종목의 일봉을 남은 예산만큼 받아 다시 저장.
// 한 번에 다 하고 마지막에 저장하면, 느린 날 30초 시한을 넘겨 전부 날아간다.

import { lastClosedDay, sessionDayGuess, ymdOfIso, pool } from './util.js';
import { fetchIndex, fetchRanking, fetchDaily } from './naver.js';
import { getSeries, putSeries, putBlob } from './store.js';
import { toSeries } from './universe.js';

export const HOME_KEY = 'home';
const LIST_N = 15;
const SPARK_POINTS = 30;
const SPARK_DAYS = 60; // 달력 기준 → 거래일 약 40일
export const RETRY_MS = 3 * 3_600_000;

const LISTS = [
  ['up', 'up', 30],
  ['down', 'down', 30],
  ['issue', 'searchTop', 20],
  ['cap', 'marketValue', 20],
];

/**
 * 저장된 종가 + 지금 가격으로 30점짜리 미니 차트.
 * sessionDay: 지금 가격이 속한 거래일. 저장분이 그날까지 있으면 마지막 점을 바꾸고,
 * 그 전날까지면 지금 가격을 오늘 점으로 붙인다.
 */
export function sparkOf(row, price, sessionDay) {
  if (row.last === sessionDay) {
    const s = row.closes.slice(-SPARK_POINTS);
    if (price > 0) s[s.length - 1] = price;
    return s;
  }
  const s = row.closes.slice(-(SPARK_POINTS - 1));
  if (price > 0 && sessionDay > row.last) s.push(price);
  return s;
}

function attachSparks(lists, stored, sessionDay, prevSparks) {
  const out = {};
  for (const [name, items] of Object.entries(lists)) {
    out[name] = items.map((s) => {
      const row = stored.get(s.code);
      const spark = row ? sparkOf(row, s.price, sessionDay) : (prevSparks.get(s.code) ?? s.spark ?? []);
      return { ...s, spark };
    });
  }
  return out;
}

const unique = (lists) => {
  const seen = new Map();
  for (const s of Object.values(lists).flat()) if (!seen.has(s.code)) seen.set(s.code, s);
  return [...seen.values()];
};

/**
 * 1단계: 가격. 칸(지수·목록)마다 따로 받고, 실패한 칸은 이전 화면 값을 그대로 쓴다.
 * 반쪽짜리(예: 코스피만 있는 급등 목록)를 저장해서 멀쩡한 화면을 덮어쓰지 않으려는 것.
 */
export async function refreshPrices(db, budget, prev, now = Date.now()) {
  const [kospi, kosdaq, ...ranked] = await Promise.allSettled([
    fetchIndex('KOSPI', budget),
    fetchIndex('KOSDAQ', budget),
    ...LISTS.map(([, sort, size]) => fetchRanking(sort, size, budget, { strict: true })),
  ]);

  const failed = [];
  const prevIdx = (code) => prev?.indices?.find((i) => i.code === code) ?? null;
  const indices = [
    kospi.status === 'fulfilled' ? kospi.value : (failed.push('KOSPI'), prevIdx('KOSPI')),
    kosdaq.status === 'fulfilled' ? kosdaq.value : (failed.push('KOSDAQ'), prevIdx('KOSDAQ')),
  ].filter(Boolean);

  const lists = {};
  LISTS.forEach(([name], i) => {
    const r = ranked[i];
    if (r.status === 'fulfilled' && r.value.length) lists[name] = r.value.slice(0, LIST_N);
    else {
      failed.push(name);
      lists[name] = prev?.lists?.[name] ?? [];
    }
  });

  const filled = Object.values(lists).filter((l) => l.length).length;
  if (!indices.length || filled < 3) {
    throw new Error(`첫 화면을 만들 수 없음 (실패: ${failed.join(', ')})`);
  }

  const sessionDay = ymdOfIso(indices[0]?.tradedAt) ?? sessionDayGuess(now);
  const prevSparks = new Map(prev ? unique(prev.lists).map((s) => [s.code, s.spark ?? []]) : []);
  const stored = db ? await getSeries(db, unique(lists).map((s) => s.code)) : new Map();

  const snap = {
    indices,
    lists: attachSparks(lists, stored, sessionDay, prevSparks),
    fetchedAt: now,
    ...(failed.length ? { partial: failed } : {}),
  };
  if (db) await putBlob(db, HOME_KEY, snap);
  return { snap, stored, sessionDay };
}

/** 2단계: 스파크라인 보충. D1에 없거나 묵은 종목만 남은 예산만큼. */
export async function backfillSparks(db, budget, { snap, stored, sessionDay }, now = Date.now()) {
  const need = lastClosedDay(now);
  // 마지막 종가가 기대보다 이전이어도 최근에 받아 본 것이면 다시 받지 않는다. 공휴일·거래정지
  // 종목은 다시 받아도 그 날짜의 봉이 없어서, 이 조건이 없으면 갱신 때마다 예산을 태운다.
  const stale = unique(snap.lists).filter((s) => {
    const row = stored.get(s.code);
    return !row || (row.last < need && now - (row.updated ?? 0) > RETRY_MS);
  });
  const todo = stale.slice(0, Math.max(0, budget.left));
  if (!todo.length) return snap;

  const got = await pool(todo, 6, (s) => fetchDaily(s.code, SPARK_DAYS, budget));
  const rows = [];
  todo.forEach((s, i) => {
    const ser = got[i] && toSeries(got[i], need);
    if (ser) rows.push({ code: s.code, name: s.name, market: s.market, ...ser, ugen: null });
  });
  if (!rows.length) return snap;

  await putSeries(db, rows);
  for (const r of rows) stored.set(r.code, { ...r, updated: now });
  const next = { ...snap, lists: attachSparks(snap.lists, stored, sessionDay, new Map()) };
  await putBlob(db, HOME_KEY, next);
  return next;
}

/** 1+2단계를 이어서 (cron·응답 뒤 갱신용) */
export async function refreshHome(db, budget, prev, now = Date.now()) {
  const phase1 = await refreshPrices(db, budget, prev, now);
  return backfillSparks(db, budget, phase1, now);
}
