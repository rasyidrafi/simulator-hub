// Explicit opt-in: this boots, controls and stops a previously stopped AVD.
import assert from 'node:assert/strict';

const base = `http://127.0.0.1:${Number(process.env.PORT || 8787)}/v1/`;
const admin = process.env.HUB_ADMIN_TOKEN;
assert.ok(admin, 'Set HUB_ADMIN_TOKEN for the running local server');
async function request(path, method = 'GET', token = admin, body, lease) {
  const res = await fetch(base + path, { method, headers: { authorization:`Bearer ${token}`, ...(body && {'content-type':'application/json'}), ...(lease && {'x-lease-id':lease}) }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res;
}
const status = async () => (await (await request('device')).json()).status;
assert.equal(await status(), 'stopped', 'Use a stopped, disposable AVD reserved for this test');
let started = false, operator;
try {
  operator = await (await request('tokens','POST',admin,{ name:'real-avd-smoke' })).json();
  await request('device/start','POST'); started = true;
  const deadline = Date.now() + 180000;
  while (await status() !== 'ready') { assert.ok(Date.now() < deadline,'boot timed out'); await Bun.sleep(1000); }
  const lease = (await (await request('lease','POST',operator.token)).json()).id;
  await request('device/input','POST',operator.token,{type:'key',key:'HOME'},lease);
  const frame = Buffer.from(await (await request('device/screenshot','GET',operator.token)).arrayBuffer());
  assert.equal(frame.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  console.log(`Received PNG: ${frame.readUInt32BE(16)} × ${frame.readUInt32BE(20)}`);
} finally {
  try { if (operator) await request(`tokens/${operator.id}`,'DELETE'); }
  finally { if (started) await request('device/stop','POST'); }
}
