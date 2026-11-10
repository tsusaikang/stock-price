// 관련종목 후보군(약 440종목)의 최근 종가를 하루 한 번 다시 받는다.
//
// 무료 플랜은 호출당 CPU 10ms가 상한인데, 실측해 보니 CPU를 먹는 건 내려받은 용량보다
// **외부 요청 개수**였다(요청 1개당 약 1ms: 4KB 일봉 45개 = 31~87ms, 190KB 랭킹 4개 = 17ms).
// 그래서 호출 한 번에 외부 요청을 10개 이하로 묶고, 진행 상태를 D1에 적어 두고 한 단계씩 간다.
//
//   cap-kospi     코스피 시총 상위 200 (2페이지)
//   cap-kosdaq    코스닥 시총 상위 200 (2페이지)
//   movers-ud     급등·급락 상위 (4페이지)
//   movers-search 검색 상위 (2페이지) → 후보 확정
//   daily         일봉 10종목씩 (약 44번), 실패분은 끝에 한 번 더
//   pack          상관계수용 포장본 생성 (외부 요청 없음)
//
// 호출하는 곳: cron(장 마감 뒤 1분마다), /api/universe. 장 마감 뒤 2시간 남짓 창 안에 끝난다.
// 같은 묶음을 두 번 처리해도 결과가 같으므로(덮어쓰기) 경합은 따로 막지 않는다.

import { lastClosedDay, pool } from './util.js';
import { fetchRanking, fetchDaily, isPreferred } from './naver.js';
import { getBlob, putBlob, putSeries, pruneSeries, getUniverse, putPack } from './store.js';
import { buildPack } from './related.js';

const KEY = 'universe';
export const PACK_KEY = 'universe';
const CAP_PER_MARKET = 200; // 시장별 시총 상위
const SERIES_DAYS = 100; // 달력 기준 → 거래일 약 68일 (상관계수에 61일 필요, 명절 주간 대비 여유)
export const KEEP_CLOSES = 70;
export const STEP_FETCHES = 10; // 호출 한 번에 외부 요청 상한 (CPU 10ms 안쪽)
const MIN_CODES = 300; // 이보다 적으면 목록이 잘못 받아진 것으로 본다

export async function getState(db) {
  return (await getBlob(db, KEY))?.value ?? null;
}

export function needsWork(state, now = Date.now()) {
  // phase !== 'done': 포장 단계가 생기기 전 구조로 "완료"된 상태도 포장까지 마저 하게 한다.
  return !state || state.gen !== lastClosedDay(now) || !state.done || state.phase !== 'done';
}

/** 일봉을 저장용 종가 배열로. 아직 마감 안 된 봉(upTo 이후)은 뺀다. */
export function toSeries(rows, upTo) {
  let end = rows.length;
  while (end > 0 && rows[end - 1].d > upTo) end--;
  if (!end) return null;
  return { last: rows[end - 1].d, closes: rows.slice(Math.max(0, end - KEEP_CLOSES), end).map((r) => r.c) };
}

const meta = (s) => [s.code, s.name, s.market];

function addCodes(codes, stocks) {
  const seen = new Map(codes.map((m) => [m[0], m]));
  for (const s of stocks) {
    if (s?.code && !seen.has(s.code) && !isPreferred(s.code)) seen.set(s.code, meta(s));
  }
  return [...seen.values()];
}

/**
 * 한 단계 진행. budget은 이 호출(invocation)의 남은 외부 요청 수와 시한.
 * @returns {{did: string, ...}}
 */
export async function step(db, budget, { now = Date.now() } = {}) {
  const gen = lastClosedDay(now);
  const state = await getState(db);
  const save = (next) => putBlob(db, KEY, next);

  // 새 세대
  if (!state || state.gen !== gen) {
    try {
      const kospi = await fetchRanking('marketValue', CAP_PER_MARKET, budget, { strict: true, markets: ['KOSPI'] });
      const codes = addCodes([], kospi);
      await save({ gen, phase: 'cap-kosdaq', codes, started: now });
      return { did: 'cap-kospi', gen, total: codes.length };
    } catch (err) {
      return { did: 'skip', reason: `코스피 시총 목록 실패: ${err.message}` };
    }
  }

  switch (state.phase) {
    case 'cap-kosdaq': {
      try {
        const kosdaq = await fetchRanking('marketValue', CAP_PER_MARKET, budget, { strict: true, markets: ['KOSDAQ'] });
        const codes = addCodes(state.codes, kosdaq);
        await save({ ...state, phase: 'movers-ud', codes });
        return { did: 'cap-kosdaq', gen, total: codes.length };
      } catch (err) {
        return { did: 'skip', reason: `코스닥 시총 목록 실패: ${err.message}` };
      }
    }

    case 'movers-ud': {
      // 덤이라 일부 페이지가 실패해도 진행한다(시총 목록이 이미 300종목 넘게 있다).
      const [up, down] = await Promise.all([fetchRanking('up', 40, budget), fetchRanking('down', 40, budget)]);
      const codes = addCodes(state.codes, [...up, ...down]);
      await save({ ...state, phase: 'movers-search', codes });
      return { did: 'movers-ud', gen, total: codes.length };
    }

    case 'movers-search': {
      const top = await fetchRanking('searchTop', 30, budget);
      const codes = addCodes(state.codes, top);
      if (codes.length < MIN_CODES) return { did: 'skip', reason: `후보 ${codes.length}개뿐 — 보류` };
      await save({ ...state, phase: 'daily', codes, cursor: 0, retry: [], done: false });
      await pruneSeries(db, 30 * 86_400_000);
      return { did: 'movers-search', gen, total: codes.length };
    }

    case 'daily': {
      const retrying = state.cursor >= state.codes.length;
      const source = retrying ? state.retry : state.codes.slice(state.cursor);
      if (!source.length) {
        await save({ ...state, phase: 'pack' });
        return { did: 'daily-end', gen };
      }
      const k = Math.min(budget.left, STEP_FETCHES, source.length);
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
      // 하나도 못 받았으면(네이버 차단·시한 초과) 진행시키지 않고 다음 호출에서 다시 — 단, 같은
      // 묶음이 연속 3번 통째로 실패하면 그 묶음 탓(상장폐지 등)으로 보고 넘어간다. 안 그러면 맴돈다.
      const fails = rows.length ? 0 : (state.fails ?? 0) + 1;
      if (!rows.length && fails < 3) {
        await save({ ...state, fails });
        return { did: 'skip', reason: `묶음 전체 실패 (${fails}/3)`, at: state.cursor };
      }
      await putSeries(db, rows);

      const next = retrying
        ? { ...state, fails: 0, retry: state.retry.slice(k), dropped: (state.dropped ?? 0) + failed.length }
        : { ...state, fails: 0, cursor: state.cursor + k, retry: [...state.retry, ...failed] };
      if (next.cursor >= next.codes.length && next.retry.length === 0) next.phase = 'pack';
      await save(next);
      return {
        did: retrying ? 'retry' : 'daily',
        gen,
        saved: rows.length,
        failed: failed.length,
        progress: `${Math.min(next.cursor, next.codes.length)}/${next.codes.length}`,
      };
    }

    case 'pack': {
      // 상세 화면이 434행을 꺼내 하나씩 파싱하지 않도록, 수익률을 Float32 하나로 묶어 둔다.
      const rows = await getUniverse(db, gen);
      const { meta: m, data } = buildPack(rows);
      await putPack(db, PACK_KEY, { ...m, gen }, data);
      await save({ ...state, phase: 'done', done: true, finished: now });
      return { did: 'pack', gen, rows: rows.length };
    }

    default:
      return { did: 'none', gen };
  }
}
