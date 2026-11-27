const express = require('express');
const cors = require('cors');
const { ok } = require('./lib/http');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => ok(res, { status: 'up' }));

app.use('/auth', require('./routes/auth'));
// 세션 하위 API: 생명주기/시나리오(sessions) + 시세·주문·정산(trading) 는 같은 /sessions 접두사를 쓴다
app.use('/sessions', require('./routes/sessions'));
app.use('/sessions', require('./routes/trading'));
app.use('/me', require('./routes/me'));
app.use('/shop', require('./routes/shop'));
app.use('/rankings', require('./routes/rankings'));
app.use('/', require('./routes/craft')); // /stocks, /craft/*

app.use(notFound);
app.use(errorHandler);

module.exports = app;
