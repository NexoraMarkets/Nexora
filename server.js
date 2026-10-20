require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  PORT = process.env.PORT || 3000, BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_WEBHOOK_URL,
  BANKER_ROLE_ID, JWT_SECRET = 'dev-secret', ADMIN_IDS = ''
} = process.env;

const admins = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const isOwnerId = id => admins.has(String(id));
const oreMarketAdminOnly = (req, res, next) =>
  req.user.isOwner ? next() : res.status(403).json({ error: 'Нет доступа' });
const secureCookie = BASE_URL.startsWith('https');
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const CALL_COOLDOWN_MS = 60 * 1000;
const MAX_CARDS = 5;

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
// Встроенный lower() в SQLite не понимает кириллицу ("Вася" != "вася"), поэтому подменяем его на JS-версию:
// иначе поиск ников, проверки уникальности и дубли ролей с русскими буквами работают неверно.
db.function('lower', { deterministic: true }, v => (v == null ? null : String(v).toLowerCase()));
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL, display TEXT, avatar TEXT,
  last_call INTEGER DEFAULT 0, created INTEGER
);
CREATE TABLE IF NOT EXISTS cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
  name TEXT NOT NULL, number TEXT UNIQUE NOT NULL, balance INTEGER NOT NULL DEFAULT 0, created INTEGER
);
CREATE TABLE IF NOT EXISTS tx(
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
  amount INTEGER NOT NULL, note TEXT, created INTEGER
);
`);

try { db.exec('ALTER TABLE users ADD COLUMN nick TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN is_staff INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE cards ADD COLUMN color TEXT DEFAULT 'blue'"); } catch {}
const COLORS = ['blue', 'purple', 'red', 'green', 'orange', 'pink', 'gray'];
const pickColor = c => COLORS.includes(c) ? c : 'blue';

db.exec(`
CREATE TABLE IF NOT EXISTS stocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  price INTEGER NOT NULL, total INTEGER NOT NULL, created INTEGER
);
CREATE TABLE IF NOT EXISTS holdings(
  user_id TEXT NOT NULL, stock_id INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, stock_id)
);
CREATE TABLE IF NOT EXISTS price_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, stock_id INTEGER NOT NULL, price INTEGER NOT NULL, ts INTEGER NOT NULL
);
`);

try { db.exec('ALTER TABLE stocks ADD COLUMN base REAL'); } catch {}
try { db.exec('ALTER TABLE stocks ADD COLUMN slope REAL DEFAULT 0.2'); } catch {}
db.exec('UPDATE stocks SET base=price WHERE base IS NULL');
try { db.exec('ALTER TABLE price_history ADD COLUMN qty INTEGER'); } catch {}
try { db.exec('ALTER TABLE price_history ADD COLUMN amount INTEGER'); } catch {}

const app = express();
// ---------- Блокировки и уведомления ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS bans(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, by_user_id TEXT NOT NULL, reason TEXT NOT NULL,
    minutes INTEGER, created INTEGER NOT NULL, expires_at INTEGER, lifted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
  );
`);
// действующая блокировка: не снята и срок не вышел (срок проверяется по времени, отдельная очистка не нужна)
const activeBan = uid => db.prepare(`SELECT b.*, u.nick, u.display, u.username FROM bans b LEFT JOIN users u ON u.id=b.by_user_id
  WHERE b.user_id=? AND b.lifted=0 AND (b.expires_at IS NULL OR b.expires_at > ?) ORDER BY b.id DESC LIMIT 1`).get(uid, Date.now());
const banView = b => b && ({ by: b.nick || b.display || b.username || 'Администратор', reason: b.reason, minutes: b.minutes, created: b.created, until: b.expires_at });
const bannedIds = () => new Set(db.prepare('SELECT DISTINCT user_id FROM bans WHERE lifted=0 AND (expires_at IS NULL OR expires_at > ?)').all(Date.now()).map(r => r.user_id));
const notify = (uid, text) => db.prepare('INSERT INTO notifications(user_id, text, created) VALUES(?,?,?)').run(uid, text, Date.now());
app.locals.activeBan = activeBan; app.locals.banView = banView; app.locals.bannedIds = bannedIds; app.locals.notify = notify;
app.locals.isOwnerId = isOwnerId;

// Биржа Nexora убрана (вместо неё OreMarket). Один раз возвращаем игрокам стоимость их акций на первую карту.
// Игрокам без карты акции остаются в базе и вернутся при следующем запуске, когда у них появится карта.
(function refundOldExchange() {
  try {
    const rows = db.prepare('SELECT user_id, stock_id, qty FROM holdings WHERE qty > 0 ORDER BY stock_id, rowid').all();
    if (!rows.length) return;
    const held = {};
    for (const r of rows) held[r.stock_id] = (held[r.stock_id] || 0) + r.qty;
    let refunded = 0, skipped = 0;
    db.transaction(() => {
      for (const r of rows) {
        const st = db.prepare('SELECT * FROM stocks WHERE id=?').get(r.stock_id);
        const card = db.prepare('SELECT id FROM cards WHERE user_id=? ORDER BY id LIMIT 1').get(r.user_id);
        if (!st || !card) { skipped++; continue; }
        const h = held[r.stock_id];
        const amount = Math.max(0, Math.floor(st.base * r.qty + st.slope * (h * h - (h - r.qty) * (h - r.qty)) / 2 + 1e-6));
        held[r.stock_id] = h - r.qty;
        db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(amount, card.id);
        db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(card.id, amount, `Закрытие биржи: возврат за ${r.qty} × ${st.ticker}`, Date.now());
        db.prepare('DELETE FROM holdings WHERE user_id=? AND stock_id=?').run(r.user_id, r.stock_id);
        refunded++;
      }
    })();
    console.log(`Старая биржа закрыта: возвращено ${refunded} позиций${skipped ? `, ${skipped} пропущено (у игрока нет карты)` : ''}`);
  } catch (e) { console.error('Не удалось вернуть АР за акции старой биржи:', e.message); }
})();

app.set('trust proxy', 1);
const jsonSmall = express.json(), jsonBig = express.json({ limit: '8mb' }); // 8 МБ - для картинок
app.use((req, res, next) => (req.method === 'POST' && (req.path === '/api/news' || req.path === '/api/om/admin/market-logo') ? jsonBig : jsonSmall)(req, res, next));
app.use(cookieParser());
const publicFiles = express.static(path.join(__dirname, 'public'));
app.use((req, res, next) => req.path === '/oremarket/admin.html' ? next() : publicFiles(req, res, next));

// ---------- Авторизация через Discord ----------
const SAFE_NEXT = /^\/(?!\/)[A-Za-z0-9\-._~\/]*$/; // только свои страницы, без внешних ссылок
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 10 * 60 * 1000 });
  res.cookie('oauth_next', SAFE_NEXT.test(String(req.query.next || '')) ? req.query.next : '/', { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 10 * 60 * 1000 });
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'identify', state
  });
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies.oauth_state) return res.status(400).send('Неверный state');
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) return res.status(400).send('Не удалось войти через Discord');
    const me = await (await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })).json();

    db.prepare(`INSERT INTO users(id, username, display, avatar, created) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, display=excluded.display, avatar=excluded.avatar`)
      .run(me.id, me.username, me.global_name || me.username, me.avatar, Date.now());

    // Сессия на 30 дней - не слетает при перезагрузке страницы и сервера
    const jwtToken = jwt.sign({ id: me.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('session', jwtToken, {
      httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 30 * 24 * 3600 * 1000
    });
    res.clearCookie('oauth_state');
    const next = SAFE_NEXT.test(String(req.cookies.oauth_next || '')) ? req.cookies.oauth_next : '/';
    res.clearCookie('oauth_next');
    res.redirect(next);
  } catch (e) {
    console.error(e);
    res.status(500).send('Ошибка авторизации');
  }
});

app.post('/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.session, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) throw new Error('no user');
    user.isOwner = isOwnerId(user.id);
    user.isStaff = user.isOwner || user.is_staff === 1;
    const ban = user.isOwner ? null : activeBan(user.id); // владельцев блокировка не касается
    user.ban = banView(ban);
    req.user = user;
    if (ban && req.method !== 'GET' && req.method !== 'HEAD' && req.path !== '/api/notifications/read') {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован: действия недоступны', banned: true, ban: user.ban });
    }
    next();
  } catch { res.status(401).json({ error: 'Не авторизован' }); }
}
const staffOnly = (req, res, next) => req.user.isStaff ? next() : res.status(403).json({ error: 'Нет доступа' });
const ownerOnly = (req, res, next) => req.user.isOwner ? next() : res.status(403).json({ error: 'Нет доступа' });
app.get('/oremarket/admin.html', auth, ownerOnly, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'oremarket', 'admin.html')));

// ---------- API ----------
app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, name: u.nick || u.display || u.username, nick: u.nick, needsNick: !u.nick,
    username: u.username, isStaff: u.isStaff, isOwner: u.isOwner, banned: !!u.ban, ban: u.ban,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null
  });
});

app.post('/api/nick', auth, (req, res) => {
  const nick = String(req.body.nick || '').trim();
  if (nick.length < 2 || nick.length > 32) return res.status(400).json({ error: 'Ник должен быть от 2 до 32 символов' });
  const taken = db.prepare('SELECT 1 FROM users WHERE lower(nick)=? AND id<>?').get(nick.toLowerCase(), req.user.id);
  if (taken) return res.status(400).json({ error: 'Этот ник уже занят другим игроком' });
  db.prepare('UPDATE users SET nick=? WHERE id=?').run(nick, req.user.id);
  res.json({ ok: true });
});

app.get('/api/cards', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name, number, balance, color FROM cards WHERE user_id=? ORDER BY id').all(req.user.id));
});

app.get('/api/transactions', auth, (req, res) => {
  res.json(db.prepare(`SELECT t.id, t.amount, t.note, t.created, c.number FROM tx t
    JOIN cards c ON c.id=t.card_id WHERE c.user_id=? ORDER BY t.id DESC LIMIT 100`).all(req.user.id));
});

app.post('/api/cards', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Введите название карты' });
  const count = db.prepare('SELECT COUNT(*) c FROM cards WHERE user_id=?').get(req.user.id).c;
  if (count >= MAX_CARDS) return res.status(400).json({ error: `Максимум карт: ${MAX_CARDS}` });
  db.transaction(() => {
    const info = db.prepare('INSERT INTO cards(user_id, name, number, color, created) VALUES(?,?,?,?,?)')
      .run(req.user.id, name, 'tmp' + crypto.randomBytes(6).toString('hex'), pickColor(req.body.color), Date.now());
    db.prepare('UPDATE cards SET number=? WHERE id=?')
      .run(String(info.lastInsertRowid).padStart(5, '0'), info.lastInsertRowid);
  })();
  res.json({ ok: true });
});

app.patch('/api/cards/:id', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Введите название' });
  db.prepare('UPDATE cards SET name=?, color=? WHERE id=? AND user_id=?').run(name, pickColor(req.body.color), req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/cards/:id', auth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Карта не найдена' });
  if (card.balance > 0) return res.status(400).json({ error: 'Нельзя удалить карту с деньгами' });
  db.prepare('DELETE FROM tx WHERE card_id=?').run(card.id);
  db.prepare('DELETE FROM cards WHERE id=?').run(card.id);
  res.json({ ok: true });
});

// Подсказки ников при вводе (только ник и аватар)
app.get('/api/players', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().replace(/[%_]/g, '').trim();
  if (!q) return res.json([]);
  const rows = db.prepare(`SELECT id, nick, avatar FROM users
    WHERE nick IS NOT NULL AND lower(nick) LIKE ? AND id<>?
    ORDER BY (lower(nick) LIKE ?) DESC, nick LIMIT 6`).all(`%${q}%`, req.user.id, `${q}%`);
  res.json(rows.map(r => ({
    name: r.nick,
    avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.png?size=48` : null
  })));
});

// Переводы между игроками (по нику или по номеру карты)
app.post('/api/transfer', auth, (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  const mode = req.body.by === 'number' ? 'number' : 'nick';
  const to = String(req.body.to || '').trim();
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Введите сумму больше нуля' });
  if (!to) return res.status(400).json({ error: mode === 'nick' ? 'Введите ник получателя' : 'Введите номер карты получателя' });

  const from = db.prepare('SELECT * FROM cards WHERE id=? AND user_id=?').get(req.body.from, req.user.id);
  if (!from) return res.status(404).json({ error: 'Карта списания не найдена' });

  let target, recipient;
  if (mode === 'number') {
    target = db.prepare('SELECT * FROM cards WHERE number=?').get(to);
    if (!target) return res.status(404).json({ error: 'Карта с таким номером не найдена' });
    recipient = db.prepare('SELECT * FROM users WHERE id=?').get(target.user_id);
  } else {
    const q = to.toLowerCase();
    recipient = db.prepare('SELECT * FROM users WHERE lower(nick)=?').get(q)
      || db.prepare('SELECT * FROM users WHERE lower(username)=? OR lower(display)=?').get(q, q);
    if (!recipient) return res.status(404).json({ error: 'Игрок с таким ником не найден' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'Нельзя перевести самому себе по нику' });
    target = db.prepare('SELECT * FROM cards WHERE user_id=? ORDER BY id LIMIT 1').get(recipient.id);
    if (!target) return res.status(404).json({ error: 'У игрока нет карты' });
  }
  if (target.id === from.id) return res.status(400).json({ error: 'Нельзя перевести на ту же карту' });
  if (from.balance < amount) return res.status(400).json({ error: 'Недостаточно АР на карте' });

  const nameOf = u => u.nick || u.display || u.username;
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE cards SET balance=balance-? WHERE id=?').run(amount, from.id);
    db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(amount, target.id);
    db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)')
      .run(from.id, -amount, `Перевод игроку ${nameOf(recipient)}`, now);
    db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)')
      .run(target.id, amount, `Перевод от ${nameOf(req.user)}`, now);
  })();
  res.json({ ok: true, to: nameOf(recipient), amount });
});

// Вызов банкира -> сообщение в Discord с пингом роли
app.post('/api/call', auth, async (req, res) => {
  const target = String(req.body.target || 'Банкир');
  const place = String(req.body.place || '').trim().slice(0, 100);
  if (target !== 'Банкир') return res.status(400).json({ error: 'Неизвестная цель вызова' });
  if (!place) return res.status(400).json({ error: 'Укажите место вызова' });

  const wait = req.user.last_call + CALL_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `Подождите ${Math.ceil(wait / 1000)} сек. перед новым вызовом` });
  if (!DISCORD_WEBHOOK_URL || !BANKER_ROLE_ID) return res.status(500).json({ error: 'Вебхук или роль не настроены' });

  const name = req.user.nick || req.user.display || req.user.username;
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `<@&${BANKER_ROLE_ID}> Игрок **${name}** (Discord: ${req.user.username}) вызывает банкира!\n📍 Место: **${place}**`,
      allowed_mentions: { roles: [BANKER_ROLE_ID] }
    })
  }).catch(() => null);
  if (!r || !r.ok) return res.status(502).json({ error: 'Не удалось отправить сообщение в Discord' });

  db.prepare('UPDATE users SET last_call=? WHERE id=?').run(Date.now(), req.user.id);
  res.json({ ok: true });
});

// ---------- Сотрудники банка (управляют владельцы из ADMIN_IDS) ----------
const avatarUrl = u => u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=48` : null;

app.get('/api/staff', auth, ownerOnly, (req, res) => {
  const rows = db.prepare('SELECT id, nick, display, username, avatar FROM users WHERE is_staff=1 ORDER BY nick').all();
  res.json(rows.map(u => ({ id: u.id, name: u.nick || u.display || u.username, avatar: avatarUrl(u) })));
});

app.post('/api/staff', auth, ownerOnly, (req, res) => {
  const nick = String(req.body.nick || '').trim().toLowerCase();
  const user = nick && db.prepare('SELECT * FROM users WHERE lower(nick)=?').get(nick);
  if (!user) return res.status(404).json({ error: 'Игрок с таким ником не найден' });
  if (isOwnerId(user.id)) return res.status(400).json({ error: 'Этот игрок уже владелец' });
  db.prepare('UPDATE users SET is_staff=1 WHERE id=?').run(user.id);
  res.json({ ok: true });
});

app.post('/api/staff/remove', auth, ownerOnly, (req, res) => {
  db.prepare('UPDATE users SET is_staff=0 WHERE id=?').run(String(req.body.id || ''));
  res.json({ ok: true });
});

// ---------- Касса (сотрудники банка) ----------
app.get('/api/admin/players', auth, staffOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display, nick, avatar FROM users').all();
  const cards = db.prepare('SELECT user_id, name, number, balance, color FROM cards ORDER BY id').all();
  const byUser = {};
  for (const c of cards) (byUser[c.user_id] ||= []).push({ name: c.name, number: c.number, balance: c.balance, color: c.color });
  const bans = bannedIds();
  const list = users.map(u => ({
    name: u.nick || u.display || u.username, username: u.username, hasNick: !!u.nick,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=48` : null,
    cards: byUser[u.id] || [], banned: bans.has(u.id)
  }));
  list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  res.json(list.slice(0, 500));
});

app.get('/api/admin/users', auth, staffOnly, (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const users = db.prepare(`SELECT id, username, display, nick FROM users
    WHERE lower(nick) LIKE ? OR lower(username) LIKE ? OR lower(display) LIKE ? ORDER BY nick, username LIMIT 20`).all(q, q, q);
  for (const u of users) u.cards = db.prepare('SELECT id, name, number, balance FROM cards WHERE user_id=?').all(u.id);
  res.json(users);
});

app.post('/api/admin/give', auth, staffOnly, (req, res) => {
  const nick = String(req.body.nick || '').trim().toLowerCase();
  const amount = parseInt(req.body.amount, 10);
  if (!nick || !Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: 'Укажите ник и сумму' });

  const user = db.prepare('SELECT * FROM users WHERE lower(nick)=?').get(nick)
    || db.prepare('SELECT * FROM users WHERE lower(username)=? OR lower(display)=?').get(nick, nick);
  if (!user) return res.status(404).json({ error: 'Игрок не найден (он должен войти на сайт и указать ник)' });

  let card;
  if (req.body.card) card = db.prepare('SELECT * FROM cards WHERE number=? AND user_id=?').get(String(req.body.card), user.id);
  else card = db.prepare('SELECT * FROM cards WHERE user_id=? ORDER BY id LIMIT 1').get(user.id);
  if (!card) return res.status(404).json({ error: 'У игрока нет такой карты' });
  if (card.balance + amount < 0) return res.status(400).json({ error: 'Баланс не может стать отрицательным' });

  const adminName = req.user.nick || req.user.display || req.user.username;
  db.transaction(() => {
    db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(amount, card.id);
    db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)')
      .run(card.id, amount, amount > 0 ? `Пополнение (банкир ${adminName})` : `Списание (банкир ${adminName})`, Date.now());
  })();
  res.json({ ok: true, player: user.nick || user.display || user.username, card: card.number, balance: card.balance + amount });
});

require('./apps')(app, db, auth);
require('./notifications')(app, db, auth);
require('./orders')(app, db, auth, ownerOnly);
require('./oremarket')(app, db, auth, oreMarketAdminOnly);
const { rolesFor } = require('./admin')(app, db, auth, ownerOnly);
require('./news')(app, db, auth, ownerOnly, rolesFor);

app.listen(PORT, '0.0.0.0', () => console.log('Nexora запущен: ' + BASE_URL));
