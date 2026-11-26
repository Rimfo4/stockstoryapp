// 게임 판 상태 계산 + 게임 시계(lazy 일 마감) + 자산/가격 장부
//  - 서버 타이머 없음: 요청이 올 때마다 경과 시간으로 tick을 계산하고, 15:30(tick 78)이 지났으면 그 자리에서 마감 처리
//  - 현재 일차 / phase 는 저장하지 않고 session_days 에서 계산 (3NF: 파생값 미저장)
const { withTx } = require('../db');
const { ApiError, DeferredError } = require('../lib/errors');
const { ok, asyncHandler } = require('../lib/http');
const { int } = require('../lib/validate');
const { currentTick, isClosed, tickToTime, CLOSE_TICK } = require('../logic/clock');
const { pricePath } = require('../logic/pricing');

// ---------- 조회 헬퍼 (모두 호출자의 트랜잭션 conn 사용) ----------

async function getStartFund(conn) {
  const [[r]] = await conn.query('SELECT MIN(base_price) * 5 AS start_fund FROM stocks WHERE created_by IS NULL');
  return Number(r.start_fund);
}

async function fetchSession(conn, sessionId, forUpdate) {
  const [rows] = await conn.query(
    `SELECT session_id, user_id, status, game_tick, sec_per_game_hour, started_at, finished_at,
            IF(last_resumed_at IS NULL, 0, TIMESTAMPDIFF(SECOND, last_resumed_at, NOW())) AS elapsed_sec
       FROM game_sessions WHERE session_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [sessionId]
  );
  return rows[0] || null;
}

// 고른 시나리오 정보까지 조인한 session_days (일차 순)
async function fetchDays(conn, sessionId) {
  const [rows] = await conn.query(
    `SELECT sd.day_no, sd.scenario_id, sd.end_asset,
            sc.title, sc.description, sc.difficulty, sc.sector, sc.stock_id, sc.impact_pct
       FROM session_days sd
       JOIN scenarios sc ON sc.scenario_id = sd.scenario_id
      WHERE sd.session_id = ?
      ORDER BY sd.day_no`,
    [sessionId]
  );
  return rows;
}

async function getCash(conn, sessionId) {
  const [[r]] = await conn.query('SELECT cash FROM v_cash WHERE session_id = ?', [sessionId]);
  return Number(r.cash);
}

async function getHoldings(conn, sessionId) {
  const [rows] = await conn.query(
    'SELECT stock_id, name, sector, quantity, avg_price FROM v_holdings WHERE session_id = ? ORDER BY stock_id',
    [sessionId]
  );
  return rows.map((h) => ({ ...h, quantity: Number(h.quantity), avg_price: Number(h.avg_price) }));
}

// ---------- 상태 계산 ----------

// session 행 + session_days 로 일차 / phase / tick 계산
function buildCtx(session, days) {
  const last = days[days.length - 1] || null;
  const openDay = last && last.end_asset === null ? last : null;
  const dayNo = !last ? 1 : openDay || last.day_no === 7 ? last.day_no : last.day_no + 1;

  let phase;
  if (session.status === 'ABANDONED' || session.status === 'FINISHED') phase = session.status;
  else if (!openDay) phase = 'SELECT_SCENARIO';
  else phase = session.status; // PLAYING / PAUSED

  let tick = session.game_tick;
  if (phase === 'PLAYING') {
    tick = currentTick({
      status: 'PLAYING',
      gameTick: session.game_tick,
      elapsedSec: Number(session.elapsed_sec),
      secPerGameHour: session.sec_per_game_hour,
    });
  } else if (phase === 'SELECT_SCENARIO') tick = 0;
  else if (phase === 'FINISHED') tick = CLOSE_TICK;

  // 마감 화면 이동용: 장이 끝나 다음 시나리오 선택 전이거나 7일 완주한 상태
  const closedDay =
    (phase === 'SELECT_SCENARIO' || phase === 'FINISHED') && last && last.end_asset !== null
      ? { day_no: last.day_no, end_asset: last.end_asset }
      : null;

  return { session, days, dayNo, openDay, phase, tick, closedDay, autoClosed: null };
}

// 가격 장부: 이 판에서 거래 가능한 종목(기본 + 본인 창작)의 하루 가격 경로를 계산해 캐시 (DB 저장 없음)
async function buildPriceBook(conn, ctx) {
  const sessionId = ctx.session.session_id;
  const [stocks] = await conn.query(
    `SELECT stock_id, name, sector, base_price, volatility, created_by
       FROM stocks WHERE created_by IS NULL OR created_by = ? ORDER BY stock_id`,
    [ctx.session.user_id]
  );
  const [itemTx] = await conn.query(
    `SELECT t.game_day, t.stock_id, t.game_tick, i.effect_pct
       FROM transactions t JOIN items i ON i.item_id = t.item_id
      WHERE t.session_id = ? AND t.tx_type = 'ITEM'`,
    [sessionId]
  );
  const stockMap = new Map(stocks.map((s) => [s.stock_id, s]));
  const stock = (stockId) => {
    const s = stockMap.get(stockId);
    if (!s) throw new ApiError('NOT_FOUND', '종목을 찾을 수 없습니다');
    return s;
  };
  const cache = new Map();
  const path = (stockId) => {
    if (!cache.has(stockId)) {
      cache.set(stockId, pricePath({ sessionId, dayNo: ctx.dayNo, stock: stock(stockId), days: ctx.days, itemTx }));
    }
    return cache.get(stockId);
  };
  return { stocks, stock, path };
}

// 현금 + 보유 평가금액 (총자산 = 현금 + 보유 수량 × 현재가)
async function computeAssets(conn, ctx, tick = ctx.tick) {
  const sessionId = ctx.session.session_id;
  const cash = await getCash(conn, sessionId);
  const rawHoldings = await getHoldings(conn, sessionId);
  if (rawHoldings.length === 0) return { cash, holdings: [], holdingsValue: 0, totalAsset: cash };

  const book = await buildPriceBook(conn, ctx);
  const holdings = rawHoldings.map((h) => {
    const price = book.path(h.stock_id)[tick];
    return { ...h, current_price: price, eval_amount: h.quantity * price };
  });
  const holdingsValue = holdings.reduce((sum, h) => sum + h.eval_amount, 0);
  return { cash, holdings, holdingsValue, totalAsset: cash + holdingsValue };
}

// ---------- 장 마감 (lazy) ----------

// 15:30 도달: end_asset 기록. 7일차면 FINISHED(환생 1회), 아니면 다음 날 시나리오 선택 대기(PAUSED, tick 0)
async function closeDay(conn, ctx) {
  const sessionId = ctx.session.session_id;
  const { totalAsset } = await computeAssets(conn, ctx, CLOSE_TICK);
  await conn.query('UPDATE session_days SET end_asset = ? WHERE session_id = ? AND day_no = ?', [
    totalAsset,
    sessionId,
    ctx.dayNo,
  ]);
  if (ctx.dayNo === 7) {
    await conn.query(
      "UPDATE game_sessions SET status = 'FINISHED', game_tick = ?, last_resumed_at = NULL, finished_at = NOW() WHERE session_id = ?",
      [CLOSE_TICK, sessionId]
    );
  } else {
    await conn.query(
      "UPDATE game_sessions SET status = 'PAUSED', game_tick = 0, last_resumed_at = NULL WHERE session_id = ?",
      [sessionId]
    );
  }
  return totalAsset;
}

// 세션을 잠그고(FOR UPDATE) 소유자를 확인한 뒤 필요하면 장 마감을 처리해 최신 상태를 돌려준다
async function syncSession(conn, sessionId, userId) {
  const session = await fetchSession(conn, sessionId, true);
  if (!session) throw new ApiError('NOT_FOUND', '게임을 찾을 수 없습니다');
  if (session.user_id !== userId) throw new ApiError('FORBIDDEN', '내 게임이 아닙니다');

  const ctx = buildCtx(session, await fetchDays(conn, sessionId));
  if (ctx.phase !== 'PLAYING' || !isClosed(ctx.tick)) return ctx;

  const endAsset = await closeDay(conn, ctx);
  const closed = buildCtx(await fetchSession(conn, sessionId, false), await fetchDays(conn, sessionId));
  closed.autoClosed = { day_no: ctx.dayNo, end_asset: endAsset };
  return closed;
}

// 하나의 트랜잭션 안에서 syncSession → fn(conn, ctx).
// fn 이 DeferredError 를 반환하면 커밋(마감 처리 보존) 후에 그 에러를 던진다.
async function withSession(sessionId, userId, fn) {
  const result = await withTx(async (conn) => fn(conn, await syncSession(conn, sessionId, userId)));
  if (result instanceof DeferredError) throw result.error;
  return result;
}

// /sessions/:id/... 라우트 공통: id 검증 → withSession → fn(conn, ctx, req) 결과를 응답
function sessionRoute(fn, status = 200) {
  return asyncHandler(async (req, res) => {
    const id = int(req.params.id, 'id');
    ok(res, await withSession(id, req.user.userId, (conn, ctx) => fn(conn, ctx, req)), status);
  });
}

// ---------- 응답 DTO ----------

// 시나리오 공개 정보 (영향 대상·영향률은 일 마감 요약에서만 공개)
const publicScenario = (s) => ({
  scenario_id: s.scenario_id,
  title: s.title,
  description: s.description,
  difficulty: s.difficulty,
});

async function toStateDto(conn, ctx) {
  const startFund = await getStartFund(conn);
  const assets = await computeAssets(conn, ctx);
  const s = ctx.session;
  return {
    session_id: s.session_id,
    status: s.status,
    phase: ctx.phase,
    day_no: ctx.dayNo,
    tick: ctx.tick,
    time: tickToTime(ctx.tick),
    sec_per_game_hour: s.sec_per_game_hour,
    start_fund: startFund,
    cash: assets.cash,
    holdings_value: assets.holdingsValue,
    total_asset: assets.totalAsset,
    scenario: ctx.openDay ? publicScenario(ctx.openDay) : null,
    closed_day: ctx.closedDay,
    auto_closed: ctx.autoClosed !== null,
    started_at: s.started_at,
    finished_at: s.finished_at,
  };
}

// 상태를 바꾼 뒤 다시 읽어 상태 DTO로 돌려준다
async function refreshState(conn, ctx) {
  return toStateDto(conn, await syncSession(conn, ctx.session.session_id, ctx.session.user_id));
}

module.exports = {
  getStartFund,
  getCash,
  getHoldings,
  buildPriceBook,
  computeAssets,
  syncSession,
  withSession,
  sessionRoute,
  publicScenario,
  toStateDto,
  refreshState,
};
