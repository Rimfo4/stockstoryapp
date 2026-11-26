const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../lib/errors');

function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

// Authorization: Bearer <JWT> 검증 → req.user = { userId }
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new ApiError('UNAUTHORIZED', '로그인이 필요합니다'));
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { userId: Number(payload.sub) };
    return next();
  } catch (_) {
    return next(new ApiError('UNAUTHORIZED', '토큰이 유효하지 않거나 만료되었습니다'));
  }
}

module.exports = { signToken, requireAuth };
