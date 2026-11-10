// 런타임 공통 유틸. Workers에서는 Intl 호출도 CPU를 먹으므로(무료 플랜 호출당 10ms)
// 한국 시간 계산은 고정 오프셋 산술로 한다. 한국은 서머타임이 없다.

const KST = 9 * 3_600_000;
const DAY = 86_400_000;

/** 한국 시간 기준으로 쪼갠 날짜. dow: 0=일 … 6=토 */
export function kst(ms = Date.now()) {
  const d = new Date(ms + KST);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    dow: d.getUTCDay(),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const pad = (n) => String(n).padStart(2, '0');
export const ymdOf = (p) => `${p.y}${pad(p.m)}${pad(p.d)}`;
export const todayYmd = (ms = Date.now()) => ymdOf(kst(ms));

const isWeekday = (dow) => dow >= 1 && dow <= 5;
export const SESSION_OPEN = 8 * 60 + 30; // 08:30 동시호가
export const SESSION_CLOSE = 15 * 60 + 45; // 15:45 (종가 확정 + 여유)

/** 장이 열려 있을 만한 시간인가 (평일 08:30~15:45 KST). 공휴일은 모른다 — 네이버 상태로 보완. */
export function inSession(ms = Date.now()) {
  const p = kst(ms);
  return isWeekday(p.dow) && p.min >= SESSION_OPEN && p.min <= SESSION_CLOSE;
}

/**
 * 종가가 확정된 가장 최근 거래일(YYYYMMDD). 평일 15:45 이후면 오늘, 아니면 직전 평일.
 * 공휴일도 거래일로 친다 — 그날 다시 받아도 값이 같을 뿐 틀리지는 않는다.
 */
export function lastClosedDay(ms = Date.now()) {
  let p = kst(ms);
  if (isWeekday(p.dow) && p.min >= SESSION_CLOSE) return ymdOf(p);
  let t = ms;
  do {
    t -= DAY;
    p = kst(t);
  } while (!isWeekday(p.dow));
  return ymdOf(p);
}

/**
 * 지금 가격이 속한 거래일 추정: 평일 09:00 이후면 오늘, 아니면 마지막 마감일.
 * 공휴일엔 틀릴 수 있으니 지수의 시세 시각(tradedAt)이 있으면 그쪽을 먼저 쓴다.
 * (여러 종목 일괄 조회의 localTradedAt은 체결 시각이 아니라 요청 시각이라 쓰면 안 된다.)
 */
export function sessionDayGuess(ms = Date.now()) {
  const p = kst(ms);
  return isWeekday(p.dow) && p.min >= 9 * 60 ? ymdOf(p) : lastClosedDay(ms);
}

/**
 * 스냅숏의 장 상태가 지금과 어긋났나. 아침에 어제 마감 화면을, 장 마감 뒤에 장중 화면을
 * 그대로 내보내지 않으려고 쓴다. 정규장(09:00~15:20)에만 "열려 있어야 한다"고 본다.
 */
export function phaseMismatch(snapshot, ms = Date.now()) {
  const status = snapshot?.indices?.[0]?.marketStatus;
  if (!status) return true;
  const p = kst(ms);
  const shouldBeOpen = isWeekday(p.dow) && p.min >= 9 * 60 && p.min <= 15 * 60 + 20;
  if (shouldBeOpen) return status !== 'OPEN';
  return status === 'OPEN' && !inSession(ms);
}

/** YYYYMMDD 문자열에서 n일 전 (달력 기준) */
export function daysBefore(ymd, n) {
  const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) - n * DAY;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** ISO 시각(+09:00 포함)을 한국 날짜 YYYYMMDD로 */
export const ymdOfIso = (iso) => (iso ? todayYmd(Date.parse(iso)) : null);

// ── 외부 호출 예산 ────────────────────────────────────────────────────
// 무료 플랜은 호출(invocation)당 외부 요청 50개가 상한이고, 넘으면 예외로 죽는다.
// 리다이렉트도 1개로 세지만 naver.js가 리다이렉트를 따라가지 않으므로 fetch 1번 = 1개다.
// 그래도 5개는 남겨 두고 45개로 관리한다.
//
// 시한(deadline)도 같이 잡는다. 응답 뒤 작업(waitUntil)은 30초가 지나면 통째로 취소되고,
// 결과를 맨 끝에 저장하는 구조라 넘기면 전부 날아간다. 시한이 지나면 새 요청을 시작하지 않고
// 그때까지 받은 것만 저장한다.
export const BUDGET = 45;

export class BudgetExceeded extends Error {
  constructor(reason = '외부 요청 예산 초과') {
    super(reason);
  }
}

export class Budget {
  constructor(n = BUDGET, { deadlineMs = 20_000 } = {}) {
    this.left = n;
    this.used = 0;
    // Workers의 Date.now()는 I/O 때만 움직이지만 시한 판정에는 그걸로 충분하다.
    this.deadline = Date.now() + deadlineMs;
  }
  get expired() {
    return Date.now() > this.deadline;
  }
  take() {
    if (this.left <= 0) throw new BudgetExceeded();
    if (this.expired) throw new BudgetExceeded('시한 초과');
    this.left--;
    this.used++;
  }
}

/**
 * 동시성 제한 병렬 실행. 실패한 항목은 null.
 * 예산이 바닥나면 남은 항목을 건너뛴다(예외로 호출 전체를 죽이지 않는다).
 * 런타임도 응답 헤더를 기다리는 연결을 6개로 묶으므로 그 이상은 의미가 없다.
 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          out[i] = await fn(items[i], i);
        } catch (err) {
          if (err instanceof BudgetExceeded) cursor = items.length;
          out[i] = null;
        }
      }
    })
  );
  return out;
}

export function json(body, { status = 200, cache = 'no-store' } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
  });
}
