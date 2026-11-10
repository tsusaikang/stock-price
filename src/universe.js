// 관련종목 후보군(약 440종목)의 최근 종가를 하루 한 번 다시 받는다.
//
// 무료 플랜은 호출당 외부 요청 50개, CPU 10ms가 상한이라 한 번에 못 받는다. 그래서 진행
// 상태를 D1에 적어 두고, 호출될 때마다 한 단계만 진행한다.
//
//   cap     시총 상위 200×2 목록 (랭킹 4페이지, ~740 KB JSON — CPU 때문에 단독으로)
//   movers  급등·급락·검색상위 목록 (6페이지, ~370 KB) → 후보 확정
//   daily   일봉을 ≤45종목씩 (약 10번), 실패한 종목은 끝에 한 번 더
//
// 호출하는 곳: cron(장 마감 뒤 1분마다), /api/universe, /api/stock 응답 뒤(daily 단계만).
// 같은 묶음을 두 번 처리해도 결과가 같으므로(덮어쓰기) 경합은 따로 막지 않는다 — 진행
// 위치(cursor)는 자기 묶음을 처리한 쪽만 쓰므로 건너뛰는 일은 없고 중복만 생길 수 있다.

import { lastClosedDay, pool } from './util.js';
import { fetchRanking, fetchDaily, isPreferred } from './naver.js';
import { getBlob, putBlob, putSeries, pruneSeries } from './store.js';

const KEY = 'universe';
const CAP_PER_MARKET = 200; // 시장별 시총 상위
const SERIES_DAYS = 100; // 달력 기준 → 거래일 약 68일 (상관계수에 61일 필요, 명절 주간 대비 여유)
export const KEEP_CLOSES = 70;
const MIN_CODES = 300; // 이보다 적으면 목록이 잘못 받아진 것으로 본다

export async function getState(db) {
  return (await getBlob(db, KEY))?.value ?? null;
}

export function needsWork(state, now = Date.now()) {
  return !state || state.gen !== lastClosedDay(now) || !state.done;
}

/** 일봉을 저장용 종가 배열로. 아직 마감 안 된 봉(upTo 이후)은 뺀다. */
export function toSeries(rows, upTo) {
  let end = rows.length;
  while (end > 0 && rows[end - 1].d > upTo) end--;
  if (!end) return null;
  return { last: rows[end - 1].d, closes: rows.slice(Math.max(0, end - KEEP_CLOSES), end).map((r) => r.c) };
}

const meta = (s) => [s.code, s.name, s.market];

/**
 * 한 단계 진행. budget은 이 호출(invocation)의 남은 외부 요청 수와 시한.
 * @param {{lists?: boolean}} opts lists=false면 목록 단계(cap/movers)는 건너뛴다 —
 *   사용자 요청 뒤에 붙는 작업은 CPU 여유가 적어서 가벼운 daily 단계만 맡긴다.
 */
export async function step(db, budget, { now = Date.now(), lists = true } = {}) {
  const gen = lastClosedDay(now);
  const state = await getState(db);

  // ── 새 세대: 시총 목록 ──
  if (!state || state.gen !== gen) {
    if (!lists) return { did: 'skip', reason: '목록 단계는 cron·/api/universe에서만' };
    let cap;
    try {
      cap = await fetchRanking('marketValue', CAP_PER_MARKET, budget, { strict: true });
    } catch (err) {
      return { did: 'skip', reason: `시총 목록 실패: ${err.message}` };
    }
    const codes = cap.filter((s) => !isPreferred(s.code)).map(meta);
    await putBlob(db, KEY, { gen, phase: 'movers', codes, started: now, prev: state?.codes?.length ?? 0 });
    return { did: 'cap', gen, total: codes.length };
  }

  // ── 급등락·검색상위 목록을 더해 후보 확정 ──
  if (state.phase === 'movers') {
    if (!lists) return { did: 'skip', reason: '목록 단계는 cron·/api/universe에서만' };
    // 이쪽은 덤이라 일부 페이지가 실패해도 진행한다(시총 목록이 이미 300종목 넘게 있다).
    const movers = await Promise.all([
      fetchRanking('up', 40, budget),
      fetchRanking('down', 40, budget),
      fetchRanking('searchTop', 30, budget),
    ]);
    const seen = new Map(state.codes.map((m) => [m[0], m]));
    for (const s of movers.flat()) {
      if (s?.code && !seen.has(s.code) && !isPreferred(s.code)) seen.set(s.code, meta(s));
    }
    if (seen.size < MIN_CODES) return { did: 'skip', reason: `후보 ${seen.size}개뿐 — 보류` };
    await putBlob(db, KEY, {
      gen,
      phase: 'daily',
      codes: [...seen.values()],
      cursor: 0,
      retry: [],
      done: false,
      started: state.started,
    });
    await pruneSeries(db, 30 * 86_400_000);
    return { did: 'movers', gen, total: seen.size };
  }

  if (state.done) return { did: 'none', gen };

  // ── 일봉 묶음: 처음 한 바퀴, 그다음 실패분 한 번 더 ──
  const retrying = state.cursor >= state.codes.length;
  const source = retrying ? state.retry : state.codes.slice(state.cursor);
  if (!source.length) {
    await putBlob(db, KEY, { ...state, done: true, finished: now });
    return { did: 'none', gen };
  }
  const k = Math.min(budget.left, source.length);
  if (k <= 0) return { did: 'skip', reason: 'budget' };
  const chunk = source.slice(0, k);

  const got = await pool(chunk, 6, ([code]) => fetchDaily(code, SERIES_DAYS, budget));
  const rows = [];
  const failed = [];
  chunk.forEach((m, i) => {
    const s = got[i] && toSeries(got[i], gen);
    if (s) rows.push({ code: m[0], name: m[1], market: m[2], ...s, ugen: gen });
    else failed.push(m);
  });
  // 하나도 못 받았으면(네이버 차단·시한 초과) 진행시키지 않는다 — 다음 호출에서 다시.
  if (!rows.length && chunk.length) return { did: 'skip', reason: '묶음 전체 실패', at: state.cursor };

  await putSeries(db, rows);

  let next;
  if (!retrying) {
    next = { ...state, cursor: state.cursor + k, retry: [...state.retry, ...failed] };
  } else {
    // 재시도에서도 실패한 종목은 이번 세대에서는 포기한다(내일 다시).
    next = { ...state, retry: state.retry.slice(k), dropped: (state.dropped ?? 0) + failed.length };
  }
  next.done = next.cursor >= next.codes.length && next.retry.length === 0;
  if (next.done) next.finished = now;
  await putBlob(db, KEY, next);

  return {
    did: retrying ? 'retry' : 'daily',
    gen,
    saved: rows.length,
    failed: failed.length,
    progress: `${Math.min(next.cursor, next.codes.length)}/${next.codes.length}`,
    done: next.done,
  };
}
