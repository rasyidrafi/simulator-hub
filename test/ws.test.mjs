import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,copyFile,chmod,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';

test('socket ownership, long stationary hold, rotation with two viewers, force release/disconnect/revoke',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hub-ws-'));let proc;const sockets=[];
 try{const bin=join(dir,'bin');await mkdir(bin);await copyFile(new URL('./fixture-cli.cjs',import.meta.url),bin+'/adb');await chmod(bin+'/adb',0o700);await writeFile(dir+'/fixture-running','Fixture');
 const admin=crypto.randomUUID();proc=Bun.spawn([process.execPath,'test/live-fixture.mjs'],{env:{...process.env,HUB_ADMIN_TOKEN:admin,HUB_STATE_DIR:dir,HUB_AVD:'Fixture',HUB_SCRCPY_SERVER:'fixture',PORT:'0',PATH:bin+':'+process.env.PATH},stdout:'pipe',stderr:'inherit'});
 const r=proc.stdout.getReader();const base=new TextDecoder().decode((await r.read()).value).trim().split(' ').at(-1)+'/v1';
 const api=(path,method,body)=>fetch(base+path,{method,headers:{authorization:'Bearer '+admin,'content-type':'application/json'},body:body&&JSON.stringify(body)});
 const {token,id}=await (await api('/tokens','POST',{name:'tester'})).json();
 async function connect(){const ws=new WebSocket(base.replace('http:','ws:')+'/live',{headers:{authorization:'Bearer '+token}});sockets.push(ws);ws.binaryType='arraybuffer';const state={epoch:'',pending:new Map(),ws};ws.onmessage=({data})=>{if(typeof data==='string'){const a=JSON.parse(data);state.pending.get(a.id)?.(a);state.pending.delete(a.id)}else state.epoch=new TextDecoder().decode(new Uint8Array(data,0,36))};await until(()=>state.epoch);return state}
 async function until(fn){const start=Date.now();while(!fn()){if(Date.now()-start>3000)throw Error('fixture timeout');await Bun.sleep(10)}}
 const a=await connect(),b=await connect(),gesture=crypto.randomUUID();let n=0;
 const touch=(s,type)=>new Promise(resolve=>{const id=++n;s.pending.set(id,resolve);s.ws.send(JSON.stringify({id,epoch:s.epoch,type,gesture,x:2,y:5}))});
 expect((await touch(a,'down')).ok).toBe(true);expect((await touch(b,'move')).ok).toBe(false);
 for(let i=0;i<4;i++){await Bun.sleep(1500);expect((await touch(a,'hold')).ok).toBe(true)}expect((await touch(a,'move')).ok).toBe(true);
 const old=a.epoch;await writeFile(dir+'/rotate','');await until(()=>a.epoch!==old&&b.epoch===a.epoch);expect((await touch(b,'down')).ok).toBe(true);
 await api('/lease','DELETE');expect((await touch(b,'move')).ok).toBe(false);expect((await touch(a,'down')).ok).toBe(true);a.ws.close();await until(()=>a.ws.readyState===3);await Bun.sleep(50);
 expect((await touch(b,'down')).ok).toBe(true);await api('/tokens/'+id,'DELETE');await until(()=>b.ws.readyState===3);expect((await readFile(dir+'/touch','utf8')).trim().split('\n')).toEqual(['0','2','3','0','3','0','3','0','3']);
 }finally{for(const ws of sockets)ws.close();if(proc){proc.kill();await proc.exited}await rm(dir,{recursive:true,force:true})}
},15000);
