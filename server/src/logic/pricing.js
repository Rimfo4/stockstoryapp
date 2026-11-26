// 가격 함수: 같은 입력(판 번호, 일차, 종목, 시나리오, 아이템 구매 기록)이면 항상 같은 가격.
// DB에 저장하지 않고 요청 때마다 계산한다. (순수 함수 - DB 접근 없음)
const crypto = require('crypto');

const { CLOSE_TICK } = require('./clock'); // 09:00(0) ~ 15:30(78), 5분 단위 79칸
const AMPLITUDE = { LOW: 0.02, MID: 0.04, HIGH: 0.06 }; // 일중 최대 편차 (확정)
const MIN_PRICE = 10;

function round10(n) {
  return Math.round(n / 10) * 10;
}

// 문자열 조합 → 32비트 정수 시드
function seedOf(...parts) {
  const h = crypto.createHash('sha256').update(parts.join(':')).digest();
  return h.readUInt32BE(0);
}

// 시드 고정 난수 (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 시드 고정 랜덤워크. 시작(0틱)은 0, 하루 중 최대 편차가 변동성 폭(amp)과 같도록 비례 조정.
// 반환: 길이 79 배열 (비율, 예: 0.013 = +1.3%)
function noisePath(seed, volatility) {
  const amp = AMPLITUDE[volatility];
  if (amp === undefined) throw new Error(`unknown volatility: ${volatility}`);
  const rng = mulberry32(seed);
  const walk = new Array(CLOSE_TICK + 1).fill(0);
  for (let t = 1; t <= CLOSE_TICK; t++) walk[t] = walk[t - 1] + (rng() * 2 - 1);
  const maxAbs = Math.max(...walk.map(Math.abs));
  if (maxAbs === 0) return walk;
  const scale = amp / maxAbs;
  return walk.map((w) => w * scale);
}

// 시나리오 영향 대상: stock_id 지정 → 그 종목 / sector 지정 → 그 업종 / 둘 다 NULL → 시장 전체
function scenarioApplies(scenario, stock) {
  if (scenario.stock_id !== null && scenario.stock_id !== undefined) {
    return Number(scenario.stock_id) === Number(stock.stock_id);
  }
  if (scenario.sector !== null && scenario.sector !== undefined) {
    return scenario.sector === stock.sector;
  }
  return true;
}

// 하루치 가격 경로 (79칸)
//   price(t) = round10(시가 × (1 + noise(t) + 시나리오영향% × t/78 + 아이템영향%(구매 tick 이후)))
function dayPrices({ open, noise, scenarioPct, items }) {
  const path = new Array(CLOSE_TICK + 1);
  for (let t = 0; t <= CLOSE_TICK; t++) {
    let itemPct = 0;
    for (const it of items) if (it.tick <= t) itemPct += it.pct;
    const mult = 1 + noise[t] + (scenarioPct / 100) * (t / CLOSE_TICK) + itemPct / 100;
    path[t] = Math.max(MIN_PRICE, round10(open * mult));
  }
  return path;
}

// 특정 종목의 dayNo일차 가격 경로.
//   1일차 시가 = base_price, 이후 시가 = 전날 종가 (전날 시나리오·아이템의 추가 영향 없음)
//   days   : session_days + scenarios 조인 행 [{day_no, sector, stock_id, impact_pct}]
//   itemTx : ITEM 거래 + items.effect_pct [{game_day, stock_id, game_tick, effect_pct}]
function pricePath({ sessionId, dayNo, stock, days, itemTx }) {
  let open = Number(stock.base_price);
  for (let d = 1; d <= dayNo; d++) {
    const row = days.find((x) => Number(x.day_no) === d);
    const scenarioPct = row && scenarioApplies(row, stock) ? Number(row.impact_pct) : 0;
    const items = itemTx
      .filter((x) => Number(x.game_day) === d && Number(x.stock_id) === Number(stock.stock_id))
      .map((x) => ({ tick: Number(x.game_tick), pct: Number(x.effect_pct) }));
    const noise = noisePath(seedOf(sessionId, d, stock.stock_id), stock.volatility);
    const path = dayPrices({ open, noise, scenarioPct, items });
    if (d === dayNo) return path;
    open = path[CLOSE_TICK];
  }
  throw new Error('dayNo must be >= 1');
}

module.exports = { round10, seedOf, noisePath, scenarioApplies, dayPrices, pricePath };
