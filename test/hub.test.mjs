import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const sleep = Bun.sleep;

let cleanup;
afterEach(async () => { await cleanup?.(); });

test('standalone server: lifecycle, two clients, exclusive input and durable revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-e2e-'));
  let child;
  cleanup = async () => { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } };
  const bin = join(dir, 'bin'); await mkdir(bin);
  for (const name of ['emulator', 'adb']) {
    await copyFile(new URL('./fixture-cli.cjs', import.meta.url), join(bin, name));
    await chmod(join(bin, name), 0o700);
  }
  let port = 0;
  const admin = randomBytes(32).toString('hex');
  const call = (path, token = admin, method = 'GET', body, lease) => fetch(`http://127.0.0.1:${port}/v1/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body && {'content-type':'application/json'}), ...(lease && {'x-lease-id':lease}) }, body: body && JSON.stringify(body)
  });
  async function stop() {
    if (!child) return;
    child.kill(); await child.exited;
  }
  async function boot() {
    child = Bun.spawn([process.execPath, 'server.mjs'], { env: {...process.env, PORT:'0', HUB_STATE_DIR:dir, HUB_ADMIN_TOKEN:admin, HUB_AVD:'Fixture', PATH:`${bin}:${process.env.PATH}`}, stdout:'pipe', stderr:'inherit' });
    let banner = '';
    for await (const chunk of child.stdout) {
      banner += new TextDecoder().decode(chunk);
      if (banner.includes('\n')) { port = Number(new URL(banner.trim().split(' ').at(-1)).port); return; }
    }
    assert.fail('server exited before listening');
  }
  async function ok(...args) { const r = await call(...args); assert.ok(r.ok, `${args[2] || 'GET'} ${args[0]}: ${r.status}`); return r; }
  await boot();
  assert.equal((await call('tokens',admin,'POST',{name:'x'.repeat(17000)})).status,413);
  assert.equal((await call('device','invalid')).status,401);
  const clients = await Promise.all(['first','second'].map(async name => (await ok('tokens',admin,'POST',{name})).json()));
  for (const text of [await (await ok('tokens')).text(), await readFile(join(dir,'tokens.json'),'utf8')]) {
    for (const client of clients) assert.ok(!text.includes(client.token));
  }
  assert.equal((await call('tokens',clients[0].token)).status,403);
  assert.equal((await call('device/start',clients[0].token,'POST')).status,403);
  assert.equal((await (await ok('device')).json()).status,'stopped');
  await ok('device/start',admin,'POST');
  for (let i=0;i<30 && (await (await ok('device')).json()).status !== 'ready';i++) await sleep(50);
  const png = Buffer.from(await (await ok('device/screenshot',clients[0].token)).arrayBuffer());
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const races = await Promise.all(clients.map(c => call('lease',c.token,'POST')));
  assert.equal(races.filter(r=>r.ok).length,1); assert.equal(races.find(r=>!r.ok).status,409);
  const idx = races.findIndex(r=>r.ok), owner = clients[idx], other = clients[1-idx];
  const lease = (await races[idx].json()).id;
  const input = {type:'tap',x:10,y:20};
  assert.ok(!(await call('device/input',other.token,'POST',input,lease)).ok);
  assert.ok(!(await call('lease',other.token,'DELETE',undefined,lease)).ok);
  await ok('lease',owner.token,'PUT',undefined,lease);
  await ok('device/input',owner.token,'POST',input,lease);
  await ok('device/input',owner.token,'POST',{type:'swipe',x1:1,y1:2,x2:3,y2:4,duration:200},lease);
  await ok('device/input',owner.token,'POST',{type:'key',key:'HOME'},lease);
  const log = await readFile(join(dir,'fixture-running.input'),'utf8'); assert.match(log,/input tap 10 20/); assert.match(log,/input swipe 1 2 3 4 200/); assert.match(log,/input keyevent /);
  assert.equal((await call('device/input',owner.token,'POST',{type:'key',key:'UNSUPPORTED'},lease)).status,400);
  await ok(`tokens/${owner.id}`,admin,'DELETE');
  assert.equal((await call('device/input',owner.token,'POST',input,lease)).status,401);
  const next = (await (await ok('lease',other.token,'POST')).json()).id;
  await ok('lease',other.token,'DELETE',undefined,next);
  const beforeRestart = (await (await ok('lease',other.token,'POST')).json()).id;
  await stop(); await boot();
  assert.equal((await call('me',owner.token)).status,401); await ok('me',other.token);
  assert.ok(!(await call('device/input',other.token,'POST',input,beforeRestart)).ok);
  const forced = (await (await ok('lease',other.token,'POST')).json()).id;
  await ok('lease',admin,'DELETE');
  assert.ok(!(await call('device/input',other.token,'POST',input,forced)).ok);
  const timed = (await (await ok('lease',other.token,'POST')).json()).id;
  await sleep(5000);
  await ok('lease',other.token,'PUT',undefined,timed);
  await sleep(26000); // Original deadline has passed; renewal still authorizes input.
  await ok('device/input',other.token,'POST',input,timed);
  await sleep(4500);
  assert.ok(!(await call('device/input',other.token,'POST',input,timed)).ok);
  await ok('lease',other.token,'POST');
  await writeFile(join(dir,'fixture-running'),'DifferentAVD');
  assert.ok(!(await call('device/stop',admin,'POST')).ok);
  assert.equal(await readFile(join(dir,'fixture-running'),'utf8'),'DifferentAVD');
  await writeFile(join(dir,'fixture-running'),'Fixture');
  await ok('device/stop',admin,'POST');
  assert.equal((await (await ok('device')).json()).status,'stopped');
}, 60000);
