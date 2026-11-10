// Cloudflare Worker 진입점. 정적 파일(public/)은 Static Assets가 Worker를 거치지 않고 직접
// 내보내므로(무료·무제한), 여기로 오는 건 /api/*, /healthz, 그리고 없는 경로뿐이다.
//
// 무료 플랜 제약에 맞춘 구조:
//  - 호출당 외부 요청 50개 → 모든 네이버 호출이 Budget을 차감한다.
//  - 호출당 CPU 10ms → 실측상 외부 요청 1개 ≈ 1ms라서, 호출 하나에 요청 ~10개까지로 묶는다.
//    무거운 일(후보군 440종목, 스파크라인 보충)은 cron이 1분에 한 덩어리씩 나눠 한다.
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
import { dbOrNull, getBlob, getUniverse, getSeries, putSeries, acquireLease, releaseLease, countGen, getPack } from './store.js';
import { HOME_KEY, refreshPrices, backfillSaved, sparkOf, RETRY_MS } from './home.js';
import { findRelated, unpack } from './related.js';
import { getState, needsWork, step, toSeries, STEP_FETCHES, PACK_KEY } from './universe.js';

const LOCK = 'home_lock';
const LOCK_TTL = 30_000;
// 장중엔 cron이 2분마다 가격을 데우므로 사용자 요청이 갱신을 거들 일은 cron이 멈췄을 때뿐이다.
const MAX_AGE_SESSION = 3 * 60_000;
const MAX_AGE_OFF = 15 * 60_000;
const CRON_PRICE_EVERY = 100_000; // 장중 가격 갱신 간격(약 2분). 사이 분에는 스파크라인을 보충한다.
const PRICE_FETCHES = 9; // 지수 1 + 랭킹 8

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 응답 공통: 화면이 받아온 시각(updatedAt)과 네이버에서 받아온 시각(fetchedAt) */
const homeResponse = (snap, extra = {}) =>
  json({ ...snap, fetchedAt: snap.fetchedAt, updatedAt: new Date().toISOString(), ...extra });

/** 잠금을 잡고 첫 화면 가격 갱신. 다른 곳이 갱신 중이면 아무것도 안 한다. */
async function refreshLocked(db, budget, prev) {
  if (!(await acquireLease(db, LOCK, LOCK_TTL))) return null;
  try {
    return (await refreshPrices(db, budget, prev)).snap;
  } finally {
    await releaseLease(db, LOCK).catch(() => {});
  }
}

/**
 * 상관계수 후보군. 하루 한 번 만드는 포장본(Float32 행렬 1행)을 읽고, 같은 인스턴스 안에서는
 * 10분간 메모리에 둔다. 434행을 D1에서 꺼내 하나씩 파싱하던 것이 상세 화면 CPU의 대부분이었다.
 * 포장본이 아직 없으면(첫 배포 직후 등) 행 단위로 읽는다.
 */
let universeMemo = null;
async function loadUniverse(db) {
  if (universeMemo && Date.now() - universeMemo.at < 10 * 60_000) return universeMemo.rows;
  const pack = await getPack(db, PACK_KEY).catch(() => null);
  if (pack) {
    universeMemo = { rows: unpack(pack), at: Date.now() };
    return universeMemo.rows;
  }
  return getUniverse(db, daysBefore(lastClosedDay(), 10)).catch(() => []);
}

const routes = {
  /**
   * 첫 화면.
   * - 저장분이 없거나, 장 상태가 어긋났으면(아침에 어제 마감 화면 등) 기다려서 새로 받는다.
   *   가격 단계만 기다린다(서울 근처 0.3~1초). 스파크라인 보충은 cron 몫이다.
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
        try {
          // 가격만 기다린다. 비어 있는 스파크라인은 cron이 다음 분부터 채운다.
          const { snap } = await refreshPrices(db, new Budget(PRICE_FETCHES), saved?.value, now);
          return homeResponse(snap);
        } catch (err) {
          if (!saved) throw err;
          console.error('sync refresh failed, serving saved', err.message);
        } finally {
          await releaseLease(db, LOCK).catch(() => {});
        }
      }
      if (saved) return homeResponse(saved.value, { stale: true });
      throw new HttpError(503, '첫 화면을 만드는 중입니다. 잠시 뒤 다시 시도하세요');
    }

    const maxAge = inSession(now) ? MAX_AGE_SESSION : MAX_AGE_OFF;
    if (age > maxAge) {
      ctx.waitUntil(
        refreshLocked(db, new Budget(PRICE_FETCHES), saved.value).catch((err) => console.error('home', err.message))
      );
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
        .slice(0, Math.min(budget.left, 5)); // CPU 때문에 한 번에 5개까지, 나머지는 다음에
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
      db ? loadUniverse(db) : [],
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
    const result = needsWork(before) ? await step(db, new Budget(STEP_FETCHES)) : { did: 'none' };
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
      done: st?.phase === 'done' && st.gen === gen,
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
   * cron (한국 08:00~17:59, 1분마다). 한 번에 **한 덩어리**만 한다 — 무료 플랜 CPU 10ms가
   * 외부 요청 개수에 거의 비례해서(1개 ≈ 1ms), 두 가지를 겹치면 넘친다.
   *
   *   장중(평일 08:30~15:45): 가격이 100초 넘게 묵었으면 가격 갱신(요청 9), 아니면 스파크라인 보충(≤8)
   *                           → 가격은 약 2분마다, 사이 분에 스파크라인
   *   그 밖:                  장 상태가 바뀌었으면 가격 한 번 → 아니면 후보군 재구축 한 단계(≤10)
   *                           → 아니면 스파크라인 보충
   * cron은 어느 데이터센터에서 돌지 모르니 느릴 수 있다. 시한은 넉넉히(5분) 둔다.
   */
  async scheduled(controller, env) {
    const db = await dbOrNull(env);
    if (!db) return;
    const now = Date.now();
    const log = (o) => console.log(JSON.stringify({ cron: controller.cron, ...o }));
    const budgetOf = (n) => new Budget(n, { deadlineMs: 5 * 60_000 });

    const saved = await getBlob(db, HOME_KEY);
    const age = saved ? now - saved.updated : Infinity;
    const session = inSession(now);

    const pricesDue = session ? age > CRON_PRICE_EVERY : age > 60_000 && phaseMismatch(saved?.value, now);
    if (pricesDue) {
      const r = await refreshLocked(db, budgetOf(PRICE_FETCHES), saved?.value).catch((err) => ({ error: err.message }));
      return log({ did: 'prices', ...(r?.error ? r : { skipped: r === null }) });
    }

    if (!session) {
      const st = await getState(db);
      if (needsWork(st, now)) return log({ did: 'universe', ...(await step(db, budgetOf(STEP_FETCHES), { now })) });
    }

    if (saved) {
      const r = await backfillSaved(db, budgetOf(8), saved.value, now).catch((err) => ({ error: err.message }));
      if (r) log({ did: 'backfill', ...(r.error ? r : {}) });
    }
  },
};
