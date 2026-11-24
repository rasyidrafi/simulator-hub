import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createAndroid } from './android.mjs';

const { HUB_ADMIN_TOKEN: admin, HUB_STATE_DIR: dir, HUB_AVD: avd, PORT = '3000' } = process.env;
if (!admin || admin.length < 32 || !dir || !avd || !/^\d+$/.test(PORT) || Number(PORT) > 65535) {
  console.error('HUB_ADMIN_TOKEN (at least 32 characters), HUB_STATE_DIR, HUB_AVD and a valid PORT are required');
  process.exit(1);
}
await mkdir(dir, { recursive: true, mode: 0o700 });
const statePath = join(dir, 'tokens.json');
let tokens;
try { tokens = await Bun.file(statePath).json(); }
catch (error) { if (error.code !== 'ENOENT') throw error; tokens = []; }
if (!Array.isArray(tokens)) throw new Error('Invalid token state');
const hash = value => Bun.CryptoHasher.hash('sha256', value, 'hex');
const adminHash = hash(admin);
const id = () => randomBytes(16).toString('hex');
async function save(next) {
  const tmp = join(dir, `tokens.${process.pid}.${id()}.tmp`);
  await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
  await rename(tmp, statePath);
  tokens = next;
}
const android = createAndroid(avd);
let lease;
let queue = Promise.resolve();
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function authenticate(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
  if (!match) fail(401, 'Unauthorized');
  const digest = hash(match[1]);
  if (timingSafeEqual(Buffer.from(digest), Buffer.from(adminHash))) return { id: 'admin', role: 'admin' };
  const token = tokens.find(t => t.hash === digest);
  if (!token) fail(401, 'Unauthorized');
  return { id: token.id, name: token.name, role: 'client' };
}
function isAdmin(user) { if (user.role !== 'admin') fail(403, 'Admin required'); }
function activeLease() { if (lease && lease.expires <= Date.now()) lease = undefined; return lease; }
function ownedLease(req, user) {
  const current = activeLease();
  if (!current || req.headers.get('x-lease-id') !== current.id || current.owner !== user.id) fail(403, 'Valid owned lease required');
  return current;
}
async function body(req) {
  const data = await req.text();
  try { const value = JSON.parse(data); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail(400, 'Invalid JSON body'); }
}
function validateInput(value) {
  const coordinate = n => Number.isSafeInteger(n) && n >= 0;
  if (value.type === 'tap' && coordinate(value.x) && coordinate(value.y)) return;
  if (value.type === 'swipe' && ['x1', 'y1', 'x2', 'y2', 'duration'].every(k => coordinate(value[k]))) return;
  if (value.type === 'key' && ['HOME', 'BACK', 'ENTER'].includes(value.key)) return;
  fail(400, 'Invalid input');
}
function json(status, value) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
async function handle(req, path, parsedBody) {
  const user = authenticate(req);
  const method = req.method;
  if (method === 'GET' && path === '/v1/me') return json(200, user);
  if (path === '/v1/tokens' && method === 'GET') { isAdmin(user); return json(200, tokens.map(({ id, name }) => ({ id, name }))); }
  if (path === '/v1/tokens' && method === 'POST') {
    isAdmin(user);
    if (typeof parsedBody.name !== 'string' || !parsedBody.name.trim() || parsedBody.name.length > 256) fail(400, 'Invalid name');
    const token = randomBytes(32).toString('base64url');
    const entry = { id: id(), name: parsedBody.name, hash: hash(token) };
    await save([...tokens, entry]);
    return json(201, { id: entry.id, token });
  }
  const tokenMatch = /^\/v1\/tokens\/([a-f0-9]{32})$/.exec(path);
  if (tokenMatch && method === 'DELETE') {
    isAdmin(user);
    if (!tokens.some(t => t.id === tokenMatch[1])) fail(404, 'Token not found');
    await save(tokens.filter(t => t.id !== tokenMatch[1]));
    if (lease?.owner === tokenMatch[1]) lease = undefined;
    return json(200, { ok: true });
  }
  if (path === '/v1/device' && method === 'GET') return json(200, { status: await android.status() });
  if (path === '/v1/device/start' && method === 'POST') { isAdmin(user); await android.start(); return json(200, { ok: true }); }
  if (path === '/v1/device/stop' && method === 'POST') { isAdmin(user); await android.stop(); return json(200, { ok: true }); }
  if (path === '/v1/device/screenshot' && method === 'GET') {
    if (await android.status() !== 'ready') fail(409, 'Device not ready');
    const png = await android.screenshot();
    return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  }
  if (path === '/v1/lease' && method === 'POST') {
    if (activeLease()) fail(409, 'Lease already held');
    lease = { id: id(), owner: user.id, expires: Date.now() + 30000 };
    return json(201, { id: lease.id });
  }
  if (path === '/v1/lease' && method === 'PUT') { ownedLease(req, user).expires = Date.now() + 30000; return json(200, { ok: true }); }
  if (path === '/v1/lease' && method === 'DELETE') {
    if (user.role !== 'admin') ownedLease(req, user);
    lease = undefined; return json(200, { ok: true });
  }
  if (path === '/v1/device/input' && method === 'POST') {
    ownedLease(req, user); validateInput(parsedBody);
    if (await android.status() !== 'ready') fail(409, 'Device not ready');
    // The readiness probe may outlive the lease.
    ownedLease(req, user);
    await android.input(parsedBody); return json(200, { ok: true });
  }
  fail(404, 'Not found');
}
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(PORT), idleTimeout: 30, maxRequestBodySize: 16384,
  async fetch(req) {
    // Read request bodies outside the effects queue so slow clients cannot block it.
    const path = new URL(req.url).pathname;
    const parsedBody = req.method === 'POST' && (path === '/v1/tokens' || path === '/v1/device/input') ? await body(req) : {};
    const work = queue.then(() => handle(req, path, parsedBody));
    queue = work.then(() => {}, () => {});
    return work;
  },
  error(error) {
    if (!error.status) console.error(error);
    return json(error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});
console.log(`Simulator Hub listening on ${server.url.origin}`);
