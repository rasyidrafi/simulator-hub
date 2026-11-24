#!/usr/bin/env bun
// Installed by the test as two executables on an isolated PATH.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = path.join(process.env.HUB_STATE_DIR, 'fixture-running');
const active = fs.existsSync(file);
if (path.basename(process.argv[1]) === 'emulator') {
  if (args.includes('-list-avds')) console.log('Fixture');
  else if (args.includes('Fixture') || args.includes('@Fixture')) fs.writeFileSync(file, 'Fixture');
  else process.exit(1);
} else if (args[0] === 'devices') {
  console.log('List of devices attached\n' + (active ? 'emulator-5554\tdevice\n' : ''));
} else {
  if (args.shift() !== '-s' || args.shift() !== 'emulator-5554') process.exit(2);
  if (!active) { console.error("error: device 'emulator-5554' not found"); process.exit(1); }
  const cmd = args.join(' ');
  if (cmd === 'emu avd name') console.log(fs.readFileSync(file, 'utf8') + '\nOK');
  else if (cmd === 'get-state') console.log('device');
  else if (cmd === 'shell getprop sys.boot_completed') console.log('1');
  else if (cmd === 'emu kill') fs.unlinkSync(file);
  else if (cmd === 'exec-out screencap -p') process.stdout.write(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  else if (cmd.startsWith('shell input ')) fs.appendFileSync(file + '.input', cmd + '\n');
  else process.exit(2);
}
