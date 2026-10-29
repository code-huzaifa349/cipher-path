'use strict';
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite'); // built in from Node 22.13

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------- Database ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path_id TEXT NOT NULL,
    steps INTEGER NOT NULL,
    PRIMARY KEY (user_id, path_id)
  );
`);

const q = {
  session: db.prepare('SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byName: db.prepare('SELECT id FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, email, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
  updateProfile: db.prepare('UPDATE users SET username = ?, email = ? WHERE id = ?'),
  updatePass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  dropOthers: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  dropExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  progress: db.prepare('SELECT path_id, steps FROM progress WHERE user_id = ?'),
  step: db.prepare('INSERT INTO progress (user_id, path_id, steps) VALUES (?, ?, 1) ON CONFLICT (user_id, path_id) DO UPDATE SET steps = MIN(steps + 1, ?)'),
  stepsOf: db.prepare('SELECT steps FROM progress WHERE user_id = ? AND path_id = ?'),
};
q.dropExpired.run(Date.now());
setInterval(() => q.dropExpired.run(Date.now()), 60 * 60 * 1000).unref();

/* ---------- Content catalogue (id, title, level, steps) ---------- */
const PATHS = [
  ['foundations', 'Security Foundations', 'Easy', 6],
  ['networking', 'Networking Primer', 'Easy', 5],
  ['soc-1', 'SOC Analyst Level 1', 'Easy', 8],
  ['junior-pt', 'Junior Pen Tester', 'Intermediate', 8],
  ['web-pentest', 'Web App Pentesting', 'Intermediate', 7],
  ['ai-security', 'AI Security Basics', 'Intermediate', 5],
  ['cloud-eng', 'Secure Cloud Engineering', 'Intermediate', 7],
  ['red-team', 'Red Team Operations', 'Hard', 9],
].map(([id, title, level, steps]) => ({ id, title, level, steps }));

/* ---------- Security helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = async (pw) => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
};
const checkPw = async (pw, stored) => {
  const [salt, key] = stored.split(':');
  const derived = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(derived, Buffer.from(key, 'hex'));
};
// Used so a login for an unknown email costs the same time as a real one.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync('x', salt, 64).toString('hex')}`;
})();

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
);
const tokenOf = (req) => parseCookies(req.headers.cookie).sid || '';
const currentUser = (req) => {
  const token = tokenOf(req);
  return token ? q.session.get(sha(token), Date.now()) || null : null;
};
const startSession = (res, userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(sha(token), userId, Date.now() + SESSION_MS);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_MS, path: '/' });
};

const str = (v) => (typeof v === 'string' ? v : '');
const rules = {
  username: (v) => (/^[A-Za-z0-9_]{3,20}$/.test(v) ? null : 'Username must be 3 to 20 letters, numbers or underscores.'),
  email: (v) => (v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'Enter an email in the format name@example.com.'),
  password: (v) => (v.length >= 10 && v.length <= 128 ? null : 'Password must be 10 to 128 characters.'),
};
const firstError = (fields) => {
  for (const [key, value] of Object.entries(fields)) {
    const message = rules[key](value);
    if (message) return [key, message];
  }
  return null;
};
const fail = (res, status, error, field) => res.status(status).json({ error, field });

const hits = new Map();
setInterval(() => hits.clear(), 15 * 60 * 1000).unref();
const rateLimit = (max) => (req, res, next) => {
  const key = `${req.ip}${req.path}`;
  const count = (hits.get(key) || 0) + 1;
  hits.set(key, count);
  if (count > max) return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
  next();
};
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const auth = (req, res, next) => {
  const user = currentUser(req);
  if (!user) return fail(res, 401, 'Please log in.');
  req.user = user;
  req.tokenHash = sha(tokenOf(req));
  next();
};

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '10kb' }));
// CSRF: cross-site forms cannot send this custom header, and we enable no CORS.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Requested-With') !== 'fetch') return fail(res, 403, 'Blocked request.');
  next();
});

app.post('/api/signup', rateLimit(10), wrap(async (req, res) => {
  const username = str(req.body.username).trim();
  const email = str(req.body.email).trim().toLowerCase();
  const password = str(req.body.password);
  const err = firstError({ username, email, password });
  if (err) return fail(res, 400, err[1], err[0]);
  if (q.byEmail.get(email)) return fail(res, 409, 'An account with this email already exists.', 'email');
  if (q.byName.get(username)) return fail(res, 409, 'That username is taken.', 'username');
  const { lastInsertRowid } = q.insertUser.run(username, email, await hashPw(password), Date.now());
  startSession(res, Number(lastInsertRowid));
  res.status(201).json({ ok: true });
}));

app.post('/api/login', rateLimit(10), wrap(async (req, res) => {
  const user = q.byEmail.get(str(req.body.email).trim().toLowerCase());
  const password = str(req.body.password);
  const valid = await checkPw(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !valid) return fail(res, 401, 'Email or password is incorrect.');
  startSession(res, user.id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  const token = tokenOf(req);
  if (token) q.dropSession.run(sha(token));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: { username: req.user.username, email: req.user.email } }));

app.patch('/api/me', auth, wrap(async (req, res) => {
  const username = str(req.body.username).trim();
  const email = str(req.body.email).trim().toLowerCase();
  const err = firstError({ username, email });
  if (err) return fail(res, 400, err[1], err[0]);
  if (!(await checkPw(str(req.body.password), q.byId.get(req.user.id).pass_hash))) return fail(res, 403, 'Current password is incorrect.', 'password');
  const emailOwner = q.byEmail.get(email);
  if (emailOwner && emailOwner.id !== req.user.id) return fail(res, 409, 'An account with this email already exists.', 'email');
  const nameOwner = q.byName.get(username);
  if (nameOwner && nameOwner.id !== req.user.id) return fail(res, 409, 'That username is taken.', 'username');
  q.updateProfile.run(username, email, req.user.id);
  res.json({ ok: true });
}));

app.post('/api/me/password', auth, rateLimit(10), wrap(async (req, res) => {
  const next = str(req.body.next);
  const err = firstError({ password: next });
  if (err) return fail(res, 400, err[1], 'next');
  if (!(await checkPw(str(req.body.current), q.byId.get(req.user.id).pass_hash))) return fail(res, 403, 'Current password is incorrect.', 'current');
  q.updatePass.run(await hashPw(next), req.user.id);
  q.dropOthers.run(req.user.id, req.tokenHash); // log out every other device
  res.json({ ok: true });
}));

app.delete('/api/me', auth, rateLimit(10), wrap(async (req, res) => {
  if (!(await checkPw(str(req.body.password), q.byId.get(req.user.id).pass_hash))) return fail(res, 403, 'Password is incorrect.', 'password');
  q.deleteUser.run(req.user.id); // sessions and progress cascade
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/paths', auth, (req, res) => {
  const done = new Map(q.progress.all(req.user.id).map((r) => [r.path_id, r.steps]));
  res.json({ paths: PATHS.map((p) => ({ ...p, done: done.get(p.id) || 0 })) });
});

app.post('/api/progress', auth, (req, res) => {
  const found = PATHS.find((p) => p.id === req.body.pathId);
  if (!found) return fail(res, 404, 'Unknown path.');
  q.step.run(req.user.id, found.id, found.steps);
  res.json({ done: q.stepsOf.get(req.user.id, found.id).steps });
});

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// Page-level gate; the API enforces auth independently.
app.get(['/dashboard.html', '/settings.html'], (req, res, next) => (currentUser(req) ? next() : res.redirect('/login.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.status(404).type('text').send('Page not found.'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid request.');
  if (/UNIQUE/.test(err.message)) return fail(res, 409, 'That email or username is already in use.');
  console.error(err);
  fail(res, 500, 'Server error. Try again.');
});

app.listen(PORT, () => console.log(`CipherPath running at http://localhost:${PORT}`));
