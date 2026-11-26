const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/logic/pricing');

const stock = { stock_id: 1, sector: '에너지', base_price: 8700, volatility: 'MID', created_by: null };

test('round10: 10원 단위 반올림', () => {
  assert.equal(P.round10(8704), 8700);
  assert.equal(P.round10(8705), 8710);
});

test('noisePath: 79칸, 시작 0, 같은 시드면 항상 같은 경로', () => {
  const a = P.noisePath(P.seedOf(1, 1, 1), 'MID');
  const b = P.noisePath(P.seedOf(1, 1, 1), 'MID');
  assert.equal(a.length, 79);
  assert.equal(a[0], 0);
  assert.deepEqual(a, b);
});

test('noisePath: 시드가 다르면 경로가 다르다', () => {
  const a = P.noisePath(P.seedOf(1, 1, 1), 'MID');
  const b = P.noisePath(P.seedOf(1, 2, 1), 'MID');
  assert.notDeepEqual(a, b);
});

test('noisePath: 일중 최대 편차는 LOW 2% / MID 4% / HIGH 6%', () => {
  for (const [vol, amp] of [['LOW', 0.02], ['MID', 0.04], ['HIGH', 0.06]]) {
    for (let s = 1; s <= 20; s++) {
      const max = Math.max(...P.noisePath(P.seedOf(s, 3, 9), vol).map(Math.abs));
      assert.ok(max <= amp + 1e-12, `${vol} seed ${s}: ${max}`);
      assert.ok(max >= amp - 1e-12, `${vol} seed ${s} 최대 편차가 amp와 같아야 함: ${max}`);
    }
  }
});

test('scenarioApplies: 시장 전체 / 업종 / 종목', () => {
  assert.equal(P.scenarioApplies({ sector: null, stock_id: null }, stock), true);
  assert.equal(P.scenarioApplies({ sector: '에너지', stock_id: null }, stock), true);
  assert.equal(P.scenarioApplies({ sector: 'IT', stock_id: null }, stock), false);
  assert.equal(P.scenarioApplies({ sector: null, stock_id: 1 }, stock), true);
  assert.equal(P.scenarioApplies({ sector: null, stock_id: 2 }, stock), false);
});

test('dayPrices: 노이즈 0이면 시나리오 영향이 0%→100%로 선형 반영, 종가=시가×(1+impact)', () => {
  const noise = new Array(79).fill(0);
  const path = P.dayPrices({ open: 10000, noise, scenarioPct: 4, items: [] });
  assert.equal(path.length, 79);
  assert.equal(path[0], 10000);
  assert.equal(path[78], 10400);
  assert.equal(path[39], 10200);
});

test('dayPrices: 아이템 효과는 구매 tick부터 적용', () => {
  const noise = new Array(79).fill(0);
  const path = P.dayPrices({ open: 10000, noise, scenarioPct: 0, items: [{ tick: 10, pct: 2 }] });
  assert.equal(path[9], 10000);
  assert.equal(path[10], 10200);
  assert.equal(path[78], 10200);
});

test('dayPrices: 가격은 항상 10원 단위 이상 정수', () => {
  const noise = new Array(79).fill(0);
  const path = P.dayPrices({ open: 1000, noise, scenarioPct: -30, items: [{ tick: 0, pct: -400 }] });
  for (const p of path) { assert.ok(Number.isInteger(p) && p >= 10 && p % 10 === 0); }
});

const day1 = { day_no: 1, sector: '에너지', stock_id: null, impact_pct: 4 };
const day2 = { day_no: 2, sector: null, stock_id: null, impact_pct: -2 };

test('pricePath: 1일차 시가는 base_price', () => {
  const path = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1], itemTx: [] });
  assert.equal(path[0], stock.base_price);
});

test('pricePath: 다음 날 시가 = 전날 종가 (전날 영향은 이월되지 않음)', () => {
  const d1 = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1, day2], itemTx: [] });
  const d2 = P.pricePath({ sessionId: 1, dayNo: 2, stock, days: [day1, day2], itemTx: [] });
  assert.equal(d2[0], d1[78]);
});

test('pricePath: 결정적 (같은 입력 → 같은 출력)', () => {
  const args = { sessionId: 7, dayNo: 2, stock, days: [day1, day2], itemTx: [] };
  assert.deepEqual(P.pricePath(args), P.pricePath(args));
});

test('pricePath: 다른 종목/다른 판은 다른 노이즈', () => {
  const other = { ...stock, stock_id: 2 };
  const a = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1], itemTx: [] });
  const b = P.pricePath({ sessionId: 1, dayNo: 1, stock: other, days: [day1], itemTx: [] });
  assert.notDeepEqual(a, b);
});

test('pricePath: 아이템은 같은 날 같은 종목 것만 반영', () => {
  const base = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1], itemTx: [] });
  const withItem = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1],
    itemTx: [{ game_day: 1, stock_id: 1, game_tick: 5, effect_pct: 7 }] });
  const otherStock = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1],
    itemTx: [{ game_day: 1, stock_id: 2, game_tick: 5, effect_pct: 7 }] });
  const otherDay = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1],
    itemTx: [{ game_day: 2, stock_id: 1, game_tick: 5, effect_pct: 7 }] });
  assert.ok(withItem[78] > base[78]);
  assert.deepEqual(otherStock, base);
  assert.deepEqual(otherDay, base);
});

test('pricePath: 전날 아이템은 다음 날 시가(종가)를 통해서만 반영되고 추가 영향은 없다', () => {
  const items = [{ game_day: 1, stock_id: 1, game_tick: 0, effect_pct: 7 }];
  const d1 = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [day1, day2], itemTx: items });
  const d2 = P.pricePath({ sessionId: 1, dayNo: 2, stock, days: [day1, day2], itemTx: items });
  assert.equal(d2[0], d1[78]);
});

test('pricePath: 시나리오 선택 전 일차는 영향 없이 노이즈만 (scenario 없는 일차)', () => {
  const path = P.pricePath({ sessionId: 1, dayNo: 1, stock, days: [], itemTx: [] });
  assert.equal(path.length, 79);
  assert.equal(path[0], stock.base_price);
});
