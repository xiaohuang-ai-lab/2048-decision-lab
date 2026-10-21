import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseNative, closeNative, createNativeEngine, packBoard, unpackBoard, NATIVE_VERSION } from '../native-ai.mjs';
import { move, legalMoves, seededRandom } from '../public/game.mjs';
import { decide, configFromEnv } from '../providers.mjs';
import { createApp } from '../server.mjs';
import { once } from 'node:events';
const board=[[128,64,32,16],[8,4,2,0],[4,2,0,0],[2,0,0,0]];

test('pinned native engine uses the same board encoding, move rules, scores and legal actions',async t=>{
 t.after(closeNative);
 const random=seededRandom('native-move-parity');
 const boards=[board,[[2,2,2,2],[4,4,8,8],[0,0,0,0],[0,0,0,0]]];
 for(let i=0;i<40;i++)boards.push(Array.from({length:4},()=>Array.from({length:4},()=>{const rank=Math.floor(random()*7);return rank?2**rank:0;})));
 for(const b of boards) {
  assert.deepEqual(unpackBoard(packBoard(b)),b);
  if(!legalMoves(b).length)continue;
  const copy=structuredClone(b),result=await chooseNative(b);
  assert.deepEqual(b,copy);assert.deepEqual(Object.keys(result.scores),legalMoves(b));
  for(const direction of legalMoves(b))assert.deepEqual(unpackBoard(result.boards_after_move[direction]),move(b,direction).board);
  assert.equal(result.scores[result.direction],Math.max(...Object.values(result.scores)));
  assert.ok(result.search_by_direction[result.direction].depth_limit>=3);
 }
 assert.throws(()=>packBoard([[65536,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]),/32768/);
});
test('native process can be cancelled, recovered, timed out, and reports missing binary',async t=>{
 const engine=createNativeEngine();t.after(()=>engine.close());
 const controller=new AbortController();
 const pending=engine.request(board,controller.signal);controller.abort();
 await assert.rejects(pending);
 const recovered=await engine.request(board);assert.ok(legalMoves(board).includes(recovered.direction));
 const missing=createNativeEngine({binary:'/not-installed/nneonneo-2048'});
 assert.throws(()=>missing.request(board),/编译/);
 const timed=createNativeEngine({timeout:1});t.after(()=>timed.close());
 await assert.rejects(timed.request(board),/超时/);
});
test('HTTP native integration never calls a model',async t=>{
 t.after(closeNative);
 const config=configFromEnv({}),app=createApp(config,{fetcher:()=>{throw new Error('external request forbidden');}});
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
 const base=`http://127.0.0.1:${app.address().port}`;
 const response=await fetch(base+'/api/decide',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Demo-Request':'2048'},body:JSON.stringify({mode:'local',local_engine:'nneonneo',board,score:0,steps:0})});
 assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.algorithm_version,NATIVE_VERSION);assert.equal(result.usage,null);assert.equal(result.local_engine,'nneonneo');
 await assert.rejects(decide({mode:'local',local_engine:'unknown',board,score:0,steps:0},config,new AbortController().signal),/选择无效/);
});
