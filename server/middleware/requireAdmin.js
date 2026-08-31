// Пропускает дальше только администратора. Используется после middleware auth.js
module.exports = function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: "Это действие доступно только администратору" });
  }
  next();
};
