import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLocal, SEARCH } from '../local-ai.mjs';
import { legalMoves } from '../public/game.mjs';
import { decide, configFromEnv } from '../providers.mjs';
import { estimateCost, summarizeCosts, summarizeUsage, terminalBlocks } from '../public/app.mjs';
const board=[[128,64,32,16],[8,4,2,0],[4,2,0,0],[2,0,0,0]];
test('local search is deterministic, legal, bounded and preserves input',()=>{
  const copy=structuredClone(board), a=chooseLocal(board), b=chooseLocal(board);
  assert.deepEqual(board,copy);assert.equal(a.direction,b.direction);assert.deepEqual(a.scores,b.scores);
  assert.deepEqual(Object.keys(a.scores),legalMoves(board));
  assert.ok(a.search.visited_nodes<=SEARCH.node_budget);
  assert.ok(a.search.completed_depth>=1);
  const shallow=chooseLocal(board,{max_depth:1,node_budget:500});
  const limited=chooseLocal(board,{max_depth:3,node_budget:500});
  assert.equal(limited.search.completed_depth,1);assert.equal(limited.search.budget_exhausted,true);
  assert.deepEqual(limited.scores,shallow.scores); // discard the entire partial next depth
});
test('forced move and terminal inputs',()=>{
  const forced=[[2,4,8,16],[4,8,16,32],[8,16,32,64],[0,0,0,0]];
  assert.deepEqual(legalMoves(forced),['down']);assert.equal(chooseLocal(forced).direction,'down');
  assert.throws(()=>chooseLocal([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]]),/结束/);
  assert.throws(()=>chooseLocal([]));
});
test('local adapter requires no key or external network; usage and logs stay honest',async()=>{
  const result=await decide({mode:'local',board,score:0,steps:0},configFromEnv({}),new AbortController().signal,()=>{throw new Error('external network forbidden');});
  assert.equal(result.strategy,'expectimax');assert.equal(result.usage,null);
  const event={mode:'local',status:'applied',result};
  assert.equal(estimateCost(event).amount,0);assert.equal(summarizeUsage([event]).requests,0);
  assert.equal(summarizeCosts([event]).unknown,0);
  assert.ok(terminalBlocks(event).some(x=>x.label.startsWith('LOCAL')));
  assert.ok(terminalBlocks(event).some(x=>x.text.includes('不适用')));
});
