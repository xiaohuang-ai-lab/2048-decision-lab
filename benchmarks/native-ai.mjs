import { chooseNative, createNativeEngine, NATIVE_VERSION, NATIVE_SEARCH } from '../native-ai.mjs';
import { newGame, move, spawn, maxTile, legalMoves } from '../public/game.mjs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const count=Number(process.argv[2]||100), parallel=4;
if(!Number.isInteger(count)||count<1||count>1000)throw new Error('invalid count');
const dir=new URL('./native-v1/',import.meta.url);await mkdir(dir,{recursive:true});
const seeds=Array.from({length:count},(_,i)=>['xiaohuang-001','local-baseline-002','local-baseline-003'][i] || `native-validation-${String(i+1).padStart(3,'0')}`);
let previous;try {previous=JSON.parse(await readFile(new URL('results.json',dir),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(previous && previous.algorithm!==NATIVE_VERSION)throw new Error('existing benchmark version differs');
const started=previous?.started || new Date().toISOString(),results=previous?.results.filter(r=>seeds.includes(r.seed)) || [];
const todo=seeds.filter(seed=>!results.some(r=>r.seed===seed));
let queue=Promise.resolve();
async function save() {
 const snapshot=JSON.stringify({started,updated:new Date().toISOString(),node:process.version,platform:process.platform,algorithm:NATIVE_VERSION,search:NATIVE_SEARCH,parallel_workers:parallel,latency_note:'May include contention from parallel validation and browser testing; early resumed runs were sequential.',target_games:count,completed_games:results.length,results:[...results].sort((a,b)=>seeds.indexOf(a.seed)-seeds.indexOf(b.seed))},null,2)+'\n';
 queue=queue.then(()=>writeFile(new URL('results.json',dir),snapshot));await queue;
}
await Promise.all(Array.from({length:parallel},async()=>{
 const runner=createNativeEngine();
 try {
  while(todo.length) {
   const seed=todo.shift(),game=newGame(seed),times=[],searchTimes=[],trace=[];
   while(game.steps<2000 && maxTile(game.board)<2048 && legalMoves(game.board).length) {
    const before=game.board,result=await chooseNative(before,undefined,runner);
    const moved=move(before,result.direction);
    if(!moved.changed)throw new Error('illegal action');
    const spawned=spawn(moved.board,game.random);
    game.board=spawned.board;game.steps++;game.score+=moved.gained;
    times.push(result.latency_ms);searchTimes.push(result.search_ms);
    trace.push({step:game.steps,before,result,spawned:spawned.spawned,after:game.board,score:game.score});
   }
   const sorted=[...times].sort((a,b)=>a-b),mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
   const summary={seed,steps:game.steps,score:game.score,max_tile:maxTile(game.board),won:maxTile(game.board)>=2048,mean_ms:mean(times),p90_ms:sorted[Math.floor(sorted.length*.9)],mean_search_ms:mean(searchTimes)};
   await writeFile(new URL(seed+'.json.gz',dir),gzipSync(JSON.stringify(trace)));
   results.push(summary);await save();
   console.log(JSON.stringify({completed:results.length,...summary}));
  }
 }finally {runner.close();}
}));
