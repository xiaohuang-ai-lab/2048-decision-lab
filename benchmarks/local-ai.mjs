import { chooseLocal, LOCAL_VERSION, SEARCH } from '../local-ai.mjs';
import { newGame, move, spawn, maxTile, legalMoves } from '../public/game.mjs';
import { writeFile } from 'node:fs/promises';
const results=[];
for (const seed of ['xiaohuang-001','local-baseline-002','local-baseline-003']) {
  const game=newGame(seed), times=[], depths={};
  const trace=[];
  while(game.steps<2000 && maxTile(game.board)<2048 && legalMoves(game.board).length) {
    const result=chooseLocal(game.board), before=game.board;
    times.push(result.latency_ms);depths[result.search.completed_depth]=(depths[result.search.completed_depth]||0)+1;
    const moved=move(game.board,result.direction), spawned=spawn(moved.board,game.random);
    game.board=spawned.board;game.score+=moved.gained;game.steps++;
    trace.push({step:game.steps,before,result,spawned:spawned.spawned,after:game.board,score:game.score});
  }
  const sorted=[...times].sort((a,b)=>a-b);
  const summary={seed,steps:game.steps,score:game.score,max_tile:maxTile(game.board),won:maxTile(game.board)>=2048,mean_ms:times.reduce((a,b)=>a+b,0)/times.length,p90_ms:sorted[Math.floor(sorted.length*.9)],depths};
  results.push(summary); console.log(JSON.stringify(summary));
  await writeFile(new URL(`./${seed}-trace.json`,import.meta.url),JSON.stringify(trace));
}
await writeFile(new URL('./local-results.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),node:process.version,platform:process.platform,algorithm:LOCAL_VERSION,search:SEARCH,results},null,2)+'\n');
