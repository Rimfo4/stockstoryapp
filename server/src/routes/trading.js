// #14 market  #15 stocks/:stockId  #16 orders  #17 portfolio  #18 transactions
// #19 days/:dayNo/summary  #20 result  #22 items/purchase
const express = require('express');
const { ApiError, DeferredError } = require('../lib/errors');
const { int, str, oneOf } = require('../lib/validate');
const { requireAuth } = require('../middleware/auth');
const { tickToTime, CLOSE_TICK } = require('../logic/clock');
const {
  pct,
  sessionRoute,
  buildPriceBook,
  computeAssets,
  getCash,
  getHoldings,
  getStartFund,
  getRebirthCount,
} = require('../services/gameService');

const router = express.Router();
router.use(requireAuth);

function assertNotAbandoned(ctx) {
  if (ctx.phase === 'ABANDONED') throw new ApiError('WRONG_PHASE', '포기한 게임입니다');
}

// 주문·아이템 구매 공통: 장중(PLAYING)에만 가능
//   이 요청에서 15:30 자동 마감이 처리됐다면 DeferredError 를 돌려준다(마감 정산은 커밋하고 요청은 거부)
function checkMarketOpen(ctx) {
  if (ctx.autoClosed) return new DeferredError(new ApiError('MARKET_CLOSED', '장이 마감되었습니다 (15:30 자동 마감 처리됨)'));
  if (ctx.phase === 'SELECT_SCENARIO' || ctx.phase === 'FINISHED') throw new ApiError('MARKET_CLOSED', '지금은 장이 열려 있지 않습니다');
  if (ctx.phase !== 'PLAYING') throw new ApiError('WRONG_PHASE', '일시정지 중에는 거래할 수 없습니다');
  return null;
}

const stockInfo = (s) => ({
  stock_id: s.stock_id,
  name: s.name,
  sector: s.sector,
  volatility: s.volatility,
  is_custom: s.created_by !== null,
});

const clockInfo = (ctx) => ({ day_no: ctx.dayNo, tick: ctx.tick, time: tickToTime(ctx.tick) });

// #14 종목 현재가·등락률 (등락률 = 그날 시가 대비)
router.get(
  '/:id/market',
  sessionRoute(async (conn, ctx) => {
    assertNotAbandoned(ctx);
    const book = await buildPriceBook(conn, ctx);
    return {
      phase: ctx.phase,
      ...clockInfo(ctx),
      stocks: book.stocks.map((s) => {
        const path = book.path(s.stock_id);
        const price = path[ctx.tick];
        return {
          ...stockInfo(s),
          price,
          open_price: path[0],
          change: price - path[0],
          change_rate: pct(price - path[0], path[0]),
        };
      }),
    };
  })
);

// #15 종목 상세 + 5분봉 (현재 tick까지만 노출 — 미래 가격은 보내지 않는다)
router.get(
  '/:id/stocks/:stockId',
  sessionRoute(async (conn, ctx, req) => {
    assertNotAbandoned(ctx);
    const stockId = int(req.params.stockId, 'stockId');
    const book = await buildPriceBook(conn, ctx);
    const stock = book.stock(stockId);
    const prices = book.path(stockId).slice(0, ctx.tick + 1);
    const price = prices[ctx.tick];
    const held = (await getHoldings(conn, ctx.session.session_id)).find((h) => h.stock_id === stockId);
    return {
      stock: stockInfo(stock),
      ...clockInfo(ctx),
      price,
      open_price: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      change_rate: pct(price - prices[0], prices[0]),
      holding: held ? { quantity: held.quantity, avg_price: held.avg_price } : null,
      candles: prices.map((p, t) => ({ tick: t, time: tickToTime(t), price: p })),
    };
  })
);

// #16 시장가 매수/매도: 즉시 체결, 수수료·공매도·소수점 없음, 매매 이유 필수(60자)
router.post(
  '/:id/orders',
  sessionRoute(async (conn, ctx, req) => {
    const closed = checkMarketOpen(ctx);
    if (closed) return closed;
    const body = req.body || {};
    const side = oneOf(body.side, 'side', ['BUY', 'SELL']);
    const stockId = int(body.stock_id, 'stock_id');
    const quantity = int(body.quantity, 'quantity', { min: 1, max: 1000000 });
    const reason = str(body.reason, '매매 이유', { min: 1, max: 60 }); // transactions.reason VARCHAR(60)

    const id = ctx.session.session_id;
    const book = await buildPriceBook(conn, ctx);
    const stock = book.stock(stockId);
    const unitPrice = book.path(stockId)[ctx.tick];
    const total = unitPrice * quantity;

    // 세션 행을 FOR UPDATE 로 잠근 상태라 같은 판의 동시 주문과 직렬화된다 (v_cash / v_holdings 검증)
    if (side === 'BUY') {
      const cash = await getCash(conn, id);
      if (total > cash) throw new ApiError('NOT_ENOUGH_CASH', '현금이 부족합니다', { cash, required: total });
    } else {
      const held = (await getHoldings(conn, id)).find((h) => h.stock_id === stockId);
      const have = held ? held.quantity : 0;
      if (quantity > have) throw new ApiError('NOT_ENOUGH_QUANTITY', '보유 수량이 부족합니다', { held: have, requested: quantity });
    }

    const [r] = await conn.query(
      `INSERT INTO transactions (session_id, tx_type, stock_id, quantity, unit_price, reason, game_day, game_tick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, side, stockId, quantity, unitPrice, reason, ctx.dayNo, ctx.tick]
    );
    return {
      tx_id: r.insertId,
      side,
      stock_id: stockId,
      stock_name: stock.name,
      quantity,
      unit_price: unitPrice,
      total,
      cash: await getCash(conn, id),
      ...clockInfo(ctx),
    };
  }, 201)
);

// #22 아이템 구매: 고른 종목에 즉시 적용(구매 tick ~ 그날 15:30). 비용은 주식 거래용 현금에서 차감(v_cash)
router.post(
  '/:id/items/purchase',
  sessionRoute(async (conn, ctx, req) => {
    const closed = checkMarketOpen(ctx);
    if (closed) return closed;
    const body = req.body || {};
    const itemId = int(body.item_id, 'item_id');
    const stockId = int(body.stock_id, 'stock_id');

    const id = ctx.session.session_id;
    const [[item]] = await conn.query(
      'SELECT item_id, name, effect_pct, price, required_rebirth FROM items WHERE item_id = ?',
      [itemId]
    );
    if (!item) throw new ApiError('NOT_FOUND', '아이템을 찾을 수 없습니다');
    const rebirth = await getRebirthCount(conn, ctx.session.user_id);
    if (rebirth < item.required_rebirth) {
      throw new ApiError('FORBIDDEN', `환생 ${item.required_rebirth}회 이상부터 살 수 있습니다`, { rebirth_count: rebirth });
    }
    const stock = (await buildPriceBook(conn, ctx)).stock(stockId);
    const cash = await getCash(conn, id);
    if (item.price > cash) throw new ApiError('NOT_ENOUGH_CASH', '현금이 부족합니다', { cash, required: item.price });

    const [r] = await conn.query(
      "INSERT INTO transactions (session_id, tx_type, stock_id, item_id, quantity, game_day, game_tick) VALUES (?, 'ITEM', ?, ?, 1, ?, ?)",
      [id, stockId, itemId, ctx.dayNo, ctx.tick]
    );
    // 구매 기록이 가격 함수의 입력이므로 장부를 다시 만들어 적용 후 가격을 돌려준다
    const price = (await buildPriceBook(conn, ctx)).path(stockId)[ctx.tick];
    return {
      tx_id: r.insertId,
      item: { item_id: item.item_id, name: item.name, effect_pct: item.effect_pct, price: item.price },
      stock: { stock_id: stock.stock_id, name: stock.name, price },
      cash: await getCash(conn, id),
      ...clockInfo(ctx),
    };
  }, 201)
);

// #17 잔고
router.get(
  '/:id/portfolio',
  sessionRoute(async (conn, ctx) => {
    assertNotAbandoned(ctx);
    const startFund = await getStartFund(conn);
    const a = await computeAssets(conn, ctx);
    return {
      ...clockInfo(ctx),
      start_fund: startFund,
      cash: a.cash,
      holdings_value: a.holdingsValue,
      total_asset: a.totalAsset,
      profit: a.totalAsset - startFund,
      profit_rate: pct(a.totalAsset - startFund, startFund),
      holdings: a.holdings.map((h) => ({
        ...h,
        profit: h.eval_amount - h.quantity * h.avg_price,
        profit_rate: pct(h.current_price - h.avg_price, h.avg_price),
      })),
    };
  })
);

// #18 거래 내역 (?type=BUY|SELL|ITEM, ?day_no=1~7)
router.get(
  '/:id/transactions',
  sessionRoute(async (conn, ctx, req) => {
    const type = req.query.type === undefined ? null : oneOf(req.query.type, 'type', ['BUY', 'SELL', 'ITEM']);
    const dayNo = req.query.day_no === undefined ? null : int(req.query.day_no, 'day_no', { min: 1, max: 7 });
    const [rows] = await conn.query(
      `SELECT t.tx_id, t.tx_type, t.stock_id, s.name AS stock_name, t.item_id, i.name AS item_name, i.price AS item_price,
              t.quantity, t.unit_price, t.reason, t.game_day, t.game_tick, t.created_at
         FROM transactions t
         JOIN stocks s ON s.stock_id = t.stock_id
         LEFT JOIN items i ON i.item_id = t.item_id
        WHERE t.session_id = ? AND (? IS NULL OR t.tx_type = ?) AND (? IS NULL OR t.game_day = ?)
        ORDER BY t.tx_id DESC`,
      [ctx.session.session_id, type, type, dayNo, dayNo]
    );
    return {
      transactions: rows.map((r) => ({
        tx_id: r.tx_id,
        type: r.tx_type,
        stock_id: r.stock_id,
        stock_name: r.stock_name,
        item_id: r.item_id,
        item_name: r.item_name,
        quantity: r.quantity,
        unit_price: r.unit_price,
        // 현금 변화: 매도 +, 매수 −, 아이템 −(아이템 가격)
        amount: r.tx_type === 'SELL' ? r.quantity * r.unit_price : r.tx_type === 'BUY' ? -r.quantity * r.unit_price : -r.item_price,
        reason: r.reason,
        day_no: r.game_day,
        tick: r.game_tick,
        time: tickToTime(r.game_tick),
        created_at: r.created_at,
      })),
    };
  })
);

// #19 일 마감 요약 (마감된 일차만). 이때 고른 시나리오의 영향 대상·영향률을 공개한다.
router.get(
  '/:id/days/:dayNo/summary',
  sessionRoute(async (conn, ctx, req) => {
    assertNotAbandoned(ctx);
    const dayNo = int(req.params.dayNo, 'dayNo', { min: 1, max: 7 });
    const day = ctx.days.find((d) => d.day_no === dayNo);
    if (!day || day.end_asset === null) throw new ApiError('WRONG_PHASE', '아직 마감되지 않은 일차입니다');

    const prev = ctx.days.find((d) => d.day_no === dayNo - 1);
    const startAsset = prev ? prev.end_asset : await getStartFund(conn);
    const book = await buildPriceBook(conn, { ...ctx, dayNo }); // 그 일차 기준 가격 경로

    let target = { type: 'MARKET' };
    if (day.stock_id !== null) {
      const st = book.stocks.find((s) => s.stock_id === day.stock_id);
      target = { type: 'STOCK', stock_id: day.stock_id, name: st ? st.name : null };
    } else if (day.sector !== null) target = { type: 'SECTOR', sector: day.sector };

    const [txs] = await conn.query(
      `SELECT t.tx_id, t.tx_type, s.name AS stock_name, i.name AS item_name, t.quantity, t.unit_price, t.reason, t.game_tick
         FROM transactions t
         JOIN stocks s ON s.stock_id = t.stock_id
         LEFT JOIN items i ON i.item_id = t.item_id
        WHERE t.session_id = ? AND t.game_day = ?
        ORDER BY t.tx_id`,
      [ctx.session.session_id, dayNo]
    );
    return {
      day_no: dayNo,
      scenario: {
        scenario_id: day.scenario_id,
        title: day.title,
        description: day.description,
        difficulty: day.difficulty,
        target,
        impact_pct: day.impact_pct,
      },
      start_asset: startAsset,
      end_asset: day.end_asset,
      profit: day.end_asset - startAsset,
      profit_rate: pct(day.end_asset - startAsset, startAsset),
      trade_count: txs.filter((t) => t.tx_type !== 'ITEM').length,
      stocks: book.stocks.map((s) => {
        const path = book.path(s.stock_id);
        return {
          stock_id: s.stock_id,
          name: s.name,
          open_price: path[0],
          close_price: path[CLOSE_TICK],
          change_rate: pct(path[CLOSE_TICK] - path[0], path[0]),
        };
      }),
      transactions: txs.map((t) => ({
        tx_id: t.tx_id,
        type: t.tx_type,
        stock_name: t.stock_name,
        item_name: t.item_name,
        quantity: t.quantity,
        unit_price: t.unit_price,
        reason: t.reason,
        time: tickToTime(t.game_tick),
      })),
    };
  })
);

// #20 7일 결과 (FINISHED 판만). 환생 횟수(v_user_rebirth), 랭킹 정보(v_ranking)
router.get(
  '/:id/result',
  sessionRoute(async (conn, ctx) => {
    if (ctx.phase !== 'FINISHED') throw new ApiError('WRONG_PHASE', '7일을 완주한 게임만 결과를 볼 수 있습니다');
    const { session_id: id, user_id: userId } = ctx.session;
    const startFund = await getStartFund(conn);
    const finalAsset = ctx.days.find((d) => d.day_no === 7).end_asset;

    const [[tc]] = await conn.query(
      "SELECT COUNT(*) AS trade_count FROM transactions WHERE session_id = ? AND tx_type IN ('BUY','SELL')",
      [id]
    );
    const [[rk]] = await conn.query('SELECT ranking_no FROM v_ranking WHERE session_id = ?', [id]);
    // 창작 종목/시나리오를 쓴 판은 랭킹 제외, 사용자별 최고 기록 1개만 등록
    const [[best]] = await conn.query('SELECT ranking_no FROM v_ranking WHERE user_id = ?', [userId]);

    return {
      session_id: id,
      start_fund: startFund,
      final_asset: finalAsset,
      profit: finalAsset - startFund,
      profit_rate: pct(finalAsset - startFund, startFund),
      trade_count: Number(tc.trade_count),
      rebirth_count: await getRebirthCount(conn, userId),
      days: ctx.days.map((d) => ({ day_no: d.day_no, scenario_title: d.title, end_asset: d.end_asset })),
      ranking: {
        is_best_record: !!rk, // 이 판이 내 랭킹 등록 기록(최고 기록)인지
        ranking_no: rk ? Number(rk.ranking_no) : null,
        my_best_ranking_no: best ? Number(best.ranking_no) : null,
      },
    };
  })
);

module.exports = router;
