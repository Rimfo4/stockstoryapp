const config = require('./config');
const { pool } = require('./db');
const app = require('./app');

async function main() {
  // 시작할 때 DB 연결을 한 번 확인한다
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  const server = app.listen(config.port, () => {
    console.log(`stock-game-server listening on :${config.port}`);
  });

  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('서버 시작 실패:', err.message);
  process.exit(1);
});
