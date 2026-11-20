const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { workspace, required, fail } = require('./workspace');

const root = path.resolve(__dirname, '..');
const assets = new Set(['index.html', 'app.js', 'dashboard.css', 'styles.css', 'fixes.css', 'pages.css', 'modern.css',
  'responsive-fixes.css', 'workspace.css', 'assets/smartlearning-logo.png', 'assets/learning-studio.webp', 'assets/teaching-studio.webp']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
const roles = new Set(['admin', 'teacher', 'student']);

function hash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 32).toString('hex');
}

function matches(password, digest) {
  const [salt, key] = digest.split(':');
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(key, 'hex'));
}

async function readBody(req) {
  if (req.method !== 'POST') return {};
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) fail(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    fail(400, 'Invalid JSON request.');
  }
}

function createServer({ file, seed = path.join(__dirname, 'data.json'), adminPassword, cloudApi }) {
  if (!cloudApi) fs.mkdirSync(path.dirname(file), { recursive: true });
  function save(data) {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  let data = cloudApi ? null : JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : seed, 'utf8'));
  for (const account of data?.users || []) {
    if (account.password) {
      const password = account.role === 'admin' ? adminPassword : undefined;
      if (account.role !== 'admin' || password) account.passwordHash = hash(password || account.password);
      delete account.password;
    }
    if (account.role === 'admin' && !account.passwordHash && adminPassword) account.passwordHash = hash(adminPassword);
  }
  if (data) save(data);
  const sessions = new Map();
  const attempts = new Map();
  const publicUser = ({ email, role, name }) => ({ email, role, name });

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const route = new URL(req.url, 'http://localhost').pathname;
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (!route.startsWith('/api/')) {
        const asset = route.slice(1);
        const page = route === '/' || /^\/(login|register|(?:admin|teacher|student)\/dashboard)$/.test(route);
        if (req.method !== 'GET' || (!page && !assets.has(asset))) return send(404, { error: 'Not found.' });
        const relative = page ? 'index.html' : asset;
        res.writeHead(200, { 'Content-Type': types[path.extname(relative)] });
        return res.end(fs.readFileSync(path.join(root, relative)));
      }
      if (req.method === 'GET' && route === '/api/health') return send(200, { ok: true, mode: cloudApi ? 'supabase' : 'local' });
      const body = await readBody(req);
      if (cloudApi) {
        const result = await cloudApi(req, route, body);
        return send(result.status, result.value);
      }
      if (req.method === 'POST' && ['/api/login', '/api/register'].includes(route)) {
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        for (const [key, value] of sessions) if (value.until <= now) sessions.delete(key);
        const ip = req.socket.remoteAddress;
        const limit = attempts.get(ip) || { count: 0, until: now + 60000 };
        attempts.set(ip, limit);
        if (++limit.count > 25) fail(429, 'Too many attempts. Try again in a minute.');
        const email = required(body.email, 'Email', 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
        const password = typeof body.password === 'string' ? body.password : '';
        const account = data.users.find(item => item.email === email);
        if (route === '/api/register') {
          if (password.length < 12 || password.length > 128) fail(400, 'Use a password of 12–128 characters.');
        if (account) fail(409, 'An account already exists for this email.');
          const role = body.teacher === true ? 'teacher' : 'student';
        const next = structuredClone(data);
        next.users.push({ email, passwordHash: hash(password), name: required(body.name, 'Name'), role, pending: role === 'teacher' });
        save(next);
        data = next;
          return send(201, { pending: role === 'teacher' });
        }
        if (!account?.passwordHash || !password || password.length > 128 || !matches(password, account.passwordHash))
          fail(401, 'Invalid email or password.');
        if (account.pending || account.suspended) fail(403, 'This account is pending approval or suspended.');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { email, until: now + 8 * 60 * 60 * 1000 });
        return send(200, { token, user: publicUser(account) });
      }
      const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1];
      const session = sessions.get(token);
      const account = session && session.until > Date.now() && data.users.find(item => item.email === session.email);
      if (!account || account.pending || account.suspended || !roles.has(account.role)) fail(401, 'Sign in to continue.');
      if (req.method === 'POST' && route === '/api/logout') {
        sessions.delete(token);
        return send(200, { ok: true });
      }
      const next = req.method === 'GET' ? data : structuredClone(data);
      const { status, value, changed } = workspace(next, publicUser(account), req.method, route, body);
      if (changed) {
        save(next);
        data = next;
        if (route === '/api/users/suspension' && body.suspended) {
          for (const [key, session] of sessions) if (session.email === body.email) sessions.delete(key);
        }
      }
      send(status, value);
    } catch (error) {
      if (!error.status) console.error(error.message);
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Request failed.' });
      else res.destroy();
    }
  });
}

if (require.main === module) {
  const production = process.env.NODE_ENV === 'production';
  const cloudApi = process.env.SUPABASE_URL || production
    ? require('./supabase-api').createSupabaseApi({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY })
    : undefined;
  const port = Number(process.env.PORT || process.env.SMARTLEARNING_API_PORT || 8787);
  const adminPassword = process.env.SMARTLEARNING_ADMIN_PASSWORD;
  if (adminPassword && (adminPassword.length < 12 || adminPassword.length > 128))
    throw new Error('SMARTLEARNING_ADMIN_PASSWORD must have 12–128 characters.');
  createServer({ file: path.resolve(process.env.SMARTLEARNING_DATA_FILE || 'work/local-data.json'), adminPassword, cloudApi })
    .listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log('SmartLearningSpace listening on port ' + port));
}

module.exports = { createServer };
