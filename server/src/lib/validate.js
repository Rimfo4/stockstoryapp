const { ApiError } = require('./errors');

function fail(message) {
  throw new ApiError('VALIDATION_ERROR', message);
}

// 정수(숫자 또는 숫자 문자열). 범위 밖이면 VALIDATION_ERROR
function int(value, name, { min = 1, max = 2147483647 } = {}) {
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} 값이 올바르지 않습니다 (${min}~${max} 정수)`);
  return n;
}

// 문자열(앞뒤 공백 제거). 길이는 DB VARCHAR와 같이 '문자 수' 기준
function str(value, name, { min = 1, max }) {
  if (typeof value !== 'string') fail(`${name}은(는) 문자열이어야 합니다`);
  const s = value.trim();
  const len = Array.from(s).length;
  if (len < min || len > max) fail(`${name}은(는) ${min}~${max}자여야 합니다`);
  return s;
}

function oneOf(value, name, allowed) {
  if (!allowed.includes(value)) fail(`${name}은(는) ${allowed.join(', ')} 중 하나여야 합니다`);
  return value;
}

module.exports = { int, str, oneOf };
