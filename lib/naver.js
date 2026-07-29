// 네이버 금융 비공식 JSON API 클라이언트.
// 공식 문서가 없는 엔드포인트라 응답 스키마가 바뀔 수 있음 → 파싱은 모두 방어적으로.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const H_MOBILE = { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' };
const H_FINANCE = { 'User-Agent': UA, Referer: 'https://finance.naver.com/' };

// ── 캐시 ──────────────────────────────────────────────────────────────
// 실시간성이 목표가 아니므로 넉넉하게 잡는다. 같은 키로 동시에 들어온 요청은
// 하나의 upstream 호출로 합친다(dedupe).
const cache = new Map();

export function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.val);
  if (hit && hit.pending) return hit.pending;

  const pending = fn()
    .then((val) => {
      cache.set(key, { val, exp: Date.now() + ttl });
      return val;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });

  cache.set(key, { ...hit, pending });
  return pending;
}

/** 진단용 — 캐시를 비워 upstream을 실제로 때리게 한다. */
export function clearCache() {
  cache.clear();
}

export const TTL = {
  quote: 60_000, // 시세·랭킹
  daily: 300_000, // 일봉 (하루에 한 번만 확정되므로 5분이면 충분)
  search: 600_000,
};

// ── 유틸 ──────────────────────────────────────────────────────────────
const num = (v) => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

async function getJSON(url, headers = H_MOBILE) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const text = await res.text();
  // 잘못된 경로는 200과 함께 HTML 셸을 돌려준다.
  if (text.trimStart().startsWith('<')) throw new Error(`HTML 응답 (경로 오류?): ${url}`);
  return JSON.parse(text);
}

/** 동시성 제한 병렬 실행. 실패한 항목은 null. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          out[i] = await fn(items[i], i);
        } catch {
          out[i] = null;
        }
      }
    })
  );
  return out;
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
export function normStock(s) {
  const rate = num(s.fluctuationsRatio);
  return {
    code: s.itemCode,
    name: s.stockName,
    market: s.stockExchangeType?.nameKor ?? (s.sosok === '1' ? '코스닥' : '코스피'),
    price: num(s.closePrice),
    diff: num(s.compareToPreviousClosePrice) * (rate < 0 ? -1 : 1) || num(s.compareToPreviousClosePrice),
    rate,
    // 상한가/하한가 여부 (사이드카 구경용)
    limitUp: s.compareToPreviousPrice?.code === '1',
    limitDown: s.compareToPreviousPrice?.code === '4',
    marketValue: num(s.marketValue), // 억 단위
  };
}

// ── 엔드포인트 ────────────────────────────────────────────────────────

/** 지수 (KOSPI / KOSDAQ) */
export function fetchIndex(code) {
  return cached(`idx:${code}`, TTL.quote, async () => {
    const j = await getJSON(`https://m.stock.naver.com/api/index/${code}/basic`);
    const rate = num(j.fluctuationsRatio);
    return {
      code,
      name: j.stockName,
      price: num(j.closePrice),
      diff: num(j.compareToPreviousClosePrice) * (rate < 0 ? -1 : 1) || num(j.compareToPreviousClosePrice),
      rate,
      marketStatus: j.marketStatus,
      tradedAt: j.localTradedAt,
    };
  });
}

/**
 * 랭킹. sort: up | down | searchTop | marketValue
 * `ALL` 시장은 지원되지 않아 코스피/코스닥을 각각 받아 합친다.
 * pageSize는 100이 상한이고 넘기면 에러 페이지가 오므로 100씩 나눠 받는다.
 */
const PAGE_MAX = 100;

export function fetchRanking(sort, size = 30) {
  return cached(`rank:${sort}:${size}`, TTL.quote, async () => {
    const pageCount = Math.ceil(size / PAGE_MAX);
    const pageSize = Math.min(size, PAGE_MAX);

    const jobs = [];
    for (const market of ['KOSPI', 'KOSDAQ']) {
      for (let page = 1; page <= pageCount; page++) jobs.push({ market, page });
    }

    const fetched = await pool(jobs, 4, async ({ market, page }) => {
      const j = await getJSON(
        `https://m.stock.naver.com/api/stocks/${sort}/${market}?page=${page}&pageSize=${pageSize}`
      );
      return (j.stocks ?? []).map(normStock);
    });

    // 시장별로 페이지 순서를 유지한 채 모은다.
    // ETF·ETN은 제외한다. 지수가 크게 움직인 날엔 인버스/레버리지 상품이
    // 급등·급락 랭킹을 통째로 차지해서 "무슨 종목이 튀었나"를 가려버린다.
    const byMarket = { KOSPI: [], KOSDAQ: [] };
    jobs.forEach(({ market }, i) => {
      if (fetched[i]) byMarket[market].push(...fetched[i].filter((s) => !isFund(s.name)));
    });

    // searchTop은 순위 자체가 의미이므로 두 시장을 번갈아 섞는다(코스피 편중 방지).
    if (sort === 'searchTop') {
      const out = [];
      const { KOSPI: ks, KOSDAQ: kq } = byMarket;
      for (let i = 0; i < Math.max(ks.length, kq.length); i++) {
        if (ks[i]) out.push(ks[i]);
        if (kq[i]) out.push(kq[i]);
      }
      return out.slice(0, size);
    }

    const merged = [...byMarket.KOSPI, ...byMarket.KOSDAQ];
    if (sort === 'up') merged.sort((a, b) => b.rate - a.rate);
    else if (sort === 'down') merged.sort((a, b) => a.rate - b.rate);
    else if (sort === 'marketValue') merged.sort((a, b) => b.marketValue - a.marketValue);
    return merged.slice(0, size * 2); // 두 시장 합산이므로 여유를 둔다
  });
}

/** 종목 기본 시세 */
export function fetchBasic(code) {
  return cached(`basic:${code}`, TTL.quote, async () => {
    const j = await getJSON(`https://m.stock.naver.com/api/stock/${code}/basic`);
    return { ...normStock(j), marketStatus: j.marketStatus, tradedAt: j.localTradedAt };
  });
}

/** 종목 상세: 시/고/저/거래량 + 동일 업종 종목 */
export function fetchIntegration(code) {
  return cached(`integ:${code}`, TTL.quote, async () => {
    const j = await getJSON(`https://m.stock.naver.com/api/stock/${code}/integration`);
    return {
      industryCode: j.industryCode ?? null,
      totals: (j.totalInfos ?? []).map((t) => ({ key: t.key, value: t.value, code: t.code })),
      industryPeers: (j.industryCompareInfo ?? [])
        .map(normStock)
        .filter((s) => s.code !== code),
    };
  });
}

/** 일봉 OHLCV. 기본 400일치를 받아 클라이언트가 구간을 잘라 쓴다. */
export function fetchDaily(code, days = 400) {
  return cached(`daily:${code}:${days}`, TTL.daily, async () => {
    const end = new Date();
    const start = new Date(Date.now() - days * 86_400_000);
    const url =
      `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}` +
      `&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`;

    const res = await fetch(url, { headers: H_FINANCE, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`${res.status} siseJson ${code}`);
    const text = await res.text();

    // 응답은 JS 리터럴 배열이라 JSON.parse가 안 된다. 행 단위로 뽑아낸다.
    const rows = [...text.matchAll(
      /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(\d+)/g
    )];
    return rows.map((m) => ({
      d: m[1],
      o: +m[2],
      h: +m[3],
      l: +m[4],
      c: +m[5],
      v: +m[6],
    }));
  });
}

/** 종목 검색 자동완성 */
export function search(query) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return cached(`search:${q}`, TTL.search, async () => {
    const j = await getJSON(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock&country=KOR`,
      { 'User-Agent': UA, Referer: 'https://m.stock.naver.com/' }
    );
    return (j.items ?? [])
      .filter((it) => it.category === 'stock' && it.nationCode === 'KOR')
      .slice(0, 12)
      .map((it) => ({ code: it.code, name: it.name, market: it.typeName }));
  });
}
