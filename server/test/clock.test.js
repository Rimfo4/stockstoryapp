const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/logic/clock');

test('상수: 하루 78칸(09:00~15:30)', () => {
  assert.equal(C.CLOSE_TICK, 78);
});

test('tickToTime: 0=09:00, 12=10:00, 78=15:30', () => {
  assert.equal(C.tickToTime(0), '09:00');
  assert.equal(C.tickToTime(12), '10:00');
  assert.equal(C.tickToTime(78), '15:30');
});

test('currentTick: PAUSED는 저장된 tick 그대로', () => {
  assert.equal(C.currentTick({ status: 'PAUSED', gameTick: 20, elapsedSec: 999, secPerGameHour: 30 }), 20);
});

test('currentTick: PLAYING, 게임 1시간=30초 → 2.5초당 1칸', () => {
  const f = (elapsedSec) => C.currentTick({ status: 'PLAYING', gameTick: 10, elapsedSec, secPerGameHour: 30 });
  assert.equal(f(0), 10);
  assert.equal(f(2), 10);
  assert.equal(f(3), 11);
  assert.equal(f(30), 10 + 12);
});

test('currentTick: 15초 설정이면 2배 빠르다', () => {
  assert.equal(C.currentTick({ status: 'PLAYING', gameTick: 0, elapsedSec: 30, secPerGameHour: 15 }), 24);
});

test('currentTick: 78을 넘으면 78로 자른다(장 마감)', () => {
  const t = C.currentTick({ status: 'PLAYING', gameTick: 70, elapsedSec: 600, secPerGameHour: 30 });
  assert.equal(t, 78);
  assert.equal(C.isClosed(t), true);
  assert.equal(C.isClosed(77), false);
});
