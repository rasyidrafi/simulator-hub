import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Preserve the default device for clients that predate device selection.
export async function loadDevices(dir, defaultAvd) {
  const entries = [{id:defaultAvd, name:defaultAvd.replaceAll('_',' '), avd:defaultAvd, port:5554, type:'emulator'}];
  let extra = [];
  try { extra = JSON.parse(await readFile(join(dir,'devices.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(extra)) throw Error('devices.json must contain an array');
  const ids = new Set(), serials = new Set(), avds = new Set();
  return [...entries,...extra].map((d,i) => {
    if (!d || typeof d.id !== 'string' || !d.id || (i && !/^[\w.-]+$/.test(d.id)) || ids.has(d.id)) throw Error('Invalid or duplicate device id');
    if (typeof d.name !== 'string' || !d.name.trim()) throw Error('Device name required');
    let serial;
    if (d.type === 'emulator') {
      if (!Number.isInteger(d.port) || d.port < 5554 || d.port > 5682 || d.port % 2 || typeof d.avd !== 'string' || !d.avd.trim() || avds.has(d.avd)) throw Error('Invalid emulator port or duplicate/missing AVD');
      serial = `emulator-${d.port}`; avds.add(d.avd);
    } else if (d.type === 'physical' && typeof d.serial === 'string' && /^\S+$/.test(d.serial) && !d.serial.startsWith('emulator-')) serial = d.serial;
    else throw Error('Invalid device type or physical device serial');
    if (serials.has(serial)) throw Error('Duplicate ADB target');
    ids.add(d.id); serials.add(serial); return {...d,serial};
  });
}
