// 의존성 없는 정적 서버 + 네이버 금융 프록시.
// 브라우저에서 네이버를 직접 부르면 CORS에 막히므로 서버가 중계하고 캐시한다.

import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchIndex,
  fetchRanking,
  fetchBasic,
  fetchIntegration,
  fetchDaily,
  search,
  pool,
  clearCache,
  upstreamLoad,
} from './lib/naver.js';
import { findRelated, warmUp } from './lib/related.js';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SPARK_DAYS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const json = (res, body, status = 200) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
};

/** 목록에 미니 차트용 종가 배열을 붙인다. */
async function withSparks(stocks) {
  const series = await pool(stocks, 8, (s) => fetchDaily(s.code));
  return stocks.map((s, i) => ({
    ...s,
    spark: series[i] ? series[i].slice(-SPARK_DAYS).map((r) => r.c) : [],
  }));
}

const routes = {
  // 플랫폼 헬스체크용. 네이버를 부르지 않고 즉시 답한다 —
  // 시작 직후 warmUp이 도는 동안에도 배포가 실패로 판정되지 않게.
  '/healthz'() {
    return { ok: true, uptimeSec: Math.round(process.uptime()) };
  },

  async '/api/home'() {
    const [kospi, kosdaq, up, down, issue, cap] = await Promise.all([
      fetchIndex('KOSPI'),
      fetchIndex('KOSDAQ'),
      fetchRanking('up', 30),
      fetchRanking('down', 30),
      fetchRanking('searchTop', 20),
      fetchRanking('marketValue', 20),
    ]);

    const [upS, downS, issueS, capS] = await Promise.all([
      withSparks(up.slice(0, 15)),
      withSparks(down.slice(0, 15)),
      withSparks(issue.slice(0, 15)),
      withSparks(cap.slice(0, 15)),
    ]);

    return {
      indices: [kospi, kosdaq],
      lists: { up: upS, down: downS, issue: issueS, cap: capS },
      updatedAt: new Date().toISOString(),
    };
  },

  async '/api/quotes'(url) {
    const codes = (url.searchParams.get('codes') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 30);
    if (!codes.length) return [];
    const stocks = (await pool(codes, 8, (c) => fetchBasic(c))).filter(Boolean);
    return withSparks(stocks);
  },

  async '/api/stock'(url) {
    const code = url.searchParams.get('code');
    if (!/^[0-9A-Z]{6}$/.test(code ?? '')) {
      const err = new Error('종목코드가 올바르지 않습니다');
      err.status = 400;
      throw err;
    }

    const [basic, integ, ohlcv, related] = await Promise.all([
      fetchBasic(code),
      fetchIntegration(code).catch(() => ({ totals: [], industryPeers: [], industryCode: null })),
      fetchDaily(code),
      findRelated(code).catch(() => ({ together: [], opposite: [], basis: 0 })),
    ]);

    return {
      ...basic,
      totals: integ.totals,
      ohlcv,
      related: {
        industry: integ.industryPeers.slice(0, 6),
        together: related.together,
        opposite: related.opposite,
        basis: related.basis,
      },
    };
  },

  '/api/search'(url) {
    return search(url.searchParams.get('q') ?? '');
  },

  /**
   * 배포 후 점검용. 네이버의 각 엔드포인트가 이 서버에서 실제로 닿는지 본다.
   * 해외 리전에 올렸을 때 어디가 막혔는지 한 번에 판정하려고 만든 것.
   *   curl https://<주소>/api/diag?fresh=1
   */
  async '/api/diag'(url) {
    if (url.searchParams.get('fresh')) clearCache();

    const checks = [
      ['지수', 'm.stock.naver.com', () => fetchIndex('KOSPI')],
      ['랭킹', 'm.stock.naver.com', () => fetchRanking('up', 5)],
      ['종목시세', 'm.stock.naver.com', () => fetchBasic('005930')],
      ['업종비교', 'm.stock.naver.com', () => fetchIntegration('005930')],
      ['검색', 'ac.stock.naver.com', () => search('삼성')],
      ['일봉차트', 'api.finance.naver.com', () => fetchDaily('005930', 30)],
    ];

    const results = await Promise.all(
      checks.map(async ([name, host, run]) => {
        const t0 = Date.now();
        try {
          const val = await run();
          const size = Array.isArray(val) ? val.length : 1;
          if (!size) throw new Error('빈 응답');
          return { name, host, ok: true, ms: Date.now() - t0, size };
        } catch (err) {
          return { name, host, ok: false, ms: Date.now() - t0, error: err.message };
        }
      })
    );

    // 서버가 어느 나라에서 나가는지 (네이버 차단 여부 판단에 필요)
    let egress = null;
    try {
      const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      egress = { ip: j.ip, country: j.country, region: j.region, org: j.org };
    } catch {
      /* 없어도 그만 */
    }

    return {
      ok: results.every((r) => r.ok),
      egress,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      upstream: upstreamLoad(),
      checks: results,
    };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (routes[url.pathname]) {
    try {
      json(res, await routes[url.pathname](url));
    } catch (err) {
      console.error(`[api] ${url.pathname}:`, err.message);
      json(res, { error: err.message }, err.status ?? 502);
    }
    return;
  }

  // 정적 파일
  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 페이지');
  }
});

const PRIME_HEAVY_MS = 10 * 60_000; // 후보군 431종목 일봉 — 무겁고 드물게
const PRIME_LIGHT_MS = 60_000; // 지수·랭킹 — 가볍고 자주, 장중에만

/** 장이 열려 있을 만한 시간대인가 (평일 08:30~15:45 KST, 동시호가 포함) */
function marketHours(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const mins = Number(p.hour) * 60 + Number(p.minute);
  return mins >= 510 && mins <= 945;
}

/**
 * 첫 화면(지수·랭킹)만 다시 받는다.
 * 이게 없으면 조용한 시간대에 캐시가 10분까지 늙어서, 화면에 찍히는
 * "시세 시점"이 실제보다 한참 뒤처진다.
 */
async function primeLight() {
  if (!marketHours()) return;
  try {
    await routes['/api/home']();
  } catch {
    /* 다음 주기에 다시 시도 */
  }
}

/** 관련종목 후보군 일봉까지 통째로 데운다. */
async function primeHeavy(label) {
  const t0 = Date.now();
  try {
    const { count } = await warmUp();
    await routes['/api/home']();
    console.log(`  [${label}] 후보 ${count}개 + 첫 화면 캐시 (${Date.now() - t0}ms)\n`);
  } catch (err) {
    console.warn(`  [${label}] 실패: ${err.message}\n`);
  }
}

/** 같은 와이파이의 폰에서 접속할 주소 */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, () => {
  const lan = lanAddress();
  console.log(`\n  주가 보기  →  http://localhost:${PORT}`);
  if (lan) console.log(`  폰에서    →  http://${lan}:${PORT}   (같은 와이파이)\n`);
  else console.log('');

  // 캐시를 계속 따뜻하게 유지한다. 비어 있을 때만 사용자가 기다리므로,
  // 만료를 사용자 요청이 아니라 이 타이머들이 먼저 맞게 한다.
  primeHeavy('준비완료');
  setInterval(() => primeHeavy('갱신'), PRIME_HEAVY_MS).unref();
  setInterval(primeLight, PRIME_LIGHT_MS).unref();
});
