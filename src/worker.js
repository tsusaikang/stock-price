// Cloudflare Worker 진입점. 정적 파일(public/)은 Static Assets가 Worker를 거치지 않고 직접
// 내보내므로(무료·무제한), 여기로 오는 건 /api/*, /healthz, 그리고 없는 경로뿐이다.
//
// 무료 플랜 제약에 맞춘 구조:
//  - 호출당 외부 요청 50개 → 모든 네이버 호출이 Budget(45)을 차감한다.
//  - 호출당 CPU 10ms → 무거운 일(후보군 440종목)은 여러 호출로 쪼갠다(universe.js).
//  - 메모리 캐시를 믿을 수 없음 → 화면 스냅숏과 종가는 D1에 둔다(store.js).
//  - cron은 어디서 돌지 모른다 → 사용자가 기다리는 경로에는 넣지 않고, 미리 데우는 데만 쓴다.

import {
  Budget,
  inSession,
  lastClosedDay,
  daysBefore,
  sessionDayGuess,
  phaseMismatch,
  ymdOfIso,
  json,
} from './util.js';
import { fetchBasic, fetchIntegration, fetchDaily, fetchQuotes, search, fetchIndex, fetchRanking } from './naver.js';
import { dbOrNull, getBlob, getUniverse, getSeries, putSeries, acquireLease, releaseLease, countGen } from './store.js';
import { HOME_KEY, refreshPrices, backfillSparks, refreshHome, sparkOf, RETRY_MS } from './home.js';
import { findRelated } from './related.js';
import { getState, needsWork, step, toSeries } from './universe.js';

const LOCK = 'home_lock';
const LOCK_TTL = 30_000;
// 장중엔 cron이 1분마다 데우므로 사용자 요청이 갱신을 거들 일은 cron이 멈췄을 때뿐이다.
const MAX_AGE_SESSION = 3 * 60_000;
const MAX_AGE_OFF = 15 * 60_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 응답 공통: 화면이 받아온 시각(updatedAt)과 네이버에서 받아온 시각(fetchedAt) */
const homeResponse = (snap, extra = {}) =>
  json({ ...snap, fetchedAt: snap.fetchedAt, updatedAt: new Date().toISOString(), ...extra });

/** 잠금을 잡고 첫 화면 전체 갱신. 다른 곳이 갱신 중이면 아무것도 안 한다. */
async function refreshLocked(db, budget, prev) {
  if (!(await acquireLease(db, LOCK, LOCK_TTL))) return null;
  try {
    return await refreshHome(db, budget, prev);
  } finally {
    await releaseLease(db, LOCK).catch(() => {});
  }
}

const routes = {
  /**
   * 첫 화면.
   * - 저장분이 없거나, 장 상태가 어긋났으면(아침에 어제 마감 화면 등) 기다려서 새로 받는다.
   *   가격 단계만 기다리고(서울 근처 0.3~1초) 스파크라인 보충은 응답 뒤에 한다.
   * - 그냥 묵은 정도면 저장분을 바로 주고 뒤에서 갱신, 응답에 stale:true를 붙인다.
   *   화면(app.js)은 stale이면 2.5초 뒤 한 번 더 받는다.
   */
  async '/api/home'(req, env, ctx) {
    const db = await dbOrNull(env);
    if (!db) {
      // D1이 죽었으면 저장 없이 가격만 (스파크라인 없음)
      const { snap } = await refreshPrices(null, new Budget());
      return homeResponse(snap, { d1: false });
    }

    const now = Date.now();
    const saved = await getBlob(db, HOME_KEY);
    const age = saved ? now - saved.updated : Infinity;

    if (!saved || (age > 60_000 && phaseMismatch(saved.value, now))) {
      if (await acquireLease(db, LOCK, LOCK_TTL)) {
        const budget = new Budget();
        try {
          const phase1 = await refreshPrices(db, budget, saved?.value, now);
          ctx.waitUntil(
            backfillSparks(db, budget, phase1)
              .catch((err) => console.error('backfill', err.message))
              .finally(() => releaseLease(db, LOCK).catch(() => {}))
          );
          return homeResponse(phase1.snap);
        } catch (err) {
          await releaseLease(db, LOCK).catch(() => {});
          if (!saved) throw err;
          console.error('sync refresh failed, serving saved', err.message);
        }
      }
      if (saved) return homeResponse(saved.value, { stale: true });
      throw new HttpError(503, '첫 화면을 만드는 중입니다. 잠시 뒤 다시 시도하세요');
    }

    const maxAge = inSession(now) ? MAX_AGE_SESSION : MAX_AGE_OFF;
    if (age > maxAge) {
      ctx.waitUntil(refreshLocked(db, new Budget(), saved.value).catch((err) => console.error('home', err.message)));
      return homeResponse(saved.value, { stale: true });
    }
    return homeResponse(saved.value);
  },

  /** 관심종목: 현재가는 한 번에(외부 요청 1개), 스파크라인은 D1 + 부족분만 */
  async '/api/quotes'(req, env) {
    const codes = (new URL(req.url).searchParams.get('codes') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => /^[0-9A-Z]{6}$/.test(c))
      .slice(0, 30);
    if (!codes.length) return json([]);

    const budget = new Budget();
    const db = await dbOrNull(env);
    const [quotes, home] = await Promise.all([
      fetchQuotes(codes, budget),
      db ? getBlob(db, HOME_KEY).catch(() => null) : null,
    ]);
    // 일괄 조회의 시각은 요청 시각이라 거래일 판단에 못 쓴다 → 지수 시각, 없으면 요일·시간으로.
    const sessionDay = ymdOfIso(home?.value?.indices?.[0]?.tradedAt) ?? sessionDayGuess();

    let stored = new Map();
    if (db) {
      stored = await getSeries(db, quotes.map((q) => q.code));
      const need = lastClosedDay();
      const now = Date.now();
      const todo = quotes
        .filter((q) => {
          const row = stored.get(q.code);
          return !row || (row.last < need && now - (row.updated ?? 0) > RETRY_MS);
        })
        .slice(0, budget.left);
      if (todo.length) {
        const got = await Promise.all(todo.map((q) => fetchDaily(q.code, 60, budget).catch(() => null)));
        const rows = [];
        todo.forEach((q, i) => {
          const s = got[i] && toSeries(got[i], need);
          if (s) rows.push({ code: q.code, name: q.name, market: q.market, ...s, ugen: null });
        });
        await putSeries(db, rows).catch(() => {});
        for (const r of rows) stored.set(r.code, r);
      }
    }

    const byCode = new Map(
      quotes.map((q) => {
        const row = stored.get(q.code);
        return [q.code, { ...q, spark: row ? sparkOf(row, q.price, sessionDay) : [] }];
      })
    );
    return json(codes.map((c) => byCode.get(c)).filter(Boolean));
  },

  /** 종목 상세: 시세 + 일봉 1년 + 관련 종목 */
  async '/api/stock'(req, env, ctx) {
    const code = new URL(req.url).searchParams.get('code') ?? '';
    if (!/^[0-9A-Z]{6}$/.test(code)) throw new HttpError(400, '종목코드가 올바르지 않습니다');

    const budget = new Budget();
    const db = await dbOrNull(env);
    const [basic, integ, ohlcv, universe] = await Promise.all([
      fetchBasic(code, budget),
      fetchIntegration(code, budget).catch(() => ({ totals: [], industryPeers: [] })),
      fetchDaily(code, 400, budget),
      db ? getUniverse(db, daysBefore(lastClosedDay(), 10)).catch(() => []) : [],
    ]);

    const rel = findRelated(code, ohlcv, universe);

    // 칩에 붙일 지금 등락률: 최대 12종목을 외부 요청 1개로
    const chipCodes = [...rel.together, ...rel.opposite].map((s) => s.code);
    if (chipCodes.length) {
      const live = new Map((await fetchQuotes(chipCodes, budget).catch(() => [])).map((q) => [q.code, q]));
      for (const s of [...rel.together, ...rel.opposite]) {
        const q = live.get(s.code);
        if (q) Object.assign(s, { rate: q.rate, price: q.price });
      }
    }

    // 후보군 일봉이 덜 찼으면 남은 예산으로 한 묶음 (가벼운 daily 단계만; 응답은 기다리지 않는다)
    if (db) {
      ctx.waitUntil(
        getState(db)
          .then((st) => (needsWork(st) ? step(db, budget, { lists: false }) : null))
          .then((r) => r && r.did !== 'skip' && console.log(JSON.stringify({ universe: r, via: 'stock' })))
          .catch((err) => console.error('universe step', err.message))
      );
    }

    return json({
      ...basic,
      totals: integ.totals,
      ohlcv,
      related: {
        industry: integ.industryPeers.slice(0, 6),
        together: rel.together,
        opposite: rel.opposite,
        basis: rel.basis,
        ...(db ? {} : { d1: false }),
      },
    });
  },

  // D1을 안 쓰는 경로 — D1이 죽어도 검색은 된다.
  async '/api/search'(req) {
    return json(await search(new URL(req.url).searchParams.get('q') ?? '', new Budget()));
  },

  /** 후보군 진행 상황. 덜 됐으면 한 단계 진행한다(다 됐으면 네이버를 부르지 않는다). */
  async '/api/universe'(req, env) {
    const db = await dbOrNull(env);
    if (!db) throw new HttpError(503, 'D1을 쓸 수 없습니다');
    const before = await getState(db);
    const result = needsWork(before) ? await step(db, new Budget()) : { did: 'none' };
    const st = await getState(db);
    const gen = lastClosedDay();
    return json({
      result,
      target: gen,
      gen: st?.gen ?? null,
      phase: st?.phase ?? null,
      progress: st?.codes ? `${Math.min(st.cursor ?? 0, st.codes.length)}/${st.codes.length}` : '0/0',
      saved: st?.gen ? await countGen(db, st.gen) : 0, // 실제로 저장된 종목 수 (실패분 제외)
      retry: st?.retry?.length ?? 0,
      dropped: st?.dropped ?? 0,
      done: !!st?.done && st.gen === gen,
      started: st?.started ? new Date(st.started).toISOString() : null,
      finished: st?.finished ? new Date(st.finished).toISOString() : null,
    });
  },

  /**
   * 배포 후 점검용. 네이버 각 엔드포인트가 이 Worker에서 닿는지, 어느 데이터센터에서 돌고
   * 있는지(colo), D1까지 왕복이 얼마인지 한 번에 본다.  curl https://stock.dwnc.me/api/diag
   */
  async '/api/diag'(req, env) {
    const budget = new Budget();
    const checks = [
      ['지수', 'm.stock.naver.com', () => fetchIndex('KOSPI', budget)],
      ['랭킹', 'm.stock.naver.com', () => fetchRanking('up', 5, budget, { strict: true })],
      ['종목시세', 'm.stock.naver.com', () => fetchBasic('005930', budget)],
      ['업종비교', 'm.stock.naver.com', () => fetchIntegration('005930', budget)],
      ['여러종목', 'polling.finance.naver.com', () => fetchQuotes(['005930', '000660'], budget)],
      ['검색', 'ac.stock.naver.com', () => search('삼성', budget)],
      ['일봉차트', 'api.finance.naver.com', () => fetchDaily('005930', 30, budget)],
    ];
    const results = await Promise.all(
      checks.map(async ([name, host, run]) => {
        const t0 = Date.now();
        try {
          const v = await run();
          const size = Array.isArray(v) ? v.length : 1;
          if (!size) throw new Error('빈 응답');
          return { name, host, ok: true, ms: Date.now() - t0, size };
        } catch (err) {
          return { name, host, ok: false, ms: Date.now() - t0, error: err.message };
        }
      })
    );

    let egress = null;
    try {
      budget.take();
      const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      egress = { ip: j.ip, country: j.country, city: j.city, org: j.org };
    } catch {
      /* 없어도 그만 */
    }

    let d1 = { ok: false };
    const db = await dbOrNull(env);
    if (db) {
      const t0 = Date.now();
      await db.prepare('SELECT 1').first();
      const ms = Date.now() - t0;
      const [home, uni] = await Promise.all([getBlob(db, HOME_KEY), getState(db)]);
      d1 = {
        ok: true,
        roundTripMs: ms, // 이 데이터센터에서 D1까지. 60ms를 크게 넘으면 D1 위치를 다시 볼 것
        homeAgeSec: home ? Math.round((Date.now() - home.updated) / 1000) : null,
        homePartial: home?.value?.partial ?? null,
        universe: uni ? { gen: uni.gen, phase: uni.phase, progress: `${uni.cursor ?? 0}/${uni.codes?.length ?? 0}`, done: !!uni.done } : null,
      };
    }

    return json({
      ok: results.every((r) => r.ok) && d1.ok,
      colo: req.cf?.colo ?? null, // 이 요청을 처리한 데이터센터 (ICN 서울, NRT 도쿄, HKG 홍콩)
      egress,
      d1,
      upstreamUsed: budget.used,
      checks: results,
    });
  },

  '/healthz'(req) {
    return json({ ok: true, colo: req.cf?.colo ?? null });
  },
};

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    const route = routes[pathname];
    if (!route) {
      return new Response('없는 페이지', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'GET만 받습니다' }, { status: 405 });
    try {
      return await route(req, env, ctx);
    } catch (err) {
      console.error(`[api] ${pathname}:`, err.message);
      return json({ error: err.message }, { status: err.status ?? 502 });
    }
  },

  /**
   * cron (한국 08:00~17:59, 1분마다). 할 일은 시각을 보고 고른다.
   *  - 장중(평일 08:30~15:45): 첫 화면 갱신 → 사용자가 열 때 이미 1~2분 안쪽 값
   *  - 그 밖: 장 상태가 바뀌었으면(마감 직후 등) 첫 화면 한 번, 그리고 후보군 재구축 한 단계
   * cron은 어느 데이터센터에서 돌지 모르니 느릴 수 있다. 그래서 시한을 넉넉히(10분) 둔다.
   */
  async scheduled(controller, env) {
    const db = await dbOrNull(env);
    if (!db) return;
    const now = Date.now();
    const budget = new Budget(undefined, { deadlineMs: 10 * 60_000 });

    const saved = await getBlob(db, HOME_KEY);
    const age = saved ? now - saved.updated : Infinity;
    const homeDue = inSession(now) ? age > 50_000 : age > 60_000 && phaseMismatch(saved?.value, now);
    if (homeDue) {
      const t0 = Date.now();
      const r = await refreshLocked(db, budget, saved?.value).catch((err) => ({ error: err.message }));
      console.log(JSON.stringify({ cron: 'home', ms: Date.now() - t0, used: budget.used, ...(r?.error ? r : {}) }));
    }

    if (!inSession(now) && budget.left >= 10) {
      const st = await getState(db);
      if (needsWork(st, now)) {
        const r = await step(db, budget, { now });
        console.log(JSON.stringify({ cron: 'universe', ...r }));
      }
    }
  },
};
