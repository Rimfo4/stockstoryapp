// #21 GET /shop/items  (구매는 #22 POST /sessions/:id/items/purchase — trading.js)
const express = require('express');
const { pool } = require('../db');
const { ok, asyncHandler } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { getRebirthCount } = require('../services/gameService');

const router = express.Router();
router.use(requireAuth);

// 상점 목록: required_rebirth 0 = 일반, N = 환생 N회 이상 해금
router.get(
  '/items',
  asyncHandler(async (req, res) => {
    const rebirth = await getRebirthCount(pool, req.user.userId);
    const [rows] = await pool.query(
      'SELECT item_id, name, description, effect_pct, price, required_rebirth FROM items ORDER BY required_rebirth, price, item_id'
    );
    ok(res, {
      rebirth_count: rebirth,
      items: rows.map((i) => ({ ...i, locked: rebirth < i.required_rebirth })),
    });
  })
);

module.exports = router;
