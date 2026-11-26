// 게임 시계: 서버 타이머 없이 요청 때마다 경과 시간으로 계산한다(lazy).
//   tick = game_tick + floor(경과초 / (sec_per_game_hour / 12))   (1틱 = 게임 5분 = 게임 1시간의 1/12)
const CLOSE_TICK = 78; // 15:30

function currentTick({ status, gameTick, elapsedSec, secPerGameHour }) {
  if (status !== 'PLAYING') return gameTick;
  const advanced = Math.floor((Math.max(0, elapsedSec) * 12) / secPerGameHour);
  return Math.min(CLOSE_TICK, gameTick + advanced);
}

function isClosed(tick) {
  return tick >= CLOSE_TICK;
}

// 0 → "09:00", 78 → "15:30"
function tickToTime(tick) {
  const m = 9 * 60 + tick * 5;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

module.exports = { CLOSE_TICK, currentTick, isClosed, tickToTime };
