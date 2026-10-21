import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createArchive } from '../archive.mjs';
import { createApp } from '../server.mjs';
import { configFromEnv } from '../providers.mjs';
import { createArchiveBuffer } from '../public/app.mjs';
const initial={board:[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],score:0,steps:0};
const final={board:[[4,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],score:4,steps:1};
const session=()=>({id:randomUUID(),created_at:new Date().toISOString(),seed:'test-fixture',initial});
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'2048-archive-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('archives pending and completed evidence, survives restart, and writes an honest summary',async t=>{
 const dir=await directory(t), archive=createArchive(dir), s=session();
 const event={id:randomUUID(),mode:'jev',status:'pending',before:initial};
 await archive.save({session:s,event});
 let saved=JSON.parse(await readFile(join(dir,s.id+'.json'),'utf8'));
 assert.equal(saved.session.events[0].status,'pending');
 const done={...event,status:'applied',after:final,result:{model:'MOCK',usage:{input_tokens:100,output_tokens:5},raw_response:{answers:{move:{choice:'left'}}}}};
 const result=await archive.save({session:s,event:done,final});
 await createArchive(dir).save({session:s,event:done,final}); // idempotent retry after server restart
 saved=JSON.parse(await readFile(result.path,'utf8'));
 assert.equal(saved.session.events.length,1);assert.equal(saved.session.final.score,4);
 assert.equal(saved.session.events[0].result.raw_response.answers.move.choice,'left');
 const summary=await readFile(result.summary_path,'utf8');
 assert.match(summary,/输入 Token：100/);assert.match(summary,/尚可继续/);
 assert.equal((await stat(result.path)).mode&0o777,0o600);
 assert.equal((await readdir(dir)).some(x=>x.endsWith('.tmp')),false);
 await assert.rejects(archive.save({session:s,event}),/旧记录/);
});
test('redacts credentials from nested raw responses and rejects paths and conflicting sessions',async t=>{
 const dir=await directory(t), archive=createArchive(dir,new Set(['fixture-private-key'])), s=session();
 const event={id:randomUUID(),mode:'llm',status:'failed',before:initial,error:'echo fixture-private-key',evidence:{raw_response:{api_key:'unknown-key',note:'Bearer stranger-token',nested:{password:'private'}}}};
 const {path}=await archive.save({session:s,event});
 const text=await readFile(path,'utf8');
 for(const value of ['fixture-private-key','unknown-key','stranger-token','"private"'])assert.equal(text.includes(value),false);
 await assert.rejects(archive.save({session:{...s,id:'../escape'}}),/信息无效/);
 await assert.rejects(archive.save({session:{...s,seed:'different'}}),/占用/);
});
test('serializes independent updates without losing events and preserves unknown outcomes',async t=>{
 const dir=await directory(t), archive=createArchive(dir),s=session();
 await Promise.all(['pending','failed','cancelled','discarded'].map(status=>archive.save({session:s,event:{id:randomUUID(),mode:'llm',status,before:initial}})));
 const saved=JSON.parse(await readFile(join(dir,s.id+'.json'),'utf8'));
 assert.equal(saved.session.events.length,4);
 const summary=await readFile(join(dir,s.id+'.md'),'utf8');
 assert.match(summary,/等待或未确认 1/);assert.match(summary,/输入 Token：未知/);
});
test('log endpoint writes locally, rejects cross-origin and keeps archives off static routes',async t=>{
 const dir=await directory(t),app=createApp(configFromEnv({}),{archiveDir:dir,fetcher:()=>{throw new Error('no network expected');}});
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
 const base=`http://127.0.0.1:${app.address().port}`,s=session();
 const post=origin=>fetch(base+'/api/logs',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Demo-Request':'2048'},body:JSON.stringify({session:s,events:[]})});
 assert.equal((await post('https://elsewhere.example')).status,403);
 const response=await post(base);assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.events,0);assert.equal(result.batch_events,0);
 assert.equal((await fetch(base+'/logs/'+s.id+'.json')).status,404);
 assert.equal((await fetch(base+'/archive.mjs')).status,404);
});

test('batch saves remain idempotent and an invalid batch cannot partially overwrite a game',async t=>{
 const dir=await directory(t),archive=createArchive(dir),s=session();
 const pending={id:randomUUID(),mode:'local',status:'pending',before:initial};
 const done={...pending,status:'applied',after:final};
 const other={id:randomUUID(),mode:'local',status:'failed',before:final};
 const payload={session:s,events:[pending,done,other],final};
 const saved=await archive.save(payload);
 assert.equal(saved.batch_events,3);
 const retry={...payload,events:[done,other]};
 await createArchive(dir).save(retry);
 const before=await readFile(saved.path,'utf8');
 assert.deepEqual(JSON.parse(before).session.events.map(e=>e.status),['applied','failed']);
 await assert.rejects(archive.save({...payload,events:[{...other,id:randomUUID()},pending]}),/旧记录/);
 assert.equal(await readFile(saved.path,'utf8'),before);
});

test('background buffer coalesces updates, preserves in-flight changes and retries without dropping records',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const sent=[];let release,fail=false;
 const buffer=createArchiveBuffer({send:async payload=>{
   sent.push(payload);
   if(fail)throw Error('disk unavailable');
   await new Promise(resolve=>{release=resolve;});
   return {batch_events:payload.events.length};
 }});
 const s=session(), event={id:randomUUID(),mode:'local',status:'pending',before:initial};
 buffer.enqueue({session:s,event,final:initial});
 assert.equal(sent.length,0);
 t.mock.timers.tick(1000);
 await Promise.resolve();
 assert.equal(sent.length,1);
 buffer.enqueue({session:s,event:{...event,status:'applied',after:final},final});
 const inFlight=buffer.flush();
 release();await inFlight;await Promise.resolve();
 // The pending acknowledgement must not erase the newer completed snapshot.
 assert.equal(buffer.size,1);
 const completed=buffer.flush();await Promise.resolve();
 release();await completed;
 assert.equal(buffer.size,0);
 assert.equal(sent.at(-1).events[0].status,'applied');
 fail=true;
 const other={...event,id:randomUUID(),status:'failed'};
 buffer.enqueue({session:s,event:other,final});
 buffer.enqueue({session:s,event:{...other,error:'latest'},final});
 assert.equal(await buffer.flush(),false);
 assert.equal(buffer.failed,true);assert.equal(buffer.size,1);
 fail=false;
 const retry=buffer.retry();await Promise.resolve();release();await retry;
 assert.equal(buffer.size,0);assert.equal(sent.at(-1).events.length,1);
 assert.equal(sent.at(-1).events[0].error,'latest');
});

test('local algorithm evidence is archived without invented API use',async t=>{
 const dir=await directory(t),s=session();
 const event={id:randomUUID(),mode:'local',status:'applied',before:initial,after:final,result:{model:'expectimax-local-v1',algorithm_version:'expectimax-local-v1',usage:null,raw_response:{direction:'left',scores:{left:123}}}};
 const saved=await createArchive(dir).save({session:s,event,final});
 assert.equal(JSON.parse(await readFile(saved.path,'utf8')).session.events[0].result.raw_response.scores.left,123);
 const summary=await readFile(saved.summary_path,'utf8');
 assert.match(summary,/本地算法决策：1/);assert.match(summary,/模型 API 请求：0/);
});
