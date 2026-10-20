// Приложения: кейсы и апгрейдер с предметами из Minecraft. Все расчёты только на сервере.
const crypto = require('crypto');

const FEE = 0.05;   // комиссия при пополнении апгрейдера с карты (5%)
const EDGE = 0.05;  // запас системы в апгрейдере: шанс = ставка / цена цели * (1 - EDGE)

const ITEMS = {
  dirt:      { name: 'Земля',               rarity: 'common',    value: 1, qty: 16 },
  cobble:    { name: 'Булыжник',            rarity: 'common',    value: 2, qty: 16 },
  bread:     { name: 'Хлеб',                rarity: 'common',    value: 3 },
  coal:      { name: 'Уголь',               rarity: 'common',    value: 4, qty: 16 },
  iron:      { name: 'Железный слиток',     rarity: 'uncommon',  value: 8, qty: 16 },
  redstone:  { name: 'Редстоун',            rarity: 'uncommon',  value: 10 },
  lapis:     { name: 'Лазурит',             rarity: 'uncommon',  value: 10 },
  gold:      { name: 'Золотой слиток',      rarity: 'uncommon',  value: 12, qty: 16 },
  goldapple: { name: 'Золотое яблоко',      rarity: 'rare',      value: 25 },
  emerald:   { name: 'Изумруд',             rarity: 'rare',      value: 35 },
  diamond:   { name: 'Алмаз',               rarity: 'rare',      value: 40 },
  dchest:    { name: 'Алмазный нагрудник',  rarity: 'epic',      value: 60 },
  dpick:     { name: 'Алмазная кирка',      rarity: 'epic',      value: 80 },
  dsword:    { name: 'Алмазный меч',        rarity: 'epic',      value: 90 },
  trident:   { name: 'Трезубец',            rarity: 'epic',      value: 150 },
  totem:     { name: 'Тотем бессмертия',    rarity: 'legendary', value: 250 },
  elytra:    { name: 'Элитры',              rarity: 'mythic',    value: 600 },
  // Утешительный приз кейса "Всё или ничего": картинка от тотема, цена 5 АР, выбрать целью в апгрейдере нельзя
  totem5:    { name: 'Тотем бессмертия',    rarity: 'common',    value: 5, tex: 'totem', noTarget: true }
};
// qty - сколько штук выдаётся в игре за один предмет при выводе (по умолчанию 1); цена в АР не меняется
// Картинки лежат в public/textures/<ключ>.png (кейсы - case_<ключ>.png)

// pool: предмет -> вес в сотых долях процента (всего 10000, т.е. 30 = 0.3%).
// Возврат кейса (RTP) должен быть ниже 100% - проверяется при запуске.
const CASES = [
  { key: 'wood',    name: 'Деревянный кейс', price: 3,
    desc: 'Простой кейс для начала: в основном дешёвые ресурсы, но с небольшим шансом выбить алмаз или изумруд.',
    pool: { dirt: 3000, cobble: 2800, bread: 2200, coal: 1500, iron: 400, gold: 80, diamond: 15, emerald: 5 } },
  { key: 'iron',    name: 'Железный кейс',   price: 10,
    desc: 'Больше руды и золота, а с редким шансом выпадает алмазная экипировка.',
    pool: { coal: 2400, iron: 2400, redstone: 1700, lapis: 1700, gold: 1300, goldapple: 300, emerald: 120, diamond: 60, dchest: 15, dpick: 4, dsword: 1 } },
  { key: 'gold',    name: 'Золотой кейс',    price: 50,
    desc: 'Здесь уже ценные предметы: золотые яблоки, изумруды и алмазы. С шансом 0,3% можно выбить элитры.',
    pool: { goldapple: 3510, emerald: 2600, diamond: 1900, dchest: 1000, dpick: 500, dsword: 300, trident: 120, totem: 40, elytra: 30 } },
  { key: 'diamond', name: 'Алмазный кейс',   price: 100,
    desc: 'Топовая экипировка: алмазные предметы, трезубец и тотем бессмертия. Элитры выпадают с шансом 0,3%.',
    pool: { diamond: 1500, dchest: 2300, dpick: 2300, dsword: 2200, trident: 1300, totem: 370, elytra: 30 } },
  { key: 'allin',   name: 'Всё или ничего',  price: 150,
    desc: 'Либо элитры, либо утешительный тотем за 5 АР. Шанс на элитры всего 1%.',
    pool: { totem5: 9900, elytra: 100 } }
];

const weightSum = c => Object.values(c.pool).reduce((a, b) => a + b, 0);
const rtp = c => Object.entries(c.pool).reduce((a, [k, w]) => a + ITEMS[k].value * w, 0) / weightSum(c) / c.price;
for (const c of CASES) if (weightSum(c) !== 10000) throw new Error(`Кейс ${c.key}: сумма весов должна быть 10000, сейчас ${weightSum(c)}`);
for (const c of CASES) if (rtp(c) >= 1) throw new Error(`Кейс ${c.key}: возврат ${Math.round(rtp(c) * 100)}% - должен быть меньше 100%`);

function pick(c) {
  let r = crypto.randomInt(weightSum(c));
  for (const [k, w] of Object.entries(c.pool)) { if (r < w) return k; r -= w; }
}

const parseIds = raw => [...new Set((Array.isArray(raw) ? raw : []).map(Number))].filter(Number.isInteger).slice(0, 200);

module.exports = function registerApps(app, db, auth) {
  db.exec(`CREATE TABLE IF NOT EXISTS inventory(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, created INTEGER
  )`);

  db.prepare("UPDATE inventory SET item='dchest' WHERE item='shield'").run(); // щит заменён нагрудником
  db.exec(`CREATE TABLE IF NOT EXISTS drops(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, value INTEGER NOT NULL,
    case_key TEXT, created INTEGER, visible_at INTEGER
  )`);
  const getCard = (id, uid) => db.prepare('SELECT * FROM cards WHERE id=? AND user_id=?').get(id, uid);
  const addTx = (cardId, amount, note) => db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(cardId, amount, note, Date.now());
  const ownedRows = (uid, ids) => ids.length
    ? db.prepare(`SELECT * FROM inventory WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(uid, ...ids) : [];

  app.get('/api/apps/catalog', auth, (req, res) => {
    res.json({
      fee: FEE, edge: EDGE,
      items: Object.entries(ITEMS).map(([key, it]) => ({ key, ...it, img: `/textures/${it.tex || key}.png` })),
      cases: CASES.map(c => ({
        key: c.key, name: c.name, desc: c.desc, img: `/textures/case_${c.key}.png`, price: c.price,
        pool: Object.entries(c.pool).map(([key, w]) => ({ key, chance: w / weightSum(c) * 100 }))
      }))
    });
  });

  app.get('/api/inventory', auth, (req, res) => {
    res.json(db.prepare('SELECT id, item FROM inventory WHERE user_id=? ORDER BY id DESC').all(req.user.id).filter(r => ITEMS[r.item]));
  });

  // Открытие 1-4 кейсов. Выпадение попадает в живую ленту только после конца анимации (visible_at),
  // иначе результат был бы виден в ленте раньше, чем докрутится рулетка.
  app.post('/api/cases/:key/open', auth, (req, res) => {
    const c = CASES.find(x => x.key === req.params.key);
    if (!c) return res.status(404).json({ error: 'Кейс не найден' });
    const count = Math.min(4, Math.max(1, parseInt(req.body.count, 10) || 1));
    const card = getCard(req.body.card, req.user.id);
    if (!card) return res.status(404).json({ error: 'Выберите карту' });
    const total = c.price * count;
    if (card.balance < total) return res.status(400).json({ error: `Недостаточно АР на карте (нужно ${total})` });
    const now = Date.now(), visibleAt = now + (req.body.fast ? 1500 : 6200);
    const items = [];
    db.transaction(() => {
      db.prepare('UPDATE cards SET balance=balance-? WHERE id=?').run(total, card.id);
      addTx(card.id, -total, `Кейс: ${c.name}${count > 1 ? ` x${count}` : ''}`);
      for (let i = 0; i < count; i++) {
        const item = pick(c);
        const id = db.prepare('INSERT INTO inventory(user_id, item, created) VALUES(?,?,?)').run(req.user.id, item, now).lastInsertRowid;
        db.prepare('INSERT INTO drops(user_id, item, value, case_key, created, visible_at) VALUES(?,?,?,?,?,?)')
          .run(req.user.id, item, ITEMS[item].value, c.key, now, visibleAt);
        items.push({ id, item });
      }
      db.prepare('DELETE FROM drops WHERE id <= (SELECT MAX(id) FROM drops) - 500').run();
    })();
    res.json({ ok: true, items, total });
  });

  // Живая лента: без since - последние 20 выпадений; с since - всё, что стало видимым после прошлого запроса
  app.get('/api/drops', auth, (req, res) => {
    const now = Date.now(), since = parseInt(req.query.since, 10) || 0;
    const base = `SELECT d.id, d.item, d.value, u.id AS uid, u.nick, u.display, u.username, u.avatar
      FROM drops d LEFT JOIN users u ON u.id=d.user_id`;
    const rows = since
      ? db.prepare(`${base} WHERE d.visible_at > ? AND d.visible_at <= ? ORDER BY d.visible_at ASC, d.id ASC LIMIT 50`).all(since, now)
      : db.prepare(`${base} WHERE d.visible_at <= ? ORDER BY d.visible_at DESC, d.id DESC LIMIT 20`).all(now);
    const banned = app.locals.bannedIds();
    res.json({
      now,
      drops: rows.filter(r => ITEMS[r.item]).map(r => ({ banned: banned.has(r.uid),
        id: r.id, item: r.item, value: r.value, name: r.nick || r.display || r.username || 'Игрок',
        avatar: r.avatar ? `https://cdn.discordapp.com/avatars/${r.uid}/${r.avatar}.png?size=48` : null
      }))
    });
  });

  app.post('/api/inventory/sell', auth, (req, res) => {
    const ids = parseIds(req.body.ids);
    const card = getCard(req.body.card, req.user.id);
    if (!card) return res.status(404).json({ error: 'Выберите карту для зачисления' });
    const rows = ownedRows(req.user.id, ids);
    if (!rows.length || rows.length !== ids.length) return res.status(400).json({ error: 'Предметы не найдены' });
    const total = rows.reduce((a, r) => a + ITEMS[r.item].value, 0);
    db.transaction(() => {
      db.prepare(`DELETE FROM inventory WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
      db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(total, card.id);
      addTx(card.id, total, `Продажа предметов: ${rows.length} шт.`);
    })();
    res.json({ ok: true, total });
  });

  // Апгрейдер: ставка = предметы + АР с карты (с комиссией). Шанс = ставка / цена цели * (1 - EDGE)
  app.post('/api/upgrader', auth, (req, res) => {
    const target = ITEMS[req.body.target];
    if (!target || target.noTarget) return res.status(400).json({ error: 'Выберите цель' });
    const ids = parseIds(req.body.ids);
    const deposit = parseInt(req.body.deposit || 0, 10);
    if (!Number.isInteger(deposit) || deposit < 0 || deposit > 1e7) return res.status(400).json({ error: 'Некорректная сумма пополнения' });
    const rows = ownedRows(req.user.id, ids);
    if (rows.length !== ids.length) return res.status(400).json({ error: 'Предмет не найден в инвентаре' });
    let card = null;
    if (deposit > 0) {
      card = getCard(req.body.card, req.user.id);
      if (!card) return res.status(404).json({ error: 'Выберите карту для пополнения' });
      if (card.balance < deposit) return res.status(400).json({ error: 'Недостаточно АР на карте' });
    }
    const net = Math.floor(deposit * (1 - FEE));
    const stake = rows.reduce((a, r) => a + ITEMS[r.item].value, 0) + net;
    if (stake < 1) return res.status(400).json({ error: 'Добавьте предметы или АР в ставку' });
    if (target.value <= stake) return res.status(400).json({ error: 'Цель должна быть дороже ставки' });
    const chance = Math.min(0.95, stake / target.value * (1 - EDGE));
    if (chance < 0.01) return res.status(400).json({ error: 'Шанс меньше 1% - выберите цель подешевле' });

    const roll = crypto.randomInt(0, 1000000) / 1000000;
    const success = roll < chance;
    let newId = null;
    db.transaction(() => {
      if (deposit > 0) {
        db.prepare('UPDATE cards SET balance=balance-? WHERE id=?').run(deposit, card.id);
        addTx(card.id, -deposit, `Апгрейдер: пополнение (комиссия ${deposit - net} АР)`);
      }
      if (ids.length) db.prepare(`DELETE FROM inventory WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
      if (success) newId = db.prepare('INSERT INTO inventory(user_id, item, created) VALUES(?,?,?)').run(req.user.id, req.body.target, Date.now()).lastInsertRowid;
    })();
    res.json({ ok: true, success, chance, roll, stake, item: success ? { id: newId, item: req.body.target } : null });
  });
};
module.exports.CASES = CASES; module.exports.ITEMS = ITEMS; module.exports.rtp = rtp;
