// Вывод предметов: игрок нажимает "Вывести", получает ячейку 1-15, админы получают пинг в Discord,
// выдают предмет в игре и подтверждают заказ на сайте - игроку приходит уведомление.
const crypto = require('crypto');
const { ITEMS } = require('./apps');

const CELLS = 15;      // номера ячеек: 1..15
const MAX_ACTIVE = 3;  // сколько заказов в работе может быть у одного игрока
const MAX_ITEMS = 27;  // сколько предметов можно вывести одним заказом (одна ячейка)
const ACTIVE = "status IN ('pending','ready')"; // pending - ждёт админа, ready - предмет в ячейке, ждёт игрока

async function sendDiscord(text) {
  const url = process.env.ORDERS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL, role = process.env.ADMIN_ROLE_ID;
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: (role ? `<@&${role}> ` : '') + text, allowed_mentions: { roles: role ? [role] : [] } }),
      signal: AbortSignal.timeout(5000)
    });
    return r.ok;
  } catch { return false; }
}

module.exports = function registerOrders(app, db, auth, ownerOnly) {
  db.exec(`CREATE TABLE IF NOT EXISTS orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, cell INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, updated INTEGER
  )`);

  // предметы заказа лежат отдельной таблицей: один заказ - одна ячейка - несколько предметов
  db.exec('CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item TEXT NOT NULL)');
  db.exec('INSERT INTO order_items(order_id, item) SELECT id, item FROM orders WHERE id NOT IN (SELECT DISTINCT order_id FROM order_items)');
  const itemsOf = id => db.prepare('SELECT item FROM order_items WHERE order_id=?').all(id).map(r => r.item).filter(k => ITEMS[k]);
  const summarize = list => {
    const m = new Map(); for (const k of list) m.set(k, (m.get(k) || 0) + 1);
    return [...m].map(([item, count]) => ({ item, count, pieces: count * (ITEMS[item].qty || 1) }));
  };
  const describe = sum => sum.map(x => `${ITEMS[x.item].name} ×${x.pieces}`).join(', ');
  const worth = sum => sum.reduce((a, x) => a + x.count * ITEMS[x.item].value, 0);
  const nameOf = u => u.nick || u.display || u.username || 'Игрок';
  const getUser = id => db.prepare('SELECT * FROM users WHERE id=?').get(id) || {};
  const view = (o, banned) => {
    const u = getUser(o.user_id);
    const items = summarize(itemsOf(o.id));
    return { id: o.id, items, value: worth(items), cell: o.cell, status: o.status, created: o.created, name: nameOf(u), banned: banned.has(o.user_id),
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=48` : null };
  };

  // Создать заказ: выбранные предметы уходят из инвентаря в заказ, игроку выдаётся одна свободная ячейка
  app.post('/api/orders', auth, async (req, res) => {
    try {
      const raw = Array.isArray(req.body.itemIds) ? req.body.itemIds : [req.body.itemId];
      const ids = [...new Set(raw.map(Number))].filter(Number.isInteger);
      if (!ids.length) return res.status(400).json({ error: 'Выберите предметы для вывода' });
      if (ids.length > MAX_ITEMS) return res.status(400).json({ error: `Не больше ${MAX_ITEMS} предметов в одном заказе` });
      const rows = db.prepare(`SELECT * FROM inventory WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(req.user.id, ...ids);
      if (rows.length !== ids.length || rows.some(r => !ITEMS[r.item])) return res.status(404).json({ error: 'Предмет не найден в инвентаре' });
      const mine = db.prepare(`SELECT COUNT(*) c FROM orders WHERE user_id=? AND ${ACTIVE}`).get(req.user.id).c;
      if (mine >= MAX_ACTIVE) return res.status(400).json({ error: `Не больше ${MAX_ACTIVE} активных заказов одновременно` });
      const busy = new Set(db.prepare(`SELECT cell FROM orders WHERE ${ACTIVE}`).all().map(r => r.cell));
      const free = Array.from({ length: CELLS }, (_, i) => i + 1).filter(c => !busy.has(c));
      if (!free.length) return res.status(400).json({ error: 'Все ячейки сейчас заняты, попробуйте позже' });
      const cell = free[crypto.randomInt(free.length)], now = Date.now();
      let id;
      db.transaction(() => {
        db.prepare(`DELETE FROM inventory WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
        id = db.prepare('INSERT INTO orders(user_id, item, cell, status, created, updated) VALUES(?,?,?,?,?,?)').run(req.user.id, rows[0].item, cell, 'pending', now, now).lastInsertRowid;
        for (const r of rows) db.prepare('INSERT INTO order_items(order_id, item) VALUES(?,?)').run(id, r.item);
      })();
      const sum = summarize(rows.map(r => r.item));
      const notified = await sendDiscord(`📦 Заказ на вывод #${id}: игрок **${nameOf(req.user)}** хочет вывести: ${describe(sum)} (на ${worth(sum)} АР). Ячейка: **${cell}**.`);
      res.json({ ok: true, id, cell, notified, items: sum });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось создать заказ' }); }
  });

  // Мои заказы
  app.get('/api/orders/mine', auth, (req, res) => {
    const banned = app.locals.bannedIds();
    res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 15').all(req.user.id).map(o => view(o, banned)));
  });

  // Все активные заказы - для владельцев (вкладка "Выдача")
  app.get('/api/orders', auth, ownerOnly, (req, res) => {
    const banned = app.locals.bannedIds();
    res.json(db.prepare(`SELECT * FROM orders WHERE ${ACTIVE} ORDER BY id ASC`).all().map(o => view(o, banned)));
  });

  const load = (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(parseInt(req.params.id, 10));
    if (!o) res.status(404).json({ error: 'Заказ не найден' });
    return o;
  };

  // Подтвердить заказ: предмет выдан в ячейку, игроку приходит уведомление
  app.post('/api/orders/:id/confirm', auth, ownerOnly, (req, res) => {
    const o = load(req, res); if (!o) return;
    if (db.prepare("UPDATE orders SET status='ready', updated=? WHERE id=? AND status='pending'").run(Date.now(), o.id).changes === 0)
      return res.status(400).json({ error: 'Заказ уже обработан' });
    app.locals.notify(o.user_id, `Ваш заказ #${o.id} готов к выдаче: ${describe(summarize(itemsOf(o.id)))}. Заберите предметы в ячейке №${o.cell}.`);
    res.json({ ok: true });
  });

  // Закрыть заказ: игрок забрал предмет, ячейка освобождается (владелец или сам игрок)
  app.post('/api/orders/:id/close', auth, (req, res) => {
    const o = load(req, res); if (!o) return;
    if (!req.user.isOwner && o.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    if (db.prepare("UPDATE orders SET status='done', updated=? WHERE id=? AND status='ready'").run(Date.now(), o.id).changes === 0)
      return res.status(400).json({ error: 'Заказ ещё не готов или уже закрыт' });
    res.json({ ok: true });
  });

  // Отменить заказ: предмет возвращается в инвентарь. Игрок - только пока заказ не подтверждён, владелец - в любой момент
  app.post('/api/orders/:id/cancel', auth, (req, res) => {
    const o = load(req, res); if (!o) return;
    const isOwner = !!req.user.isOwner;
    if (!isOwner && o.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
    if (!isOwner && o.status !== 'pending') return res.status(400).json({ error: 'Заказ уже подтверждён, отменить его может только администратор' });
    let changed = 0;
    db.transaction(() => {
      changed = db.prepare(`UPDATE orders SET status='cancelled', updated=? WHERE id=? AND ${ACTIVE}`).run(Date.now(), o.id).changes;
      if (changed) for (const k of itemsOf(o.id)) db.prepare('INSERT INTO inventory(user_id, item, created) VALUES(?,?,?)').run(o.user_id, k, Date.now());
    })();
    if (!changed) return res.status(400).json({ error: 'Заказ уже закрыт' });
    if (isOwner && o.user_id !== req.user.id) app.locals.notify(o.user_id, `Заказ #${o.id} (${describe(summarize(itemsOf(o.id)))}) отменён администратором. Предметы вернулись в инвентарь.`);
    res.json({ ok: true });
  });
};
