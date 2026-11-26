const test = require('node:test');
const assert = require('node:assert/strict');
const { pickCandidates } = require('../src/logic/candidates');

const pool = [1, 2, 3, 4, 5, 6].map((id) => ({ scenario_id: id, day_no: 3, title: `s${id}` }));

test('정확히 3개를 뽑는다', () => {
  assert.equal(pickCandidates(pool, 1, 3).length, 3);
});

test('같은 (판, 일차)이면 새로고침해도 같은 3개, 같은 순서', () => {
  const a = pickCandidates(pool, 42, 3).map((s) => s.scenario_id);
  const b = pickCandidates([...pool].reverse(), 42, 3).map((s) => s.scenario_id);
  assert.deepEqual(a, b);
});

test('판 번호가 다르면 다른 조합이 나올 수 있다', () => {
  const sets = new Set();
  for (let sid = 1; sid <= 30; sid++) sets.add(pickCandidates(pool, sid, 3).map((s) => s.scenario_id).join(','));
  assert.ok(sets.size > 1);
});

test('후보 풀이 정확히 3개면 전부 반환', () => {
  const ids = pickCandidates(pool.slice(0, 3), 1, 3).map((s) => s.scenario_id).sort();
  assert.deepEqual(ids, [1, 2, 3]);
});

test('후보 풀이 3개 미만이면 에러', () => {
  assert.throws(() => pickCandidates(pool.slice(0, 2), 1, 3), /3/);
});
