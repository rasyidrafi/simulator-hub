async function runAdb(args, binary = false) {
  const child = Bun.spawn(['adb', ...args], { stdout: 'pipe', stderr: 'ignore', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  const response = new Response(child.stdout);
  const [code, output] = await Promise.all([child.exited, binary ? response.arrayBuffer() : response.text()]);
  if (code !== 0) throw new Error(`adb exited with code ${code}`);
  return output;
}
export function createAndroid({avd, serial, type, port}) {
  const adb = (...args) => runAdb(['-s', serial, ...args]);
  const physical = type === 'physical';
  let child;
  async function status() {
    if (physical) {
      const line = (await runAdb(['devices'])).split('\n').find(l => l.split(/\s+/)[0] === serial);
      return line?.split(/\s+/)[1] === 'device' ? 'ready' : 'offline';
    }
    let name;
    try {
      const devices = await runAdb(['devices']);
      const match = devices.split('\n').map(l=>l.trim().split(/\s+/)).find(cols=>cols[0]===serial);
      if (!match) return child ? 'booting' : 'stopped';
      if (match[1] === 'offline') return 'booting';
      name = (await adb('emu', 'avd', 'name')).toString().trim().split(/\r?\n/)[0];
    }
    catch (error) {
      // Only an absent target is stopped. Offline devices, missing tools and
      // failed console authentication must not authorize a new emulator launch.
      throw Object.assign(new Error('Cannot query configured emulator; check adb and emulator console access'), {status:503});
    }
    if (name !== avd) throw new Error(`${serial} belongs to a different AVD`);
    try {
      return (await adb('shell', 'getprop', 'sys.boot_completed')).toString().trim() === '1' ? 'ready' : 'booting';
    } catch { return 'booting'; }
  }
  return {
    status,
    async start() {
      if (physical) throw Object.assign(Error('Physical device lifecycle is not managed'), {status:409});
      if (await status() !== 'stopped') return;
      const launched = Bun.spawn(['emulator', '-avd', avd, '-port', String(port), '-no-window', '-no-audio'], { stdio: ['ignore','ignore','ignore'] });
      child = launched;
      launched.exited.then(() => { if (child === launched) child = undefined; });
    },
    async stop() {
      if (physical) throw Object.assign(Error('Physical device lifecycle is not managed'), {status:409});
      const state = await status();
      if (state === 'stopped') return;
      // Never target an unverified emulator, including while our process is starting.
      const name = (await adb('emu', 'avd', 'name')).toString().trim().split(/\r?\n/)[0];
      if (name !== avd) throw new Error(`${serial} belongs to a different AVD`);
      await adb('emu', 'kill');
      child = undefined;
    },
    async screenshot() { return runAdb(['-s', serial, 'exec-out', 'screencap', '-p'], true); },
    async input(input) {
      if (input.type === 'tap') await adb('shell', 'input', 'tap', String(input.x), String(input.y));
      else if (input.type === 'swipe') await adb('shell', 'input', 'swipe', String(input.x1), String(input.y1), String(input.x2), String(input.y2), String(input.duration));
      else await adb('shell', 'input', 'keyevent', input.key);
    },
  };
}
