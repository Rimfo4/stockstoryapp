// 에러 코드 → HTTP 상태 (06_API명세서_요약.md의 에러 코드 10종)
const STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  WRONG_PHASE: 409,
  MARKET_CLOSED: 409,
  NOT_ENOUGH_CASH: 409,
  NOT_ENOUGH_QUANTITY: 409,
  IN_USE: 409,
};

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.status = STATUS[code] || 500;
    this.details = details;
  }
}

// 트랜잭션을 커밋한 뒤에 던지고 싶은 에러(예: 주문 중 장 마감이 처리된 경우)를 감싼다
class DeferredError {
  constructor(error) {
    this.error = error;
  }
}

module.exports = { ApiError, DeferredError };
