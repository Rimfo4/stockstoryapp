// mysql2 커넥션 풀 + 트랜잭션 헬퍼
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  decimalNumbers: true, // DECIMAL(SUM, impact_pct 등)을 문자열이 아닌 숫자로 받는다
  dateStrings: true, // DATETIME을 Date 객체(타임존 변환) 대신 문자열로 받는다
});

// fn(conn) 안의 쿼리를 하나의 트랜잭션으로 묶는다. 예외가 나면 ROLLBACK 후 다시 던진다.
async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* 롤백 실패는 원래 에러를 가리지 않는다 */
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTx };
