// #23 GET /rankings?limit=  : 전체 기간, 사용자별 최고 기록 1개, 창작물 사용 판 제외 (v_ranking)
const express = require('express');
const { pool } = require('../db');
const { ok, asyncHandler } = require('../lib/http');
const { int } = require('../lib/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const COLUMNS = 'session_id, user_id, nickname, final_asset, profit_rate, trade_count, finished_at, ranking_no';
const toRow = (r) => ({ ...r, ranking_no: Number(r.ranking_no) });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = req.query.limit === undefined ? 50 : int(req.query.limit, 'limit', { min: 1, max: 100 });
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM v_ranking ORDER BY ranking_no, finished_at LIMIT ?`, [limit]);
    const [[me]] = await pool.query(`SELECT ${COLUMNS} FROM v_ranking WHERE user_id = ?`, [req.user.userId]);
    ok(res, { rankings: rows.map(toRow), me: me ? toRow(me) : null });
  })
);

module.exports = router;
