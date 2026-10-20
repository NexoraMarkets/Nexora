// OreMarket uses the shared Nexora balance (bank cards + legacy OreMarket funds).
// All purchases, sales, transfers and profit calculations are performed server-side.
// Логика перенесена из исходного браузерного макета (index.html / admin.html) без изменений.
const crypto = require('crypto');

const MAX_PER_MARKET = 20;               // лимит акций игрока на один рынок
const r2 = n => Math.round(n * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

module.exports = function registerOreMarket(app, db, auth, ownerOnly) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS om_markets(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, server TEXT, share_price REAL NOT NULL DEFAULT 10,
      profit_percent REAL NOT NULL DEFAULT 1, max_shares INTEGER NOT NULL DEFAULT 20, logo_data TEXT
    );
    CREATE TABLE IF NOT EXISTS om_records(
      id TEXT PRIMARY KEY, market_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL, note TEXT, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS om_accounts(user_id TEXT PRIMARY KEY, balance REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS om_lots(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, market_id TEXT NOT NULL, shares INTEGER NOT NULL, purchase_price REAL NOT NULL,
      profit_checkpoint REAL NOT NULL DEFAULT 0, purchase_date TEXT NOT NULL, profit_mode TEXT NOT NULL DEFAULT 'checkpoint',
      profit_percent REAL NOT NULL DEFAULT 1, source TEXT, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS om_grants(user_id TEXT NOT NULL, market_id TEXT NOT NULL, shares INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, market_id));
    CREATE TABLE IF NOT EXISTS om_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, market_id TEXT, operation TEXT NOT NULL,
      quantity INTEGER, principal REAL, profit_share REAL, total REAL, created INTEGER NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE om_markets ADD COLUMN logo_data TEXT'); } catch {}
  if (!db.prepare('SELECT COUNT(*) c FROM om_markets').get().c) {
    const ins = db.prepare('INSERT INTO om_markets(id, name, server, share_price, profit_percent) VALUES(?,?,?,?,?)');
    ins.run('survival', 'Казино', 'Основной сервер', 10, 1);
    ins.run('auction', 'Аукцион', 'Торговая площадка', 10, 1);
  }

  // ---------- расчёты ----------
  const marketOf = id => db.prepare('SELECT * FROM om_markets WHERE id=?').get(String(id || ''));
  const profitTotal = mid => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM om_records WHERE market_id=?').get(mid).s;
  const profitSince = (mid, date) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM om_records WHERE market_id=? AND date>=?').get(mid, date).s;
  const profitBefore = (mid, date) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM om_records WHERE market_id=? AND date<?').get(mid, date).s;
  const accrued = lot => Math.max(0, lot.profit_mode === 'date' ? profitSince(lot.market_id, lot.purchase_date) : profitTotal(lot.market_id) - lot.profit_checkpoint);
  const lotsOf = (uid, mid) => db.prepare('SELECT * FROM om_lots WHERE user_id=? AND market_id=? AND shares>0 ORDER BY rowid').all(uid, mid);
  const grantsOf = (uid, mid) => (db.prepare('SELECT shares FROM om_grants WHERE user_id=? AND market_id=?').get(uid, mid) || { shares: 0 }).shares;
  const boughtOf = (uid, mid) => lotsOf(uid, mid).reduce((n, l) => n + l.shares, 0);
  const walletBalance = uid => (db.prepare('SELECT balance FROM om_accounts WHERE user_id=?').get(uid) || { balance: 0 }).balance;
  const cardsOf = uid => db.prepare('SELECT * FROM cards WHERE user_id=? ORDER BY id').all(uid);
  // Единый доступный баланс: кошелёк OreMarket и остатки на картах Nexora.
  const balanceOf = uid => r2(walletBalance(uid) + cardsOf(uid).reduce((n, c) => n + Number(c.balance || 0), 0));
  const setBalance = (uid, b) => db.prepare('INSERT INTO om_accounts(user_id, balance) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET balance=excluded.balance').run(uid, r2(b));
  function debitBalance(uid, amount, note) {
    let left = r2(amount), wallet = walletBalance(uid), fromWallet = Math.min(wallet, left);
    if (fromWallet > 0) { setBalance(uid, wallet - fromWallet); left = r2(left - fromWallet); }
    for (const card of cardsOf(uid)) {
      if (left <= 0) break;
      const take = Math.min(Number(card.balance) || 0, left);
      if (!take) continue;
      db.prepare('UPDATE cards SET balance=balance-? WHERE id=?').run(take, card.id);
      db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(card.id, -take, note, Date.now());
      left = r2(left - take);
    }
    return left <= 0;
  }
  function creditBalance(uid, amount, note) {
    const card = cardsOf(uid)[0];
    if (!card) { setBalance(uid, walletBalance(uid) + amount); return; }
    db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(amount, card.id);
    db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(card.id, amount, note, Date.now());
  }
  const limitOf = m => Math.min(MAX_PER_MARKET, m.max_shares || MAX_PER_MARKET);
  const history = (uid, mid, op, qty, principal, profit, total) =>
    db.prepare('INSERT INTO om_history(user_id, market_id, operation, quantity, principal, profit_share, total, created) VALUES(?,?,?,?,?,?,?,?)')
      .run(uid, mid, op, qty, principal, profit, total, Date.now());

  // продажа идёт из самых старых лотов (FIFO): возвращается цена покупки + доля прибыли
  function quoteSale(uid, mid, qty) {
    let left = qty, principal = 0, profit = 0;
    for (const lot of lotsOf(uid, mid)) {
      if (left <= 0) break;
      const take = Math.min(left, lot.shares);
      principal += take * lot.purchase_price;
      profit += accrued(lot) * take * lot.profit_percent / 100;
      left -= take;
    }
    return { principal: r2(principal), profit: r2(profit), total: r2(principal + profit) };
  }

  const lotView = l => ({
    id: l.id, shares: l.shares, purchasePrice: l.purchase_price, profitCheckpoint: l.profit_checkpoint, purchaseDate: l.purchase_date,
    profitMode: l.profit_mode, profitPercent: l.profit_percent, source: l.source
  });
  const marketView = m => ({ id: m.id, name: m.name, server: m.server, sharePrice: m.share_price, profitPercent: m.profit_percent, maxShares: m.max_shares, logoData: m.logo_data || null });
  const userByNick = nick => db.prepare('SELECT * FROM users WHERE lower(nick)=?').get(String(nick || '').trim().toLowerCase());
  const nameOf = u => (u && (u.nick || u.display || u.username)) || 'Игрок';

  // ---------- игрок ----------
  app.get('/api/om/state', auth, (req, res) => {
    const u = req.user;
    if (!u.nick) return res.json({ needsNick: true });
    const holdings = {}, grants = {};
    for (const l of db.prepare('SELECT * FROM om_lots WHERE user_id=? AND shares>0 ORDER BY rowid').all(u.id)) (holdings[l.market_id] ||= []).push(lotView(l));
    for (const g of db.prepare('SELECT market_id, shares FROM om_grants WHERE user_id=? AND shares>0').all(u.id)) grants[g.market_id] = g.shares;
    res.json({
      nick: u.nick, balance: balanceOf(u.id), banned: !!u.ban, ban: u.ban, today: dayKey(new Date()),
      isOwner: u.isOwner,
      markets: db.prepare('SELECT * FROM om_markets ORDER BY rowid').all().map(marketView),
      // публичная статистика прибыли: без комментариев админа
      records: db.prepare('SELECT market_id, amount, date FROM om_records').all().map(r => ({ marketId: r.market_id, amount: r.amount, date: r.date })),
      holdings, grants
    });
  });

  app.post('/api/om/buy', auth, (req, res) => {
    const m = marketOf(req.body.marketId), qty = parseInt(req.body.qty, 10), u = req.user;
    if (!m) return res.status(404).json({ error: 'Рынок не найден' });
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Укажите количество акций' });
    const limit = limitOf(m);
    if (boughtOf(u.id, m.id) + grantsOf(u.id, m.id) + qty > limit) return res.status(400).json({ error: `Лимит игрока - ${limit} акций на рынок` });
    const cost = r2(qty * m.share_price);
    if (balanceOf(u.id) + 1e-9 < cost) return res.status(400).json({ error: 'Недостаточно АР на общем балансе Nexora' });
    db.transaction(() => {
      if (!debitBalance(u.id, cost, `OreMarket: покупка ${qty} акц.`)) throw new Error('Недостаточно АР на общем балансе Nexora');
      db.prepare(`INSERT INTO om_lots(id, user_id, market_id, shares, purchase_price, profit_checkpoint, purchase_date, profit_mode, profit_percent, source, created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), u.id, m.id, qty, m.share_price, profitTotal(m.id), dayKey(new Date()), 'checkpoint', m.profit_percent, 'purchase', Date.now());
      history(u.id, m.id, 'buy', qty, null, null, cost);
    })();
    res.json({ ok: true, qty, cost, balance: balanceOf(u.id) });
  });

  app.post('/api/om/sell', auth, (req, res) => {
    const m = marketOf(req.body.marketId), qty = parseInt(req.body.qty, 10), u = req.user;
    if (!m) return res.status(404).json({ error: 'Рынок не найден' });
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Укажите количество акций' });
    if (boughtOf(u.id, m.id) < qty) return res.status(400).json({ error: 'Можно продать только ранее купленные акции' });
    const quote = quoteSale(u.id, m.id, qty);
    db.transaction(() => {
      let left = qty;
      for (const lot of lotsOf(u.id, m.id)) {
        if (left <= 0) break;
        const take = Math.min(left, lot.shares);
        db.prepare('UPDATE om_lots SET shares=shares-? WHERE id=?').run(take, lot.id);
        left -= take;
      }
      db.prepare('DELETE FROM om_lots WHERE shares<=0').run();
      creditBalance(u.id, quote.total, `OreMarket: продажа ${qty} акц.`);
      history(u.id, m.id, 'sell', qty, quote.principal, quote.profit, quote.total);
    })();
    res.json({ ok: true, qty, ...quote, balance: balanceOf(u.id) });
  });

  // Пополнение: АР с карты банка -> на баланс OreMarket (вместо тикета в Discord)
  app.post('/api/om/deposit', auth, (req, res) => {
    const amount = parseInt(req.body.amount, 10), u = req.user;
    if (!Number.isInteger(amount) || amount < 1 || amount > 1e7) return res.status(400).json({ error: 'Укажите сумму пополнения' });
    const card = db.prepare('SELECT * FROM cards WHERE id=? AND user_id=?').get(req.body.card, u.id);
    if (!card) return res.status(404).json({ error: 'Выберите карту' });
    if (card.balance < amount) return res.status(400).json({ error: 'Недостаточно АР на карте' });
    db.transaction(() => {
      db.prepare('UPDATE cards SET balance=balance-? WHERE id=?').run(amount, card.id);
      db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(card.id, -amount, 'OreMarket: пополнение баланса', Date.now());
      setBalance(u.id, walletBalance(u.id) + amount);
      history(u.id, null, 'deposit', null, null, null, amount);
    })();
    res.json({ ok: true, balance: balanceOf(u.id) });
  });

  // Вывод: баланс OreMarket -> на карту банка (только целые АР)
  app.post('/api/om/withdraw', auth, (req, res) => {
    const amount = parseInt(req.body.amount, 10), u = req.user;
    if (!Number.isInteger(amount) || amount < 1) return res.status(400).json({ error: 'Укажите сумму вывода' });
    const card = db.prepare('SELECT * FROM cards WHERE id=? AND user_id=?').get(req.body.card, u.id);
    if (!card) return res.status(404).json({ error: 'Выберите карту' });
    if (amount > Math.floor(balanceOf(u.id) + 1e-9)) return res.status(400).json({ error: 'Недостаточно АР на общем балансе Nexora' });
    db.transaction(() => {
      if (!debitBalance(u.id, amount, 'OreMarket: перевод на карту')) throw new Error('Недостаточно АР на общем балансе Nexora');
      db.prepare('UPDATE cards SET balance=balance+? WHERE id=?').run(amount, card.id);
      db.prepare('INSERT INTO tx(card_id, amount, note, created) VALUES(?,?,?,?)').run(card.id, amount, 'OreMarket: перевод на карту', Date.now());
      history(u.id, null, 'withdraw', null, null, null, amount);
    })();
    res.json({ ok: true, balance: balanceOf(u.id) });
  });

  // ---------- админ (владельцы) ----------
  app.get('/api/om/admin/state', auth, ownerOnly, (req, res) => {
    const uids = db.prepare('SELECT user_id FROM om_lots WHERE shares>0 UNION SELECT user_id FROM om_grants WHERE shares>0').all().map(r => r.user_id);
    const players = {};
    for (const uid of uids) {
      const name = nameOf(db.prepare('SELECT * FROM users WHERE id=?').get(uid));
      const p = players[name] = { nickname: name, holdings: {}, grants: {} };
      for (const l of db.prepare('SELECT * FROM om_lots WHERE user_id=? AND shares>0 ORDER BY rowid').all(uid)) (p.holdings[l.market_id] ||= []).push(lotView(l));
      for (const g of db.prepare('SELECT market_id, shares FROM om_grants WHERE user_id=? AND shares>0').all(uid)) p.grants[g.market_id] = g.shares;
    }
    res.json({
      today: dayKey(new Date()), players,
      markets: db.prepare('SELECT * FROM om_markets ORDER BY rowid').all().map(marketView),
      records: db.prepare('SELECT id, market_id, amount, date, note, created FROM om_records').all()
        .map(r => ({ id: r.id, marketId: r.market_id, amount: r.amount, date: r.date, note: r.note || '', createdAt: r.created }))
    });
  });

  app.post('/api/om/admin/market', auth, ownerOnly, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 50), server = String(req.body.server || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Введите название рынка' });
    db.prepare('INSERT INTO om_markets(id, name, server, share_price, profit_percent) VALUES(?,?,?,?,?)').run('market-' + Date.now(), name, server, 10, 1);
    res.json({ ok: true });
  });

  app.delete('/api/om/admin/market/:id', auth, ownerOnly, (req, res) => {
    const id = String(req.params.id || ''), market = marketOf(id);
    if (!market) return res.status(404).json({ error: 'Рынок не найден' });
    const bought = db.prepare('SELECT COALESCE(SUM(shares),0) AS n FROM om_lots WHERE market_id=? AND shares>0').get(id).n;
    const granted = db.prepare('SELECT COALESCE(SUM(shares),0) AS n FROM om_grants WHERE market_id=? AND shares>0').get(id).n;
    if (bought || granted) return res.status(409).json({ error: 'Сначала сними или отзови все активные акции этого рынка' });
    db.transaction(() => {
      db.prepare('DELETE FROM om_records WHERE market_id=?').run(id);
      db.prepare('DELETE FROM om_lots WHERE market_id=?').run(id);
      db.prepare('DELETE FROM om_grants WHERE market_id=?').run(id);
      db.prepare('DELETE FROM om_history WHERE market_id=?').run(id);
      db.prepare('DELETE FROM om_markets WHERE id=?').run(id);
    })();
    res.json({ ok: true, name: market.name });
  });

  app.post('/api/om/admin/market-logo', auth, ownerOnly, (req, res) => {
    const marketId = String(req.body.marketId || ''), logoData = String(req.body.logoData || '');
    const market = marketOf(marketId);
    if (!market) return res.status(404).json({ error: 'Рынок не найден' });
    const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(logoData);
    if (!match || logoData.length > 512 * 1024) return res.status(400).json({ error: 'Загрузите изображение JPG, PNG, GIF или WebP' });
    const image = Buffer.from(match[1], 'base64');
    if (image.length < 16 || image.length > 256 * 1024 || image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP') {
      return res.status(400).json({ error: 'Не удалось обработать изображение' });
    }
    db.prepare('UPDATE om_markets SET logo_data=? WHERE id=?').run(logoData, marketId);
    res.json({ ok: true });
  });

  app.post('/api/om/admin/price', auth, ownerOnly, (req, res) => {
    const m = marketOf(req.body.marketId), price = Number(req.body.price);
    if (!m) return res.status(404).json({ error: 'Рынок не найден' });
    if (!Number.isFinite(price) || price <= 0 || price > 1e9) return res.status(400).json({ error: 'Укажите цену больше нуля' });
    db.prepare('UPDATE om_markets SET share_price=? WHERE id=?').run(r2(price), m.id); // уже купленные акции сохраняют свою цену
    res.json({ ok: true });
  });

  app.post('/api/om/admin/record', auth, ownerOnly, (req, res) => {
    const m = marketOf(req.body.marketId), amount = Number(req.body.amount), date = String(req.body.date || ''), note = String(req.body.note || '').trim().slice(0, 90);
    if (!m || !DATE_RE.test(date) || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e9) return res.status(400).json({ error: 'Проверь рынок, дату и сумму: укажи ненулевое значение от −1 000 000 000 до +1 000 000 000 АР' });
    db.prepare('INSERT INTO om_records(id, market_id, amount, date, note, created) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), m.id, r2(amount), date, note, Date.now());
    res.json({ ok: true });
  });

  // Выдать акции игроку: purchase - записать покупку (можно продать, баланс не списывается), grant - бонус (продать нельзя)
  app.post('/api/om/admin/issue', auth, ownerOnly, (req, res) => {
    const target = userByNick(req.body.nick), m = marketOf(req.body.marketId), shares = parseInt(req.body.shares, 10);
    const today = dayKey(new Date()), date = DATE_RE.test(String(req.body.date || '')) ? req.body.date : today, mode = req.body.mode === 'grant' ? 'grant' : 'purchase';
    if (!target) return res.status(404).json({ error: 'Игрок с таким ником не найден (он должен войти на сайт и указать ник)' });
    if (!m || !Number.isInteger(shares) || shares < 1) return res.status(400).json({ error: 'Проверь рынок и количество' });
    if (boughtOf(target.id, m.id) + grantsOf(target.id, m.id) + shares > limitOf(m)) return res.status(400).json({ error: `Лимит игрока - ${limitOf(m)} акций на рынок` });
    db.transaction(() => {
      if (mode === 'grant') {
        db.prepare(`INSERT INTO om_grants(user_id, market_id, shares) VALUES(?,?,?) ON CONFLICT(user_id, market_id) DO UPDATE SET shares=shares+excluded.shares`).run(target.id, m.id, shares);
      } else {
        const profitMode = date < today ? 'date' : 'checkpoint';
        const checkpoint = profitMode === 'date' ? profitBefore(m.id, date) : profitTotal(m.id);
        db.prepare(`INSERT INTO om_lots(id, user_id, market_id, shares, purchase_price, profit_checkpoint, purchase_date, profit_mode, profit_percent, source, created)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), target.id, m.id, shares, m.share_price, checkpoint, date, profitMode, m.profit_percent, 'admin-issued', Date.now());
      }
      history(target.id, m.id, mode === 'grant' ? 'admin-grant' : 'admin-issued', shares, null, null, null);
    })();
    res.json({ ok: true, player: nameOf(target) });
  });

  // Снять акции: сначала бонусные, потом купленные начиная с самых новых
  app.post('/api/om/admin/revoke', auth, ownerOnly, (req, res) => {
    const target = userByNick(req.body.nick), m = marketOf(req.body.marketId), requested = Math.max(1, parseInt(req.body.count, 10) || 1);
    if (!target || !m) return res.status(404).json({ error: 'Игрок или рынок не найден' });
    db.transaction(() => {
      let remaining = requested;
      const granted = grantsOf(target.id, m.id), takeGrant = Math.min(granted, remaining);
      if (takeGrant) { db.prepare('UPDATE om_grants SET shares=shares-? WHERE user_id=? AND market_id=?').run(takeGrant, target.id, m.id); remaining -= takeGrant; }
      for (const lot of lotsOf(target.id, m.id).reverse()) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lot.shares);
        db.prepare('UPDATE om_lots SET shares=shares-? WHERE id=?').run(take, lot.id);
        remaining -= take;
      }
      db.prepare('DELETE FROM om_lots WHERE shares<=0').run();
      db.prepare('DELETE FROM om_grants WHERE shares<=0').run();
    })();
    res.json({ ok: true });
  });
};
