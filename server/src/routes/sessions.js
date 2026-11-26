// #6 POST /sessions  #7 GET /sessions/active  #8 GET /sessions/:id
// #9 pause  #10 resume  #11 abandon  #12 GET /:id/scenarios  #13 POST /:id/scenario
const express = require('express');
const { pool, withTx } = require('../db');
const { ApiError } = require('../lib/errors');
const { ok, asyncHandler } = require('../lib/http');
const { int } = require('../lib/validate');
const { requireAuth } = require('../middleware/auth');
const { pickCandidates } = require('../logic/candidates');
const { withSession, syncSession, sessionRoute, publicScenario, toStateDto, refreshState } = require('../services/gameService');

const router = express.Router();
router.use(requireAuth);

const ACTIVE_SQL = "SELECT session_id FROM game_sessions WHERE user_id = ? AND status IN ('PLAYING','PAUSED')";

// 그 일차의 후보 풀(기본 + 본인 창작)에서 시드 고정 추첨으로 정확히 3개
async function loadCandidates(conn, ctx) {
  if (ctx.phase !== 'SELECT_SCENARIO') throw new ApiError('WRONG_PHASE', '지금은 시나리오를 고를 단계가 아닙니다');
  const [rows] = await conn.query(
    `SELECT scenario_id, day_no, title, description, difficulty
       FROM scenarios
      WHERE day_no = ? AND (created_by IS NULL OR created_by = ?)`,
    [ctx.dayNo, ctx.session.user_id]
  );
  return pickCandidates(rows, ctx.session.session_id, ctx.dayNo);
}

// #6 새 게임 / 환생하기
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const body = req.body || {};
    const speed = body.sec_per_game_hour === undefined ? 30 : int(body.sec_per_game_hour, 'sec_per_game_hour', { min: 5, max: 120 });

    const sessionId = await withTx(async (conn) => {
      // 같은 사용자의 동시 생성을 직렬화
      const [u] = await conn.query('SELECT user_id FROM users WHERE user_id = ? FOR UPDATE', [userId]);
      if (u.length === 0) throw new ApiError('UNAUTHORIZED', '존재하지 않는 사용자입니다');

      const [active] = await conn.query(ACTIVE_SQL, [userId]);
      for (const row of active) {
        // 앱이 꺼져 있는 동안 장이 끝났다면 먼저 마감(7일차면 FINISHED=환생)을 처리한 뒤 판단
        const ctx = await syncSession(conn, row.session_id, userId);
        if (ctx.phase === 'FINISHED') continue;
        if (body.confirm_abandon !== true) {
          throw new ApiError('DUPLICATE', '진행 중인 게임이 있습니다', { active_session_id: row.session_id });
        }
        await conn.query("UPDATE game_sessions SET status = 'ABANDONED', last_resumed_at = NULL WHERE session_id = ?", [row.session_id]);
      }
      // 현금·보유 주식·일차는 판마다 초기화 (v_cash 기준 시작 자금, session_days 없음)
      const [r] = await conn.query("INSERT INTO game_sessions (user_id, status, sec_per_game_hour) VALUES (?, 'PAUSED', ?)", [userId, speed]);
      return r.insertId;
    });

    ok(res, await withSession(sessionId, userId, toStateDto), 201);
  })
);

// #7 진행 중인 판 (없으면 data: null)
router.get(
  '/active',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(ACTIVE_SQL, [req.user.userId]);
    ok(res, rows.length ? await withSession(rows[0].session_id, req.user.userId, toStateDto) : null);
  })
);

// #8 판 상태 (장 마감 자동 처리 포함)
router.get('/:id', sessionRoute(toStateDto));

// #9 일시정지 (이미 정지 상태면 그대로 성공 — 나가기 경고 흐름에서 중복 호출돼도 안전)
router.post(
  '/:id/pause',
  sessionRoute(async (conn, ctx) => {
    if (ctx.phase === 'FINISHED' || ctx.phase === 'ABANDONED') throw new ApiError('WRONG_PHASE', '이미 끝난 게임입니다');
    if (ctx.phase !== 'PLAYING') return toStateDto(conn, ctx);
    await conn.query("UPDATE game_sessions SET status = 'PAUSED', game_tick = ?, last_resumed_at = NULL WHERE session_id = ?", [
      ctx.tick,
      ctx.session.session_id,
    ]);
    return refreshState(conn, ctx);
  })
);

// #10 재개 (오늘 시나리오를 이미 고른 정지 상태에서만)
router.post(
  '/:id/resume',
  sessionRoute(async (conn, ctx) => {
    if (ctx.phase === 'PLAYING') return toStateDto(conn, ctx);
    if (ctx.phase !== 'PAUSED') throw new ApiError('WRONG_PHASE', '재개할 수 있는 상태가 아닙니다');
    await conn.query("UPDATE game_sessions SET status = 'PLAYING', last_resumed_at = NOW() WHERE session_id = ?", [ctx.session.session_id]);
    return refreshState(conn, ctx);
  })
);

// #11 게임 포기 (진행 중인 판만)
router.post(
  '/:id/abandon',
  sessionRoute(async (conn, ctx) => {
    if (ctx.phase === 'FINISHED' || ctx.phase === 'ABANDONED') throw new ApiError('WRONG_PHASE', '진행 중인 게임이 아닙니다');
    await conn.query("UPDATE game_sessions SET status = 'ABANDONED', last_resumed_at = NULL WHERE session_id = ?", [ctx.session.session_id]);
    return refreshState(conn, ctx);
  })
);

// #12 오늘의 후보 정확히 3개
router.get(
  '/:id/scenarios',
  sessionRoute(async (conn, ctx) => ({
    day_no: ctx.dayNo,
    candidates: (await loadCandidates(conn, ctx)).map(publicScenario),
  }))
);

// #13 시나리오 선택 → 장 시작 (선택은 변경 불가: session_days PK)
router.post(
  '/:id/scenario',
  sessionRoute(async (conn, ctx, req) => {
    const scenarioId = int((req.body || {}).scenario_id, 'scenario_id');
    const candidates = await loadCandidates(conn, ctx);
    if (!candidates.some((c) => c.scenario_id === scenarioId)) {
      throw new ApiError('VALIDATION_ERROR', '오늘의 후보 3개 중에서만 고를 수 있습니다');
    }
    const id = ctx.session.session_id;
    // 복합 FK(scenario_id, day_no)가 '그 일차의 후보'임을 DB에서도 한 번 더 보장
    await conn.query('INSERT INTO session_days (session_id, day_no, scenario_id) VALUES (?, ?, ?)', [id, ctx.dayNo, scenarioId]);
    await conn.query("UPDATE game_sessions SET status = 'PLAYING', game_tick = 0, last_resumed_at = NOW() WHERE session_id = ?", [id]);
    return refreshState(conn, ctx);
  })
);

module.exports = router;
