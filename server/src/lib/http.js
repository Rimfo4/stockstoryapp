// 공통 응답: 성공 {ok:true, data} / 실패 {ok:false, error:{code,message}}
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

// async 라우트 핸들러의 예외를 에러 미들웨어로 넘긴다
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { ok, asyncHandler };
