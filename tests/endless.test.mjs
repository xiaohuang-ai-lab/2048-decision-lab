import test from 'node:test';
import assert from 'node:assert/strict';
import { move, isGameOver, isGameFinished, legalMoves } from '../public/game.mjs';
import { chooseLocal, LOCAL_VERSION } from '../local-ai.mjs';
import { chooseNative, closeNative } from '../native-ai.mjs';
import { decide, configFromEnv, decisionInput, buildRequest } from '../providers.mjs';

const row = values => [values, [0,0,0,0], [0,0,0,0], [0,0,0,0]];
test('2048 and larger merges keep playing, only a blocked board ends the game', () => {
  for (const value of [1024,2048,4096,32768,131072]) {
    const result = move(row([value,value,0,0]), 'left');
    assert.equal(result.board[0][0], value*2);
    assert.equal(result.gained, value*2);
    assert.equal(isGameOver(result.board), false);
    assert.equal(isGameFinished(result.board,'target-2048-v1'),true);
    assert.equal(isGameFinished(result.board,'endless-v1'),false);
    assert.ok(decisionInput({mode:'local',board:result.board,score:result.gained,steps:1001}).available_moves.length);
  }
  assert.equal(isGameOver([[2048,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]]),true);
});
test('both models use the capped objective and reject endless or completed games before network calls', async () => {
  const board=row([1024,1024,0,0]);
  const config=configFromEnv({LLM_API_KEY:'test-only',TYPESAFE_API_KEY:'test-only'});
  for(const mode of ['jev','llm']) for(const strategy of ['direct','guided','assisted']) {
    const payload={mode,strategy,board,score:18000,steps:1001,objective:'target-2048-v1'};
    const req=buildRequest(mode,decisionInput(payload),config);
    const instructions=mode==='jev'?req.questions.move.instructions:req.messages[0].content;
    assert.match(instructions,/Reaching 2048 wins and ends the game/);
    const raw=mode==='jev'?{answers:{move:{type:'choice',choice:'left',probabilities:{left:.6,right:.2,down:.2},confidence:.4}}}:{choices:[{finish_reason:'stop',message:{content:'{"direction":"left"}'}}]};
    const result=await decide(payload,config,new AbortController().signal,async()=>Response.json(raw));
    assert.equal(result.direction,'left');assert.match(result.prompt_version,/target/);
    const noNetwork=()=>{throw Error('unexpected network');};
    await assert.rejects(decide({...payload,objective:'endless-v1'},config,new AbortController().signal,noNetwork),/无限模式不支持/);
    await assert.rejects(decide({...payload,board:row([2048,0,0,0])},config,new AbortController().signal,noNetwork),/已达到 2048/);
  }
  assert.throws(()=>decisionInput({mode:'local',board:row([2048,0,0,0]),score:0,steps:0,objective:'target-2048-v1'}),/已达到 2048/);
});
test('both local engines continue after 2048; large ranks explicitly fall back without network', async t => {
  t.after(closeNative);
  for(const value of [2048,4096]) {
    const board=row([value,value,0,0]);
    assert.ok(legalMoves(board).includes(chooseLocal(board).direction));
    assert.ok(legalMoves(board).includes((await chooseNative(board)).direction));
  }
  const board=row([32768,32768,0,0]);
  const result=await decide({mode:'local',local_engine:'nneonneo',board,score:0,steps:0},configFromEnv({}),new AbortController().signal,()=>{throw Error('no network');});
  assert.equal(result.model,LOCAL_VERSION);
  assert.notEqual(result.requested_model,result.model);
  assert.equal(result.warnings[0].code,'native_rank_limit');
  assert.ok(legalMoves(board).includes(result.direction));
  assert.equal(result.usage,null);
});
