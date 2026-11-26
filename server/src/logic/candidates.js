// 시나리오 후보 추첨: 그 일차의 후보 풀을 hash(session_id, day_no, scenario_id) 순으로 정렬해 앞 3개.
// 시드가 고정이라 새로고침해도 같은 3개가 나온다.
const crypto = require('crypto');

function hashOf(sessionId, dayNo, scenarioId) {
  return crypto.createHash('sha256').update(`${sessionId}:${dayNo}:${scenarioId}`).digest('hex');
}

function pickCandidates(pool, sessionId, dayNo, count = 3) {
  if (pool.length < count) {
    throw new Error(`시나리오 후보 풀이 ${count}개 미만입니다 (day ${dayNo}: ${pool.length}개)`);
  }
  return pool
    .map((s) => ({ s, h: hashOf(sessionId, dayNo, s.scenario_id) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.s.scenario_id - b.s.scenario_id))
    .slice(0, count)
    .map((x) => x.s);
}

module.exports = { pickCandidates };
