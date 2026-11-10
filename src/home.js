// 첫 화면 데이터(지수 + 급등·급락·이슈·시총)와 스파크라인.
//
// 갱신은 두 단계이고 서로 다른 호출에서 한다.
//   1) 가격: 지수(일괄 1) + 랭킹 8 = 외부 요청 9개. 스파크라인은 D1에 있는 것(+ 이전 화면 것)으로.
//      → 바로 저장. 사용자가 보는 가격은 여기서 최신이 된다.
//   2) 스파크라인 보충: D1에 없거나 묵은 종목의 일봉을 8개까지 받아 다시 저장.
// 무료 플랜 CPU 10ms는 외부 요청 개수에 거의 비례해서(요청 1개 ≈ 1ms) 한 호출에 둘 다 하면 넘친다.

import { lastClosedDay, sessionDayGuess, ymdOfIso, pool } from './util.js';
import { fetchIndices, fetchRanking, fetchDaily } from './naver.js';
import { getSeries, putSeries, putBlob } from './store.js';
import { toSeries } from './universe.js';

export const HOME_KEY = 'home';
const LIST_N = 15;
const SPARK_POINTS = 30;
const SPARK_DAYS = 60; // 달력 기준 → 거래일 약 40일
export const RETRY_MS = 3 * 3_600_000;
export const BACKFILL_MAX = 8;

// [화면 칸, 랭킹 종류, 시장별 개수]. 급등·급락은 ETF·ETN을 걸러내면 많이 줄어서(폭락일엔 코스피
// 하락 상위 30 중 실제 종목이 1개였다) 30씩 받는다. 시총은 합쳐서 15위까지라 코스피 15면 된다.
const LISTS = [
  ['up', 'up', 30],
  ['down', 'down', 30],
  ['issue', 'searchTop', 10],
  ['cap', 'marketValue', 15],
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

// 가격 갱신 묶음. 무료 플랜 CPU가 외부 요청 수에 비례해서(1개 ≈ 1ms) 한 번에 다 받으면(9개)
// 10ms 언저리라, cron은 묶음 하나씩 번갈아 받는다. 지수는 화면 상단 시각의 근거라 A에 둔다.
export const GROUPS = {
  A: { indices: true, lists: ['up', 'down'] }, // 지수 1 + 랭킹 4 = 요청 5
  B: { indices: false, lists: ['issue', 'cap'] }, // 랭킹 4 = 요청 4
};

/** 묶음별 마지막 갱신 시각. 묶음 기록이 없는 옛 스냅숏은 저장 시각으로 친다. */
export const groupAt = (snap, g) => snap?.at?.[g] ?? snap?.fetchedAt ?? 0;

/**
 * 1단계: 가격. groups에 든 묶음만 새로 받고 나머지 칸은 이전 화면 값을 그대로 둔다.
 * 받다가 실패한 칸도 이전 값을 쓴다 — 반쪽짜리(예: 코스피만 있는 급등 목록)로 멀쩡한 화면을
 * 덮어쓰지 않으려는 것. 이전 화면이 없으면 묶음과 상관없이 전부 받는다.
 */
export async function refreshPrices(db, budget, prev, now = Date.now(), { groups = ['A', 'B'] } = {}) {
  if (!prev) groups = ['A', 'B'];
  const wantIndices = groups.some((g) => GROUPS[g].indices);
  const wantLists = new Set(groups.flatMap((g) => GROUPS[g].lists));
  const plan = LISTS.filter(([name]) => wantLists.has(name));

  const [idx, ...ranked] = await Promise.allSettled([
    wantIndices ? fetchIndices(budget) : Promise.resolve(null),
    ...plan.map(([, sort, size]) => fetchRanking(sort, size, budget, { strict: true })),
  ]);

  const failed = [];
  const got = idx.status === 'fulfilled' && idx.value ? idx.value : [];
  const indices = ['KOSPI', 'KOSDAQ']
    .map((code) => {
      const fresh = got.find((i) => i.code === code);
      if (fresh) return fresh;
      if (wantIndices) failed.push(code);
      return prev?.indices?.find((i) => i.code === code) ?? null;
    })
    .filter(Boolean);

  const lists = {};
  for (const [name] of LISTS) {
    const i = plan.findIndex(([n]) => n === name);
    const r = i >= 0 ? ranked[i] : null;
    if (r?.status === 'fulfilled' && r.value.length) lists[name] = r.value.slice(0, LIST_N);
    else {
      if (r) failed.push(name);
      lists[name] = prev?.lists?.[name] ?? [];
    }
  }

  const filled = Object.values(lists).filter((l) => l.length).length;
  if (!indices.length || filled < 3) {
    throw new Error(`첫 화면을 만들 수 없음 (실패: ${failed.join(', ') || '이전 화면 없음'})`);
  }

  const sessionDay = ymdOfIso(indices[0]?.tradedAt) ?? sessionDayGuess(now);
  const prevSparks = new Map(prev ? unique(prev.lists).map((s) => [s.code, s.spark ?? []]) : []);
  const stored = db ? await getSeries(db, unique(lists).map((s) => s.code)).catch(() => new Map()) : new Map();

  const at = { A: groupAt(prev, 'A'), B: groupAt(prev, 'B') };
  for (const g of groups) at[g] = now;

  const snap = {
    indices,
    lists: attachSparks(lists, stored, sessionDay, prevSparks),
    fetchedAt: now,
    at,
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
  const todo = stale.slice(0, Math.max(0, Math.min(budget.left, BACKFILL_MAX)));
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

/** 스파크라인 보충이 필요한 종목이 있나 (cron이 이번 분에 할 일을 고를 때) */
export function needsBackfill(snap, stored, now = Date.now()) {
  const need = lastClosedDay(now);
  return unique(snap.lists).some((s) => {
    const row = stored.get(s.code);
    return !row || (row.last < need && now - (row.updated ?? 0) > RETRY_MS);
  });
}

/** 저장된 화면을 기준으로 스파크라인만 보충 (cron용, 가격은 다시 받지 않는다). 할 일 없으면 null. */
export async function backfillSaved(db, budget, snap, now = Date.now()) {
  const stored = await getSeries(db, unique(snap.lists).map((s) => s.code));
  if (!needsBackfill(snap, stored, now)) return null;
  const sessionDay = ymdOfIso(snap.indices?.[0]?.tradedAt) ?? sessionDayGuess(now);
  return backfillSparks(db, budget, { snap, stored, sessionDay }, now);
}
