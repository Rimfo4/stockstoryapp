// #1 POST /auth/signup  #2 POST /auth/login  #3 GET /auth/check-nickname
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { ApiError } = require('../lib/errors');
const { ok, asyncHandler } = require('../lib/http');
const { str } = require('../lib/validate');
const { signToken } = require('../middleware/auth');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 존재하지 않는 이메일로 로그인해도 같은 시간이 걸리도록 쓰는 더미 해시
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

function parseEmail(v) {
  const email = str(v, '이메일', { min: 5, max: 100 }).toLowerCase(); // users.email VARCHAR(100)
  if (!EMAIL_RE.test(email)) throw new ApiError('VALIDATION_ERROR', '이메일 형식이 올바르지 않습니다');
  return email;
}

function parseNickname(v) {
  return str(v, '닉네임', { min: 2, max: 20 }); // users.nickname VARCHAR(20)
}

function parsePassword(v) {
  if (typeof v !== 'string' || v.length < 8 || Buffer.byteLength(v) > 72) {
    // bcrypt 는 72바이트까지만 사용
    throw new ApiError('VALIDATION_ERROR', '비밀번호는 8자 이상 72바이트 이하여야 합니다');
  }
  return v;
}

router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = parseEmail(body.email);
    const nickname = parseNickname(body.nickname);
    const password = parsePassword(body.password);
    const passwordHash = await bcrypt.hash(password, 10);

    let userId;
    try {
      const [r] = await pool.query('INSERT INTO users (email, password_hash, nickname) VALUES (?, ?, ?)', [
        email,
        passwordHash,
        nickname,
      ]);
      userId = r.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // UNIQUE 제약(uq_users_email / uq_users_nickname) 중 어느 쪽인지 구분
        const which = String(err.message).includes('uq_users_nickname') ? '닉네임' : '이메일';
        throw new ApiError('DUPLICATE', `이미 사용 중인 ${which}입니다`);
      }
      throw err;
    }
    ok(res, { token: signToken(userId), user: { user_id: userId, email, nickname } }, 201);
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) throw new ApiError('VALIDATION_ERROR', '이메일과 비밀번호를 입력하세요');

    const [rows] = await pool.query('SELECT user_id, email, nickname, password_hash FROM users WHERE email = ?', [email]);
    const user = rows[0];
    // 샘플 데이터의 자리표시 해시처럼 형식이 잘못된 해시는 bcryptjs가 false 를 돌려준다
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match) throw new ApiError('UNAUTHORIZED', '이메일 또는 비밀번호가 올바르지 않습니다');

    ok(res, {
      token: signToken(user.user_id),
      user: { user_id: user.user_id, email: user.email, nickname: user.nickname },
    });
  })
);

router.get(
  '/check-nickname',
  asyncHandler(async (req, res) => {
    const nickname = parseNickname(req.query.nickname);
    const [rows] = await pool.query('SELECT 1 FROM users WHERE nickname = ?', [nickname]);
    ok(res, { nickname, available: rows.length === 0 });
  })
);

module.exports = router;
