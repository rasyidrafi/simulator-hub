import {test,expect} from 'bun:test';
import {createLive} from '../live.mjs';

test('capture is shared, keyframes bootstrap new viewers, rotation invalidates touch',async()=>{
  let put,opens=0,closes=0;const events=[],packets=[];
  const stream=new ReadableStream({start(c){put=c}});
  const live=createLive(async()=>{opens++;return {video:{width:720,height:1280,stream},controller:{injectTouch:async e=>events.push(e)},close:async()=>{closes++}}},p=>packets.push(p));
  await Promise.all([live.start(),live.start()]);expect(opens).toBe(1);
  const config={type:'configuration',data:Buffer.from([0,0,1,103])};put.enqueue(config);
  put.enqueue({type:'data',keyframe:true,pts:10n,data:Buffer.from([0,0,1,101])});
  put.enqueue({type:'data',keyframe:false,pts:20n,data:Buffer.from([0,0,1,1])});await Bun.sleep(1);
  expect(packets.length).toBe(2);expect(live.replay[0].subarray(49)).toEqual(Buffer.concat([config.data,Buffer.from([0,0,1,101])]));
  const old=live.epoch;for(const type of ['down','move','up'])await live.input({type,epoch:old,x:4,y:12});expect(events.map(e=>e.action)).toEqual([0,2,1]);
  put.enqueue(config);await Bun.sleep(1);expect(live.replay.length).toBe(0);await expect(live.input({type:'down',epoch:old,x:0,y:1})).rejects.toThrow('Display changed');
  await expect(live.input({type:'down',epoch:live.epoch,x:720,y:2})).rejects.toThrow('Invalid touch');live.stop();put.close();expect(closes).toBe(1);
});
