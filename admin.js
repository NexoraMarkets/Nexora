// Админ-панель (только владельцы из ADMIN_IDS): роли игроков и смена ников.
// Роль - это название и цвет. Роли игрока показываются рядом с ником в новостях.
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_ROLES = 30;

module.exports = function registerAdmin(app, db, auth, ownerOnly) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_roles(user_id TEXT NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY(user_id, role_id));
  `);

  const rolesFor = uid => db.prepare(
    'SELECT r.id, r.name, r.color FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=? ORDER BY r.id').all(uid);

  app.get('/api/admin/roles', auth, ownerOnly, (req, res) => {
    res.json(db.prepare('SELECT id, name, color FROM roles ORDER BY id').all());
  });

  app.post('/api/admin/roles', auth, ownerOnly, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 24);
    const color = String(req.body.color || '');
    if (!name) return res.status(400).json({ error: 'Введите название роли' });
    if (!COLOR.test(color)) return res.status(400).json({ error: 'Некорректный цвет' });
    if (db.prepare('SELECT 1 FROM roles WHERE lower(name)=?').get(name.toLowerCase())) return res.status(400).json({ error: 'Такая роль уже есть' });
    if (db.prepare('SELECT COUNT(*) c FROM roles').get().c >= MAX_ROLES) return res.status(400).json({ error: `Максимум ролей: ${MAX_ROLES}` });
    db.prepare('INSERT INTO roles(name, color) VALUES(?,?)').run(name, color);
    res.json({ ok: true });
  });

  app.delete('/api/admin/roles/:id', auth, ownerOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!db.prepare('SELECT 1 FROM roles WHERE id=?').get(id)) return res.status(404).json({ error: 'Роль не найдена' });
    db.transaction(() => {
      db.prepare('DELETE FROM user_roles WHERE role_id=?').run(id);
      db.prepare('DELETE FROM roles WHERE id=?').run(id);
    })();
    res.json({ ok: true });
  });

  // игроки с их ролями; q - поиск по нику, Discord-имени
  app.get('/api/admin/manage/players', auth, ownerOnly, (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase().replace(/[%_]/g, '').trim()}%`;
    const rows = db.prepare(`SELECT id, username, display, nick, avatar FROM users
      WHERE lower(COALESCE(nick,'')) LIKE ? OR lower(username) LIKE ? OR lower(COALESCE(display,'')) LIKE ?
      ORDER BY lower(COALESCE(nick, display, username)) LIMIT 50`).all(q, q, q);
    res.json(rows.map(u => ({
      banned: !!app.locals.activeBan(u.id), ban: app.locals.banView(app.locals.activeBan(u.id)), isOwner: app.locals.isOwnerId(u.id),
      id: u.id, name: u.nick || u.display || u.username, nick: u.nick, username: u.username, roles: rolesFor(u.id),
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=48` : null
    })));
  });

  app.post('/api/admin/manage/roles', auth, ownerOnly, (req, res) => {
    const userId = String(req.body.userId || ''), roleId = parseInt(req.body.roleId, 10);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return res.status(404).json({ error: 'Игрок не найден' });
    if (!db.prepare('SELECT 1 FROM roles WHERE id=?').get(roleId)) return res.status(404).json({ error: 'Роль не найдена' });
    if (req.body.on) db.prepare('INSERT OR IGNORE INTO user_roles(user_id, role_id) VALUES(?,?)').run(userId, roleId);
    else db.prepare('DELETE FROM user_roles WHERE user_id=? AND role_id=?').run(userId, roleId);
    res.json({ ok: true, roles: rolesFor(userId) });
  });

  app.post('/api/admin/manage/nick', auth, ownerOnly, (req, res) => {
    const userId = String(req.body.userId || ''), nick = String(req.body.nick || '').trim();
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return res.status(404).json({ error: 'Игрок не найден' });
    if (nick.length < 2 || nick.length > 32) return res.status(400).json({ error: 'Ник должен быть от 2 до 32 символов' });
    if (db.prepare('SELECT 1 FROM users WHERE lower(nick)=? AND id<>?').get(nick.toLowerCase(), userId)) return res.status(400).json({ error: 'Этот ник уже занят другим игроком' });
    db.prepare('UPDATE users SET nick=? WHERE id=?').run(nick, userId);
    res.json({ ok: true });
  });

  // ---------- блокировки ----------
  // Заблокированный игрок видит разделы, но любые действия (POST/PATCH/DELETE) сервер ему не разрешает.
  const plural = (n, a, b, c) => { const m = n % 100, d = n % 10; return m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c; };
  const durationText = min => {
    if (min == null) return 'навсегда';
    if (min % 1440 === 0) { const d = min / 1440; return `${d} ${plural(d, 'день', 'дня', 'дней')}`; }
    if (min % 60 === 0) { const h = min / 60; return `${h} ${plural(h, 'час', 'часа', 'часов')}`; }
    return `${min} мин.`;
  };

  app.post('/api/admin/manage/ban', auth, ownerOnly, (req, res) => {
    const userId = String(req.body.userId || ''), reason = String(req.body.reason || '').trim().slice(0, 200);
    const minutes = req.body.minutes === null || req.body.minutes === 'forever' ? null : parseInt(req.body.minutes, 10);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return res.status(404).json({ error: 'Игрок не найден' });
    if (app.locals.isOwnerId(userId)) return res.status(400).json({ error: 'Владельца заблокировать нельзя' });
    if (reason.length < 3) return res.status(400).json({ error: 'Укажите причину (минимум 3 символа)' });
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600)) return res.status(400).json({ error: 'Некорректный срок' });
    const now = Date.now();
    db.transaction(() => {
      db.prepare('UPDATE bans SET lifted=1 WHERE user_id=? AND lifted=0').run(userId); // новая блокировка заменяет старую
      db.prepare('INSERT INTO bans(user_id, by_user_id, reason, minutes, created, expires_at) VALUES(?,?,?,?,?,?)')
        .run(userId, req.user.id, reason, minutes, now, minutes === null ? null : now + minutes * 60000);
    })();
    app.locals.notify(userId, `Ваш аккаунт заблокирован на срок: ${durationText(minutes)}. Причина: ${reason}.`);
    res.json({ ok: true });
  });

  app.post('/api/admin/manage/unban', auth, ownerOnly, (req, res) => {
    const userId = String(req.body.userId || '');
    const r = db.prepare('UPDATE bans SET lifted=1 WHERE user_id=? AND lifted=0').run(userId);
    if (!r.changes) return res.status(400).json({ error: 'Игрок не заблокирован' });
    app.locals.notify(userId, 'Блокировка вашего аккаунта снята.');
    res.json({ ok: true });
  });

  return { rolesFor };
};
