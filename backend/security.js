import { randomBytes } from 'node:crypto';

export function configuration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let secret = env.JWT_SECRET;
  if (!secret && !production) secret = randomBytes(48).toString('base64url');
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || /change.in.production|your.secret|example|placeholder/i.test(secret)) {
    throw new Error('Set JWT_SECRET to a fresh random secret of at least 32 bytes.');
  }
  const origins = (env.ALLOWED_ORIGINS || (production ? '' : 'http://localhost:3000,http://localhost:5173'))
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.some(value => {
    try { const url = new URL(value); return url.origin !== value || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:'); }
    catch { return true; }
  })) throw new Error('ALLOWED_ORIGINS must contain exact frontend origins (HTTPS in production).');
  return { secret, origins, production };
}
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function rateLimiter({ limit, windowMs, maxEntries = 10000 }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, entry] of clients) if (entry.until <= now) clients.delete(key);
    const key = req.user ? `user:${req.user.id}` : req.ip;
    let entry = clients.get(key);
    if (!entry) {
      if (clients.size >= maxEntries) return res.status(429).json({ error: 'Server busy. Try again shortly.' });
      entry = { count: 0, until: now + windowMs }; clients.set(key, entry);
    }
    if (++entry.count > limit) {
      res.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}
export function credentials(body, registration = false) {
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') throw httpError(400, 'Username and password must be text.');
  const username = body.username.trim(), password = body.password;
  if (!/^[\p{L}\p{N}_ .-]{3,32}$/u.test(username) || Buffer.byteLength(password) > 72 || password.length < (registration ? 8 : 1)) {
    throw httpError(400, 'Use a 3–32 character username and a password of 8–72 bytes when registering.');
  }
  let email;
  if (registration) {
    if (typeof body.email !== 'string') throw httpError(400, 'A valid email is required.');
    email = body.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A valid email is required.');
  }
  return { username, password, email };
}
export function cookieToken(req) {
  const entry = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('poke_session='));
  return entry ? entry.slice('poke_session='.length) : null;
}
