import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createAndroid } from './android.mjs';
import { loadDevices } from './registry.mjs';
import { createLive, openScrcpy } from './live.mjs';

export async function startHub(openCapture) {
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
const targets = new Map();
let queue = Promise.resolve();
function ordered(fn){const work=queue.then(async()=>{for(const t of targets.values())await t.expire();return fn()});queue=work.catch(()=>{});return work}
function target(device) {
const {id:deviceId, name, serial} = device;
const android = createAndroid(device);
const peers=new Set();
const sendPacket=(ws,packet)=>{if(ws.getBufferedAmount()>1500000||ws.sendBinary(packet)===0)ws.close(1013,'Viewer behind')};
const live = createLive(()=> (openCapture || openScrcpy)(serial),p=>{for(const ws of peers)sendPacket(ws,p)},()=>{for(const ws of peers)ws.close(1012,'Capture ended')},()=>ordered(async()=>{if(lease?.contact)await endLease()}));
// A contact belongs to one viewer, even when several panels share a client token.
async function endLease(){const old=lease;lease=undefined;if(old?.contact&&live.running&&old.contact.epoch===live.epoch)try{await live.input({...old.contact,type:'cancel'})}catch{live.stop()}}
let lease;
// Attempt once per server startup, before queued requests. An explicit stop stays stopped.
if (deviceId === avd && process.env.HUB_AUTOSTART === '1') {
  queue = android.start().catch(error => console.error('AVD autostart failed:', error.message));
}
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
function activeLease() { return lease && lease.expires > Date.now() ? lease : undefined; }
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
    for(const t of targets.values()) await t.revoke(tokenMatch[1]);
    return json(200, { ok: true });
  }
  if (path === '/v1/devices' && method === 'GET') {
    return json(200, { devices: await Promise.all(Array.from(targets.values(), t => t.describe())) });
  }
  if (path === '/v1/device/start' && method === 'POST') { isAdmin(user); await android.start(); return json(200, { ok: true }); }
  if (path === '/v1/device/stop' && method === 'POST') { isAdmin(user); if(device.type==='physical')fail(409,'Physical device lifecycle is not managed'); await endLease();live.stop();await android.stop(); return json(200, { ok: true }); }
  if(path==='/v1/live' && method==='GET'){
    if(!process.env.HUB_SCRCPY_SERVER)fail(404,'Live capture is not enabled');
    if(req.headers.get('upgrade')?.toLowerCase()!=='websocket')fail(426,'WebSocket required');
    if(await android.status()!=='ready')fail(409,'Device not ready');
    if(!server.upgrade(req,{data:{deviceId,owner:user.id,pending:0}}))fail(400,'Upgrade failed');return;
  }
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
    await endLease(); return json(200, { ok: true });
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
async function touch(ws,e){
  if(!peers.has(ws)||!live.running||e.epoch!==live.epoch)fail(409,'Display changed');
  if(typeof e.gesture!=='string'||!/^[a-f0-9-]{36}$/.test(e.gesture))fail(400,'Invalid gesture');
  if(e.type==='down'||e.type==='key'){
    if(activeLease())fail(409,'Control is in use');await live.input(e);
    if(e.type==='down')lease={owner:ws.data.owner,id:id(),socket:ws,gesture:e.gesture,contact:e,expires:Date.now()+5000};
  }else{
    if(!activeLease()||lease.socket!==ws||lease.gesture!==e.gesture)fail(403,'Contact not owned');
    if(e.type==='hold'){lease.expires=Date.now()+5000;return}
    await live.input(e);if(e.type==='up'||e.type==='cancel')lease=undefined;else{lease.contact=e;lease.expires=Date.now()+5000}
  }
}
return {handle,body,json, describe:async()=>({id:deviceId,name,status:await android.status(),control:activeLease()?'in_use':'free'}),
  async revoke(owner){for(const ws of peers)if(ws.data.owner===owner){peers.delete(ws);ws.close(1008,'Access revoked')}if(lease?.owner===owner)await endLease()},
  async expire(){if(lease&&!activeLease())await endLease()},
  open(ws){peers.add(ws);for(const p of live.replay)sendPacket(ws,p);live.start().catch(()=>ws.close(1011,'Capture unavailable'))},
  message(ws,message){if(++ws.data.pending>64){ws.close(1008,'Input backlog');return}void ordered(async()=>{let e;try{e=JSON.parse(message);await touch(ws,e);ws.send(JSON.stringify({id:e.id,ok:true}))}catch(err){ws.send(JSON.stringify({id:e?.id,ok:false,error:err.status?err.message:'Input failed'}))}finally{ws.data.pending--}})},
  close(ws){peers.delete(ws);void ordered(async()=>{if(lease?.socket===ws)await endLease();if(!peers.size)live.stop()})}
};
}
for(const device of await loadDevices(dir,avd))targets.set(device.id,target(device));
const main = targets.get(avd);
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(PORT), idleTimeout: 30, maxRequestBodySize: 16384,
  async fetch(req) {
    // Read request bodies outside the effects queue so slow clients cannot block it.
    const url = new URL(req.url), path = url.pathname;
    const t = targets.get(url.searchParams.get('device') ?? avd);
    if(!t)return main.json(404,{error:'Unknown device'});
    const parsedBody = req.method === 'POST' && ['/v1/tokens','/v1/device/input'].includes(path) ? await t.body(req) : {};
    return ordered(()=>t.handle(req,path,parsedBody));
  },
  websocket:{maxPayloadLength:2048,backpressureLimit:2000000,closeOnBackpressureLimit:true,
    open(ws){targets.get(ws.data.deviceId).open(ws)},message(ws,m){targets.get(ws.data.deviceId).message(ws,m)},close(ws){targets.get(ws.data.deviceId).close(ws)}
  },
  error(error) {
    if (!error.status) console.error(error);
    return main.json(error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});
console.log(`Simulator Hub listening on ${server.url.origin}`);
setInterval(()=>void ordered(()=>{}).catch(console.error),250).unref();
return server;
}
if(import.meta.main)await startHub();
