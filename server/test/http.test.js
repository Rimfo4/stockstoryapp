const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiError } = require('../src/lib/errors');
const { int, str, oneOf, decimal } = require('../src/lib/validate');
const { errorHandler } = require('../src/middleware/errorHandler');

function run(err) {
  let out = {};
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  const silent = console.error; console.error = () => {};
  try { errorHandler(err, {}, res, () => {}); } finally { console.error = silent; }
  return out;
}

test('에러 코드 10종은 명세의 HTTP 상태로 변환된다', () => {
  const table = { VALIDATION_ERROR: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, DUPLICATE: 409,
    WRONG_PHASE: 409, MARKET_CLOSED: 409, NOT_ENOUGH_CASH: 409, NOT_ENOUGH_QUANTITY: 409, IN_USE: 409 };
  for (const [code, status] of Object.entries(table)) {
    const out = run(new ApiError(code, 'm'));
    assert.equal(out.status, status);
    assert.deepEqual(out.body, { ok: false, error: { code, message: 'm' } });
  }
});

test('details 가 있으면 error 에 함께 실린다', () => {
  const out = run(new ApiError('NOT_ENOUGH_CASH', 'm', { cash: 1 }));
  assert.deepEqual(out.body.error.details, { cash: 1 });
});

test('MySQL 제약 위반 → 공통 코드', () => {
  assert.equal(run({ code: 'ER_DUP_ENTRY' }).body.error.code, 'DUPLICATE');
  assert.equal(run({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' }).body.error.code, 'VALIDATION_ERROR');
  assert.equal(run({ code: 'ER_ROW_IS_REFERENCED_2' }).body.error.code, 'IN_USE');
});

test('알 수 없는 에러는 500 INTERNAL_ERROR 이고 내부 메시지를 노출하지 않는다', () => {
  const out = run(new Error('secret db detail'));
  assert.equal(out.status, 500);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(out.body).includes('secret'));
});

test('JSON 파싱 실패 → 400 VALIDATION_ERROR', () => {
  const out = run({ type: 'entity.parse.failed' });
  assert.equal(out.status, 400);
});

test('validate.int: 숫자 문자열 허용, 소수/범위 밖 거부', () => {
  assert.equal(int('5', 'x'), 5);
  assert.throws(() => int(1.5, 'x'), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => int(0, 'x'), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => int(8, 'x', { min: 1, max: 7 }), (e) => e.code === 'VALIDATION_ERROR');
});

test('validate.str: 길이는 문자 수 기준(60자 이유), 공백만이면 거부', () => {
  assert.equal(str('가'.repeat(60), 'r', { min: 1, max: 60 }).length, 60);
  assert.throws(() => str('가'.repeat(61), 'r', { min: 1, max: 60 }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => str('   ', 'r', { min: 1, max: 60 }), (e) => e.code === 'VALIDATION_ERROR');
});

test('validate.oneOf', () => {
  assert.equal(oneOf('BUY', 's', ['BUY', 'SELL']), 'BUY');
  assert.throws(() => oneOf('HOLD', 's', ['BUY', 'SELL']), (e) => e.code === 'VALIDATION_ERROR');
});

test('validate.decimal: DECIMAL(5,2) 영향률 — 소수 2자리까지, 범위 ±30', () => {
  const f = (v) => decimal(v, '영향률', { min: -30, max: 30 });
  assert.equal(f(1.5), 1.5);
  assert.equal(f(-30), -30);
  assert.equal(f('2.25'), 2.25);
  for (const bad of [30.01, -31, 1.234, '1.2.3', '', null, NaN, Infinity, '1e1']) {
    assert.throws(() => f(bad), (e) => e.code === 'VALIDATION_ERROR', String(bad));
  }
});
