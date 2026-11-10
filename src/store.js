// D1 저장소. 예전 Node 서버의 메모리 캐시(Map) 자리를 대신한다 — Workers는 요청마다
// 다른 인스턴스가 받을 수 있어서 메모리에 둔 값을 믿을 수 없다.
//
// 스키마는 코드가 직접 만든다. 마이그레이션 명령을 돌릴 곳이 없어서다: Workers Builds 빌드
// 토큰에는 D1 권한이 없고, 이 맥의 wrangler는 다른 계정에 로그인돼 있다.
// MIGRATIONS[0]은 매번 실행해도 안전한 CREATE … IF NOT EXISTS이고, 그 뒤 버전은 blob의
// 'schema_version'을 보고 한 번씩만 적용한다. 컬럼을 추가할 일이 생기면 배열 끝에
// ALTER TABLE 묶음을 붙인다(CREATE IF NOT EXISTS는 기존 테이블을 바꾸지 않으므로).

const MIGRATIONS = [
  // v1
  [
    `CREATE TABLE IF NOT EXISTS blob (
       key     TEXT PRIMARY KEY,
       value   TEXT NOT NULL,
       updated INTEGER NOT NULL
     )`,
    // closes: 오래된 것 → 최신 순 종가 배열(JSON). last: 그 마지막 종가의 날짜(YYYYMMDD).
    // ugen: 관련종목 후보군으로 받은 세대(YYYYMMDD). 스파크라인 때문에만 받은 종목은 NULL.
    `CREATE TABLE IF NOT EXISTS series (
       code    TEXT PRIMARY KEY,
       name    TEXT,
       market  TEXT,
       last    TEXT NOT NULL,
       closes  TEXT NOT NULL,
       ugen    TEXT,
       updated INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS series_ugen ON series (ugen)`,
  ],
];

let ready = false; // 인스턴스당 한 번. 실패하면 다음 요청에서 다시 시도한다.

export async function ensureSchema(db) {
  if (ready) return;
  await db.batch(MIGRATIONS[0].map((s) => db.prepare(s)));
  const have = Number((await getBlob(db, 'schema_version'))?.value ?? 1);
  for (let v = have; v < MIGRATIONS.length; v++) {
    await db.batch(MIGRATIONS[v].map((s) => db.prepare(s)));
    await putBlob(db, 'schema_version', v + 1);
  }
  ready = true;
}

/** D1이 살아 있으면 db, 아니면 null. D1이 죽어도 검색·차트는 동작해야 한다. */
export async function dbOrNull(env) {
  try {
    await ensureSchema(env.DB);
    return env.DB;
  } catch (err) {
    console.error('D1 unavailable:', err.message);
    return null;
  }
}

// ── blob: 화면 스냅숏, 후보군 진행 상태처럼 통째로 읽고 쓰는 값 ──────────
export async function getBlob(db, key) {
  const row = await db.prepare('SELECT value, updated FROM blob WHERE key = ?').bind(key).first();
  return row ? { value: JSON.parse(row.value), updated: row.updated } : null;
}

export function putBlob(db, key, value) {
  return db
    .prepare(
      `INSERT INTO blob (key, value, updated) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated`
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

/**
 * 짧은 잠금. cron과 사용자 요청, 서로 다른 인스턴스가 같은 갱신을 동시에 하지 않게 한다.
 * ttl이 지나면 자동으로 풀린다(잠근 쪽이 죽어도 영원히 막히지 않게).
 * @returns {Promise<boolean>} 잠금을 얻었으면 true
 */
export async function acquireLease(db, key, ttlMs) {
  const now = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO blob (key, value, updated) VALUES (?1, '0', ?2)
       ON CONFLICT (key) DO UPDATE SET updated = excluded.updated WHERE blob.updated < ?3`
    )
    .bind(key, now, now - ttlMs)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export function releaseLease(db, key) {
  return db.prepare('UPDATE blob SET updated = 0 WHERE key = ?').bind(key).run();
}

// ── series: 종목별 최근 종가 ─────────────────────────────────────────
const parseRow = (r) => ({ ...r, closes: JSON.parse(r.closes) });

/** 여러 종목의 저장된 종가. D1은 쿼리당 바인딩 100개가 상한이라 90개씩 끊는다. */
export async function getSeries(db, codes) {
  const out = new Map();
  for (let i = 0; i < codes.length; i += 90) {
    const part = codes.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT code, name, market, last, closes, ugen, updated FROM series
         WHERE code IN (${part.map(() => '?').join(',')})`
      )
      .bind(...part)
      .all();
    for (const r of results) out.set(r.code, parseRow(r));
  }
  return out;
}

/**
 * 종가 묶음 저장. batch 하나는 쿼리 1개로 센다(무료 플랜 호출당 쿼리 50개 상한).
 * 한 줄짜리 INSERT를 여러 개 묶는다 — 여러 줄을 한 문장에 넣으면 바인딩 100개를 넘는다.
 * ugen이 null이면 기존 값을 유지한다 — 스파크라인용으로 다시 받았다고 후보군에서 빠지면 안 된다.
 */
export async function putSeries(db, rows) {
  const ok = rows.filter((r) => r.code && r.last && Array.isArray(r.closes) && r.closes.length);
  if (!ok.length) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO series (code, name, market, last, closes, ugen, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (code) DO UPDATE SET
       name = excluded.name, market = excluded.market, last = excluded.last, closes = excluded.closes,
       ugen = COALESCE(excluded.ugen, series.ugen), updated = excluded.updated`
  );
  await db.batch(
    ok.map((r) => stmt.bind(r.code, r.name ?? null, r.market ?? null, r.last, JSON.stringify(r.closes), r.ugen ?? null, now))
  );
}

/** 상관계수 후보군: 최근 세대에 받은 종목들 */
export async function getUniverse(db, minGen) {
  const { results } = await db
    .prepare('SELECT code, name, market, last, closes FROM series WHERE ugen >= ?')
    .bind(minGen)
    .all();
  return results.map(parseRow);
}

/** 이번 세대로 실제 저장된 종목 수 (진행률 표시용) */
export async function countGen(db, gen) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM series WHERE ugen = ?').bind(gen).first();
  return r?.n ?? 0;
}

/** 오래 안 쓰인 종목 정리. 급등락 상위는 매일 바뀌어서 그냥 두면 계속 쌓인다. */
export function pruneSeries(db, olderThanMs) {
  return db.prepare('DELETE FROM series WHERE updated < ?').bind(Date.now() - olderThanMs).run();
}
