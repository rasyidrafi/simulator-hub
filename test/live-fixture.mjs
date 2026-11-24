// Standalone integration-test entry; not reachable through the production server.
import {startHub} from '../server.mjs';
import {existsSync,unlinkSync,appendFileSync} from 'node:fs';
const base=process.env.HUB_STATE_DIR+'/';
await startHub(async()=>{let timer,i=0;const video={width:720,height:1280,stream:new ReadableStream({start(c){timer=setInterval(()=>{
  const rotate=existsSync(base+'rotate');if(rotate){unlinkSync(base+'rotate');[video.width,video.height]=[video.height,video.width]}
  if(rotate||!i)c.enqueue({type:'configuration',data:new Uint8Array([0,0,1,103])});
  c.enqueue({type:'data',keyframe:rotate||i%30===0,pts:BigInt(++i*33333),data:new Uint8Array([1,2,3])});},30)}})};
  return {video,controller:{injectTouch:async e=>appendFileSync(base+'touch',e.action+'\n')},close:async()=>clearInterval(timer)};
});
