import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const digest = 'a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8';
// Only the dependency-free legacy routes are needed until live streaming is enabled.
export async function openScrcpy() {
  const jar = await readFile(process.env.HUB_SCRCPY_SERVER);
  if (createHash('sha256').update(jar).digest('hex') !== digest) throw Error('Expected official scrcpy-server-v3.3.1');
  const [{AdbServerClient},{AdbServerNodeTcpConnector},{AdbScrcpyClient,AdbScrcpyOptions3_3_1}] = await Promise.all([
    import('@yume-chan/adb'), import('@yume-chan/adb-server-node-tcp'), import('@yume-chan/adb-scrcpy')]);
  const host = new AdbServerClient(new AdbServerNodeTcpConnector({host:'127.0.0.1',port:5037}));
  const adb = await host.createAdb({serial:'emulator-5554'});
  const path = '/data/local/tmp/simulator-hub-scrcpy-3.3.1.jar';
  let client;
  try {
    await AdbScrcpyClient.pushServer(adb,new Blob([jar]).stream(),path);
    client = await AdbScrcpyClient.start(adb,path,new AdbScrcpyOptions3_3_1({audio:false,clipboardAutosync:false,tunnelForward:true,maxSize:1280,maxFps:30,videoBitRate:2500000,videoCodecOptions:'i-frame-interval=1'}));
    void client.output.pipeTo(new WritableStream()).catch(()=>{});
    const video = await client.videoStream;
    return {video, controller:client.controller, close:async()=>{try {await client.close()} finally {await adb.close()}}};
  } catch(e) {try {await client?.close()} finally {await adb.close()} throw e}
}

// Cache one bounded GOP. A new or lagging decoder starts at a keyframe, never at an arbitrary delta.
export function createLive(open = openScrcpy,onPacket=()=>{},onStop=()=>{},beforeGeometryChange=()=>{}) {
  let source, opening, config, frames=[], bytes=0, epoch='', width=0,height=0, generation=0;
  const reset=()=>{frames=[];bytes=0;epoch=randomUUID()};
  function stop(){generation++;const old=source;source=null;config=null;reset();onStop();if(old)void old.close().catch(()=>{})}
  async function start(){
    if(source)return;if(opening)return opening;
    const gen=generation;
    opening=(async()=>{const s=await open();if(gen!==generation){await s.close();throw Error('Capture cancelled')};source=s;reset();
      void (async()=>{try{for await(const p of s.video.stream){if(gen!==generation)break;
        if(p.type==='configuration'){await beforeGeometryChange();if(gen!==generation)break;config=Buffer.from(p.data);width=s.video.width;height=s.video.height;reset();continue}
        if(!config||!width||!height)continue;
        if(p.keyframe){frames=[];bytes=0}else if(!frames.length)continue;
        const data=p.keyframe?Buffer.concat([config,p.data]):Buffer.from(p.data);
        bytes+=data.length;if(bytes>1500000||frames.length>=240){frames=[];continue}
        const packet=Buffer.allocUnsafe(49+data.length);packet.write(epoch,0,36,'ascii');packet.writeUInt16BE(width,36);packet.writeUInt16BE(height,38);packet[40]=p.keyframe?1:0;packet.writeBigUInt64BE(p.pts??0n,41);data.copy(packet,49);frames.push(packet);onPacket(packet);
      }}catch(e){console.warn('Live capture ended:',e.message)}finally{if(gen===generation)stop()}})();
    })().finally(()=>{opening=null});return opening;
  }
  async function input(e){
    if(!source||epoch!==e.epoch)throw Object.assign(Error('Display changed'),{status:409});
    if(e.type==='key'){const keyCode={HOME:3,BACK:4,ENTER:66}[e.key];if(!keyCode)throw Object.assign(Error('Invalid key'),{status:400});
      for(const action of [0,1])await source.controller.injectKeyCode({action,keyCode,repeat:0,metaState:0});return}
    if(!['down','move','up','cancel'].includes(e.type)||![e.x,e.y].every(Number.isInteger)||e.x<0||e.x>=width||e.y<0||e.y>=height)throw Object.assign(Error('Invalid touch'),{status:400});
    await source.controller.injectTouch({action:{down:0,up:1,move:2,cancel:3}[e.type],pointerId:0n,pointerX:e.x,pointerY:e.y,videoWidth:width,videoHeight:height,pressure:['up','cancel'].includes(e.type)?0:1,actionButton:0,buttons:0});
  }
  return {start,stop,input,get replay(){return frames},get running(){return !!source},get epoch(){return epoch}};
}
