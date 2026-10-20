// Уведомления на сайте (колокольчик рядом с аватаркой). Создаются через app.locals.notify(userId, text).
module.exports = function registerNotifications(app, db, auth) {
  app.get('/api/notifications', auth, (req, res) => {
    const items = db.prepare('SELECT id, text, created, read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id);
    const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0').get(req.user.id).c;
    res.json({ unread, items });
  });

  // Прочитать уведомления можно даже при блокировке - это просмотр, а не действие
  app.post('/api/notifications/read', auth, (req, res) => {
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
    db.prepare('DELETE FROM notifications WHERE user_id=? AND id NOT IN (SELECT id FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100)')
      .run(req.user.id, req.user.id);
    res.json({ ok: true });
  });
};
