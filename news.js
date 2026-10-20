// Новости: писать и удалять могут только владельцы (ADMIN_IDS), читать и голосовать - все игроки.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const UPLOADS = path.join(path.resolve(process.env.DATA_DIR || __dirname), 'uploads');
const MAX_IMAGE = 4 * 1024 * 1024; // 4 МБ

// тип файла определяем по первым байтам, а не по тому, что прислал браузер
function detectExt(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function saveImage(dataUrl) {
  const m = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Допустимы картинки PNG, JPG, GIF и WebP');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_IMAGE) throw new Error('Картинка больше 4 МБ');
  const ext = detectExt(buf);
  if (!ext) throw new Error('Файл не похож на картинку');
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return name;
}

module.exports = function registerNews(app, db, auth, ownerOnly, rolesFor = () => []) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS news(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', image TEXT, created INTEGER
    );
    CREATE TABLE IF NOT EXISTS news_votes(
      news_id INTEGER NOT NULL, user_id TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY(news_id, user_id)
    );
  `);
  try { db.exec('ALTER TABLE news ADD COLUMN comments_off INTEGER DEFAULT 0'); } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS news_comments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, news_id INTEGER NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, created INTEGER
  )`);
  const lastComment = new Map(); // защита от спама: не чаще раза в 2 секунды
  app.use('/uploads', express.static(UPLOADS, { setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));

  const score = id => db.prepare('SELECT COALESCE(SUM(vote),0) s FROM news_votes WHERE news_id=?').get(id).s;

  app.get('/api/news', auth, (req, res) => {
    const order = req.query.sort === 'best' ? 'score DESC, n.id DESC' : 'n.id DESC';
    const rows = db.prepare(`SELECT n.id, n.text, n.image, n.created, u.id AS uid, u.nick, u.display, u.username, u.avatar,
        COALESCE((SELECT SUM(vote) FROM news_votes v WHERE v.news_id=n.id),0) AS score,
        COALESCE((SELECT vote FROM news_votes v WHERE v.news_id=n.id AND v.user_id=?),0) AS my,
        n.comments_off, (SELECT COUNT(*) FROM news_comments c WHERE c.news_id=n.id) AS ccount
      FROM news n LEFT JOIN users u ON u.id=n.user_id ORDER BY ${order} LIMIT 100`).all(req.user.id);
    const banned = app.locals.bannedIds();
    // три последних комментария под каждой новостью показываются сразу, остальные - по ссылке "Посмотреть все"
    const recentStmt = db.prepare(`SELECT c.id, c.text, c.created, u.id AS uid, u.nick, u.display, u.username, u.avatar
      FROM news_comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.news_id=? ORDER BY c.id DESC LIMIT 3`);
    res.json(rows.map(r => ({
      recent: r.comments_off ? [] : recentStmt.all(r.id).reverse().map(c => commentView(c, req, banned)),
      banned: banned.has(r.uid), id: r.id, text: r.text, created: r.created, score: r.score, my: r.my, canDelete: !!req.user.isOwner,
      commentsOff: !!r.comments_off, commentCount: r.ccount,
      image: r.image ? '/uploads/' + r.image : null,
      author: r.nick || r.display || r.username || 'Администрация', roles: rolesFor(r.uid),
      avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.uid}/${r.avatar}.png?size=64` : null
    })));
  });

  app.post('/api/news', auth, ownerOnly, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (!text && !req.body.image) return res.status(400).json({ error: 'Напишите текст или добавьте картинку' });
    let image = null;
    try { if (req.body.image) image = saveImage(req.body.image); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    db.prepare('INSERT INTO news(user_id, text, image, created, comments_off) VALUES(?,?,?,?,?)').run(req.user.id, text, image, Date.now(), req.body.commentsOff ? 1 : 0);
    res.json({ ok: true });
  });

  app.post('/api/news/:id/vote', auth, (req, res) => {
    const id = parseInt(req.params.id, 10), vote = parseInt(req.body.vote, 10);
    if (![-1, 0, 1].includes(vote) || !db.prepare('SELECT 1 FROM news WHERE id=?').get(id)) return res.status(400).json({ error: 'Некорректный голос' });
    if (vote === 0) db.prepare('DELETE FROM news_votes WHERE news_id=? AND user_id=?').run(id, req.user.id);
    else db.prepare(`INSERT INTO news_votes(news_id, user_id, vote) VALUES(?,?,?)
      ON CONFLICT(news_id, user_id) DO UPDATE SET vote=excluded.vote`).run(id, req.user.id, vote);
    res.json({ ok: true, score: score(id), my: vote });
  });

  app.delete('/api/news/:id', auth, ownerOnly, (req, res) => {
    const post = db.prepare('SELECT * FROM news WHERE id=?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Новость не найдена' });
    if (post.image) fs.rm(path.join(UPLOADS, path.basename(post.image)), { force: true }, () => {});
    db.transaction(() => {
      db.prepare('DELETE FROM news_votes WHERE news_id=?').run(post.id);
      db.prepare('DELETE FROM news_comments WHERE news_id=?').run(post.id);
      db.prepare('DELETE FROM news WHERE id=?').run(post.id);
    })();
    res.json({ ok: true });
  });

  const commentView = (r, req, banned) => ({
    banned: banned.has(r.uid), id: r.id, text: r.text, created: r.created, author: r.nick || r.display || r.username || 'Игрок', roles: rolesFor(r.uid),
    avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.uid}/${r.avatar}.png?size=48` : null,
    canDelete: !!req.user.isOwner || r.uid === req.user.id
  });

  app.get('/api/news/:id/comments', auth, (req, res) => {
    const post = db.prepare('SELECT id, comments_off FROM news WHERE id=?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Новость не найдена' });
    if (post.comments_off) return res.json({ off: true, comments: [] });
    const rows = db.prepare(`SELECT c.id, c.text, c.created, u.id AS uid, u.nick, u.display, u.username, u.avatar
      FROM news_comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.news_id=? ORDER BY c.id ASC LIMIT 300`).all(post.id);
    const banned = app.locals.bannedIds();
    res.json({ off: false, comments: rows.map(r => commentView(r, req, banned)) });
  });

  app.post('/api/news/:id/comments', auth, (req, res) => {
    const post = db.prepare('SELECT id, comments_off FROM news WHERE id=?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Новость не найдена' });
    if (post.comments_off) return res.status(403).json({ error: 'Комментарии к этой новости отключены' });
    const text = String(req.body.text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'Напишите комментарий' });
    if (Date.now() - (lastComment.get(req.user.id) || 0) < 2000) return res.status(429).json({ error: 'Не так быстро, подождите пару секунд' });
    lastComment.set(req.user.id, Date.now());
    db.prepare('INSERT INTO news_comments(news_id, user_id, text, created) VALUES(?,?,?,?)').run(post.id, req.user.id, text, Date.now());
    res.json({ ok: true });
  });

  // удалить комментарий может его автор или владелец
  app.delete('/api/news/:id/comments/:cid', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM news_comments WHERE id=? AND news_id=?').get(req.params.cid, req.params.id);
    if (!c) return res.status(404).json({ error: 'Комментарий не найден' });
    if (!req.user.isOwner && c.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare('DELETE FROM news_comments WHERE id=?').run(c.id);
    res.json({ ok: true });
  });
};
