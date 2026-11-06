import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken, TrackSource } from 'livekit-server-sdk';

const { ROOM_PASSWORD, SESSION_SECRET, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
for (const [name, value] of Object.entries({ ROOM_PASSWORD, SESSION_SECRET, LIVEKIT_API_KEY, LIVEKIT_API_SECRET })) {
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT ?? 3000);
const ROOM = 'porao';
const COOKIE = 'porao_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const DIST = fileURLToPath(new URL('./dist', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
};

const sha256 = (value) => createHash('sha256').update(value).digest();

// Keyed on the password too, so changing it logs everyone out.
const sessionKey = createHmac('sha256', SESSION_SECRET).update(ROOM_PASSWORD).digest();
const sign = (expires) => createHmac('sha256', sessionKey).update(String(expires)).digest('base64url');

function hasSession(req) {
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const [expires, signature] = cookie.slice(COOKIE.length + 1).split('.');
  if (!expires || !signature || Number(expires) < Date.now() / 1000) return false;
  return timingSafeEqual(sha256(signature), sha256(sign(expires)));
}

const failures = new Map();

// The app only listens on loopback behind Caddy, which replaces this header.
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',').pop().trim();

function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (entry && entry.resetAt < Date.now()) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
}

function recordFailure(ip) {
  const entry = failures.get(ip) ?? { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
  entry.count += 1;
  failures.set(ip, entry);
}

setInterval(() => {
  for (const [ip, entry] of failures) if (entry.resetAt < Date.now()) failures.delete(ip);
}, FAILURE_WINDOW_MS).unref();

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('body too large');
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  return parsed;
}

async function login(req, res) {
  const ip = clientIp(req);
  if (isLockedOut(ip)) return sendJson(res, 429, { error: 'Muitas tentativas. Tente de novo em alguns minutos.' });

  const { password } = await readJson(req);
  if (typeof password !== 'string' || !timingSafeEqual(sha256(password), sha256(ROOM_PASSWORD))) {
    recordFailure(ip);
    return sendJson(res, 401, { error: 'Senha errada.' });
  }

  failures.delete(ip);
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const cookie = `${COOKIE}=${expires}.${sign(expires)}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  sendJson(res, 200, { ok: true }, { 'set-cookie': cookie });
}

async function token(req, res) {
  if (!hasSession(req)) return sendJson(res, 401, { error: 'Você não está logado.' });

  const { name } = await readJson(req);
  const displayName = typeof name === 'string' ? name.replace(/\p{C}/gu, '').trim().slice(0, 24) : '';
  if (!displayName) return sendJson(res, 400, { error: 'Escolha um nome.' });

  const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: randomUUID(),
    name: displayName,
    ttl: '12h',
  });
  accessToken.addGrant({
    room: ROOM,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  sendJson(res, 200, { token: await accessToken.toJwt() });
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const file = join(DIST, relative);
  const isFile = file.startsWith(DIST + sep) && (await stat(file).catch(() => null))?.isFile();
  if (!isFile) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (route === 'POST /api/login') return await login(req, res);
    if (route === 'POST /api/token') return await token(req, res);
    if (route === 'GET /api/session') return sendJson(res, 200, { authenticated: hasSession(req) });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendJson(res, 405, { error: 'Método não permitido.' });
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const badInput = error instanceof SyntaxError || error instanceof URIError || /body too large|not an object/.test(error.message);
    if (!badInput) console.error(error);
    sendJson(res, badInput ? 400 : 500, { error: badInput ? 'Requisição inválida.' : 'Erro no servidor.' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`listening on 127.0.0.1:${PORT}`));
