const { ApiError } = require('../lib/errors');

function notFound(req, res, next) {
  next(new ApiError('NOT_FOUND', `${req.method} ${req.path} 경로가 없습니다`));
}

// MySQL 제약 위반을 공통 에러 코드로 변환 (DB 설계의 UNIQUE / CHECK / FK 제약이 마지막 방어선)
function fromMysql(err) {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return new ApiError('DUPLICATE', '이미 존재하는 값입니다');
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
    case 'ER_NO_REFERENCED_ROW_2':
      return new ApiError('VALIDATION_ERROR', '허용되지 않는 값입니다');
    case 'ER_ROW_IS_REFERENCED_2':
      return new ApiError('IN_USE', '사용 중이라 삭제할 수 없습니다');
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let apiErr = err instanceof ApiError ? err : fromMysql(err);
  if (!apiErr && err.type === 'entity.parse.failed') apiErr = new ApiError('VALIDATION_ERROR', 'JSON 형식이 올바르지 않습니다');
  if (!apiErr && err.type === 'entity.too.large') apiErr = new ApiError('VALIDATION_ERROR', '요청 본문이 너무 큽니다');

  if (!apiErr) {
    console.error(err);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다' } });
  }
  const error = { code: apiErr.code, message: apiErr.message };
  if (apiErr.details) error.details = apiErr.details;
  return res.status(apiErr.status).json({ ok: false, error });
}

module.exports = { notFound, errorHandler };
