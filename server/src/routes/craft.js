// #24 GET /stocks  #25 GET /craft/mine  #26 POST /craft/stocks  #27 POST /craft/scenarios
// #28 DELETE /craft/stocks/:id  #29 DELETE /craft/scenarios/:id
//  - 제작(만들기)은 환생 1회 이상. 창작물은 만든 사람의 판에서만 쓰이고, 쓴 판은 랭킹 제외(v_ranking)
//  - 다른 데이터가 참조 중인 창작물 삭제는 FK 위반 → errorHandler 가 IN_USE 로 변환
const express = require('express');
const { pool } = require('../db');
const { ApiError } = require('../lib/errors');
const { ok, asyncHandler } = require('../lib/http');
const { int, str, decimal, oneOf } = require('../lib/validate');
const { requireAuth } = require('../middleware/auth');
const { getRebirthCount } = require('../services/gameService');

const router = express.Router();

const STOCK_COLUMNS = 'stock_id, name, sector, base_price, volatility, created_by';
const SCENARIO_COLUMNS = 'scenario_id, day_no, title, description, difficulty, sector, stock_id, impact_pct';
const toStock = ({ created_by, ...s }) => ({ ...s, is_custom: created_by !== null });

// 기본 종목 + 내 창작 종목 (시나리오 영향 대상·상점 대상 선택용)
async function visibleStocks(userId) {
  const [rows] = await pool.query(
    `SELECT ${STOCK_COLUMNS} FROM stocks WHERE created_by IS NULL OR created_by = ? ORDER BY stock_id`,
    [userId]
  );
  return rows;
}

async function requireCraftUnlocked(userId) {
  const rebirth = await getRebirthCount(pool, userId);
  if (rebirth < 1) throw new ApiError('FORBIDDEN', '환생 1회 이상부터 제작할 수 있습니다', { rebirth_count: rebirth });
}

// 내 창작물만 삭제 가능
async function deleteMine(table, idColumn, id, userId, label) {
  const [[row]] = await pool.query(`SELECT created_by FROM ${table} WHERE ${idColumn} = ?`, [id]);
  if (!row) throw new ApiError('NOT_FOUND', `${label}을(를) 찾을 수 없습니다`);
  if (row.created_by !== userId) throw new ApiError('FORBIDDEN', `내가 만든 ${label}만 삭제할 수 있습니다`);
  await pool.query(`DELETE FROM ${table} WHERE ${idColumn} = ?`, [id]);
}

// #24 종목 마스터
router.get(
  '/stocks',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, { stocks: (await visibleStocks(req.user.userId)).map(toStock) });
  })
);

// #25 내 창작물
router.get(
  '/craft/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const [stocks] = await pool.query(`SELECT ${STOCK_COLUMNS} FROM stocks WHERE created_by = ? ORDER BY stock_id`, [userId]);
    const [scenarios] = await pool.query(
      `SELECT ${SCENARIO_COLUMNS} FROM scenarios WHERE created_by = ? ORDER BY day_no, scenario_id`,
      [userId]
    );
    ok(res, { craft_unlocked: (await getRebirthCount(pool, userId)) >= 1, stocks: stocks.map(toStock), scenarios });
  })
);

// #26 종목 만들기 (stocks: name VARCHAR(30) UNIQUE, sector VARCHAR(20), base_price 1,000~500,000)
router.post(
  '/craft/stocks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const body = req.body || {};
    const name = str(body.name, '종목명', { min: 1, max: 30 });
    const sector = str(body.sector, '업종', { min: 1, max: 20 });
    const basePrice = int(body.base_price, '시작가', { min: 1000, max: 500000 });
    const volatility = oneOf(body.volatility, '변동성', ['LOW', 'MID', 'HIGH']);
    await requireCraftUnlocked(userId);

    const [r] = await pool.query('INSERT INTO stocks (name, sector, base_price, volatility, created_by) VALUES (?, ?, ?, ?, ?)', [
      name,
      sector,
      basePrice,
      volatility,
      userId,
    ]);
    ok(res, { stock_id: r.insertId, name, sector, base_price: basePrice, volatility, is_custom: true }, 201);
  })
);

// #27 시나리오 만들기 (영향 대상: sector만 = 업종 / stock_id만 = 종목 / 둘 다 없음 = 시장 전체, 영향률 ±30%)
router.post(
  '/craft/scenarios',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const body = req.body || {};
    const dayNo = int(body.day_no, '일차', { min: 1, max: 7 });
    const title = str(body.title, '제목', { min: 1, max: 50 });
    const description = str(body.description, '설명', { min: 1, max: 300 });
    const difficulty = int(body.difficulty, '난이도', { min: 1, max: 3 });
    const impactPct = decimal(body.impact_pct, '영향률', { min: -30, max: 30 });
    const sector = body.sector == null ? null : str(body.sector, '업종', { min: 1, max: 20 });
    const stockId = body.stock_id == null ? null : int(body.stock_id, 'stock_id');
    if (sector !== null && stockId !== null) throw new ApiError('VALIDATION_ERROR', '영향 대상은 업종과 종목 중 하나만 고를 수 있습니다');
    await requireCraftUnlocked(userId);

    // 영향 대상은 내가 거래할 수 있는 종목(기본 + 내 창작) 안에서만
    const stocks = await visibleStocks(userId);
    if (stockId !== null && !stocks.some((s) => s.stock_id === stockId)) throw new ApiError('VALIDATION_ERROR', '영향 대상 종목이 없습니다');
    if (sector !== null && !stocks.some((s) => s.sector === sector)) throw new ApiError('VALIDATION_ERROR', '영향 대상 업종이 없습니다');

    const [r] = await pool.query(
      `INSERT INTO scenarios (day_no, title, description, difficulty, sector, stock_id, impact_pct, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [dayNo, title, description, difficulty, sector, stockId, impactPct, userId]
    );
    ok(
      res,
      { scenario_id: r.insertId, day_no: dayNo, title, description, difficulty, sector, stock_id: stockId, impact_pct: impactPct },
      201
    );
  })
);

// #28 창작 종목 삭제 (거래 기록·시나리오가 참조 중이면 IN_USE)
router.delete(
  '/craft/stocks/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = int(req.params.id, 'id');
    await deleteMine('stocks', 'stock_id', id, req.user.userId, '종목');
    ok(res, { stock_id: id, deleted: true });
  })
);

// #29 창작 시나리오 삭제 (어떤 판에서 이미 선택했으면 IN_USE)
router.delete(
  '/craft/scenarios/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = int(req.params.id, 'id');
    await deleteMine('scenarios', 'scenario_id', id, req.user.userId, '시나리오');
    ok(res, { scenario_id: id, deleted: true });
  })
);

module.exports = router;
