import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { summarizeSession, latestSessions, createStatisticsReader } from '../statistics.mjs';
import { projectSeries, stepPath, costInCny, FX_SNAPSHOT } from '../public/chart.mjs';
import { createApp } from '../server.mjs';
import { configFromEnv } from '../providers.mjs';
const initial={board:[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],score:0,steps:0};
const after={board:[[4,0,0,0],[0,2,0,0],[0,0,0,0],[0,0,0,0]],score:4,steps:1};
const price={currency:'CNY',input_per_million:2,cached_input_per_million:2,output_per_million:8};
function event(mode='llm',extra={}) {return {id:randomUUID(),mode,status:'applied',at:'2026-10-20T00:00:01Z',timeline:[{at:'2026-10-20T00:00:02Z'}],before:initial,after,pricing:price,result:{model:'fixture-model',usage:{input_tokens:100,output_tokens:0}},...extra};}
function doc(events=[event()],created='2026-10-20T00:00:00Z') {return {source:'local-browser-session',saved_at:'2026-10-20T02:00:00Z',session:{id:randomUUID(),created_at:created,seed:'fixture',initial,events}};}
async function directory(t){const d=await mkdtemp(join(tmpdir(),'2048-stats-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
test('latest is by start time, not high score or last save; algorithms are separate modes',()=>{
  const older=summarizeSession(doc([event()],'2026-10-19T00:00:00Z'));
  const newer=summarizeSession(doc([event()]));older.saved_at='2026-10-21T00:00:00Z';older.score=999999;
  const simple=summarizeSession(doc([event('local')]));
  const native=summarizeSession(doc([event('local',{local_engine:'nneonneo'})]));
  const result=latestSessions([older,newer,simple,native]);
  assert.equal(result.find(s=>s.key==='llm:direct').session_id,newer.session_id);
  assert.deepEqual(result.map(s=>s.key),['llm:direct','local:simple','local:nneonneo']);
  assert.deepEqual(summarizeSession(doc([])),{excluded:'empty'});
  assert.deepEqual(summarizeSession(doc([event('jev'),event('llm')])),{excluded:'mixed'});
  assert.deepEqual(summarizeSession(doc([event('local'),event('local',{local_engine:'nneonneo'})])),{excluded:'mixed'});
});
test('retry cost counts without advancing steps; unknown cost preserves later known costs and flags the incomplete suffix',()=>{
  const failed=event('llm',{status:'failed',after:undefined});
  const success=event('llm',{at:'2026-10-20T00:00:04Z',timeline:[{at:'2026-10-20T00:00:05Z'}]});
  const unknown=event('llm',{at:'2026-10-20T00:00:06Z',timeline:[{at:'2026-10-20T00:00:07Z'}],status:'failed',result:{},after:undefined});
  const later=event('llm',{at:'2026-10-20T00:00:08Z',timeline:[{at:'2026-10-20T00:00:09Z'}],before:after,after:{...after,steps:2,score:8}});
  const s=summarizeSession(doc([failed,success,unknown,later]));
  assert.deepEqual(s.points.map(p=>p.step),[0,0,1,1,2]);
  assert.deepEqual(s.points.map(p=>p.score),[0,0,4,4,8]);
  assert.equal(s.elapsed_ms,8000);assert.equal(s.cost_complete,false);assert.equal(s.unknown_costs,1);
  assert.ok(Math.abs(s.costs.CNY-.0006)<1e-12);
  const curve=projectSeries(s,'cost');
  assert.equal(curve.length,5);
  assert.deepEqual(curve.map(p=>p.cost_complete),[true,true,true,false,false]);
  assert.equal(curve[3].x,curve[2].x);
  assert.equal(curve.at(-1).x,s.costs.CNY);
  assert.equal(curve.at(-1).step,2);
  assert.equal(curve.at(-1).unknown_costs,1);
  assert.equal(curve.at(-1).costs,null); // Exact cumulative cost remains unknown.
  const allUnknown=projectSeries(summarizeSession(doc([unknown])),'cost').at(-1);
  assert.equal(allUnknown.x,0);assert.equal(allUnknown.cost_complete,false);
  assert.equal(projectSeries(s,'time').at(-1).x,8);
  assert.equal(projectSeries(s,'step').length,5);
});
test('local and manual have zero API cost; high tile does not imply game over; missing time is not zero',()=>{
  const s=summarizeSession(doc([event('local',{after:{...after,board:[[4096,0,0,0],[0,2,0,0],[0,0,0,0],[0,0,0,0]]}})]));
  assert.equal(s.max_tile,4096);assert.equal(s.status,'can_continue');assert.equal(s.cost_complete,true);
  const capped=summarizeSession(doc([event('local',{run_settings:{objective:'target-2048-v1'},after:{...after,board:[[2048,0,0,0],[0,2,0,0],[0,0,0,0],[0,0,0,0]]}})]));
  assert.equal(capped.status,'target_reached');
  assert.deepEqual(projectSeries(s,'cost').map(p=>p.x),[0,0]);
  const manual=summarizeSession(doc([event('manual')]));assert.deepEqual(manual.costs,{CNY:0,USD:0});
  const noTime=summarizeSession(doc([event('local',{at:null,timeline:[]})]));assert.equal(noTime.elapsed_ms,null);assert.deepEqual(projectSeries(noTime,'time'),[]);
  const pending=summarizeSession(doc([event('jev',{status:'pending',after:undefined})]));assert.equal(pending.status,'pending');assert.equal(pending.steps,0);
  assert.equal(stepPath([{x:0,score:0},{x:2,score:4}],x=>x,y=>y,'score'),'M0,0H2V4');
});

test('cost curves share a fixed CNY axis without changing original amounts or filling unknown costs',()=>{
  assert.equal(FX_SNAPSHOT.usdToCny,6.6792);
  assert.equal(FX_SNAPSHOT.accessedOn,'2026-10-20');
  const usd={CNY:0,USD:1}, mixed={CNY:2,USD:1};
  assert.equal(costInCny(usd),6.6792);
  assert.equal(costInCny(mixed),8.6792);
  assert.equal(costInCny({CNY:2,USD:0}),2);
  assert.equal(costInCny({CNY:0,USD:0}),0);
  for(const value of [null,{}, {CNY:0,USD:NaN},{CNY:0,USD:-1}])assert.equal(costInCny(value),null);
  const jev={currencies:['USD'],points:[{costs:{CNY:0,USD:0}},{costs:usd},{costs:null},{costs:mixed}]};
  const llm={currencies:['CNY'],points:[{costs:{CNY:2,USD:0}}]};
  assert.deepEqual(projectSeries(jev,'cost').map(p=>p.x),[0,6.6792]);
  assert.deepEqual(projectSeries(llm,'cost').map(p=>p.x),[2]);
  assert.deepEqual(usd,{CNY:0,USD:1});
});
test('reader skips corrupt files, refreshes changed files, and HTTP exposes summaries only',async t=>{
  const dir=await directory(t),input=doc();input.session.events[0].result.raw_response={secret:'must-not-expose'};
  const filename=join(dir,input.session.id+'.json');await writeFile(filename,JSON.stringify(input));
  await writeFile(join(dir,randomUUID()+'.json'),'{');
  const read=createStatisticsReader(dir);const first=await read();assert.equal(first.series.length,1);assert.equal(first.excluded.invalid,1);
  const next=doc([event('jev')]);await writeFile(join(dir,next.session.id+'.json'),JSON.stringify(next));
  assert.equal((await read()).series.length,2);
  input.session.events[0].after={...after,score:8};
  input.saved_at='2026-10-20T03:00:00.000Z';
  await writeFile(filename,JSON.stringify(input));
  assert.equal((await read()).series.find(s=>s.key==='llm:direct').score,8);
  await rm(filename);assert.equal((await read()).series.length,1);
  await writeFile(filename,JSON.stringify(input));
  const app=createApp(configFromEnv({}),{archiveDir:dir,fetcher:()=>{throw Error('network forbidden');}});
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
  const base=`http://127.0.0.1:${app.address().port}`;
  const response=await fetch(base+'/api/stats');assert.equal(response.status,200);const text=await response.text();
  assert.ok(!text.includes('must-not-expose'));assert.ok(!text.includes('raw_response'));assert.ok(!text.includes('board'));
  for(const path of ['/stats','/stats.mjs','/stats.css','/chart.mjs'])assert.equal((await fetch(base+path)).status,200);
  assert.equal((await fetch(base+'/logs/'+input.session.id+'.json')).status,404);
  assert.equal((await fetch(base+'/api/stats',{headers:{Origin:'https://example.com'}})).status,403);
});


test('each model strategy selects its own latest game and excludes strategy switches',()=>{
  const summaries=[];
  for(const mode of ['llm','jev'])for(const strategy of ['direct','guided','assisted']) {
    const old=summarizeSession(doc([event(mode,{strategy})],'2026-10-19T00:00:00Z'));
    const current=summarizeSession(doc([event(mode,{strategy})]));
    const latest=latestSessions([old,current]);
    assert.equal(latest.length,1);assert.equal(latest[0].session_id,current.session_id);
    assert.equal(latest[0].key,`${mode}:${strategy}`);summaries.push(current);
  }
  assert.equal(latestSessions(summaries).length,6);
  assert.deepEqual(summarizeSession(doc([event('jev',{strategy:'direct'}),event('jev',{strategy:'assisted'})])),{excluded:'mixed'});
  const failure=event('jev',{status:'failed',after:undefined,strategy:'assisted',result:undefined});
  assert.equal(summarizeSession(doc([failure])).key,'jev:assisted');
  const legacy=event('jev',{result:{prompt_version:'2048-jev-assisted-v1'}});
  assert.equal(summarizeSession(doc([legacy])).key,'jev:assisted');
  const guided=event('llm',{result:{prompt_version:'2048-guide-endless-v3'}});
  assert.equal(summarizeSession(doc([guided])).key,'llm:guided');
});
