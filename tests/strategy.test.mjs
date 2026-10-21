import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMoves,layoutFeatures,ASSISTED_VERSION,GUIDED_INSTRUCTIONS} from '../strategy.mjs';
import {decisionInput,buildRequest,configFromEnv,decide} from '../providers.mjs';
const board=[[2,2,8,4],[4,16,128,8],[2,4,16,32],[4,16,8,4]];
const payload={mode:'jev',strategy:'assisted',board,score:1048,steps:112};
const config=configFromEnv({TYPESAFE_API_KEY:'strategy-test-only'});
test('reproduces the observed last-move risk: left zero, right 90 percent',()=>{
 const before=structuredClone(board),result=analyzeMoves(board);
 assert.deepEqual(Object.keys(result),['left','right']);
 assert.equal(result.left.immediate_loss_probability,0);
 assert.equal(result.right.immediate_loss_probability,.9);
 assert.equal(result.left.merge_score,4);assert.equal(result.right.merge_score,4);
 assert.deepEqual(result.left.board_after_move[0],[4,8,4,0]);
 assert.deepEqual(board,before);
});
test('features distinguish pre-spawn board from post-spawn free space and loss beyond 2048',()=>{
 const result=analyzeMoves([[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
 assert.equal(result.left.empty_cells_after_spawn,14);
 assert.equal(result.left.merge_count,1);assert.equal(result.left.max_tile_in_upper_left,true);
 assert.equal(result.left.immediate_loss_probability,0);
 const goal=analyzeMoves([[1024,1024,8,4],[4,16,128,8],[2,4,16,32],[4,16,8,4]]);
 assert.equal(goal.right.max_tile,2048);assert.equal(goal.right.immediate_loss_probability,.9);
});
test('enhanced strategy is explicit, retains all legal choices and leaves baseline unchanged',()=>{
 const assisted=decisionInput(payload), direct=decisionInput({...payload,strategy:'direct'});
 assert.equal(direct.move_analysis,undefined);
 const req=buildRequest('jev',assisted,config);
 assert.deepEqual(Object.keys(req.questions.move.criteria),['left','right']);
 assert.match(req.questions.move.instructions,/NOT the probability of eventually losing/);
 assert.match(req.questions.move.criteria.right,/move_analysis.right/);
 assert.deepEqual(decisionInput({...payload,mode:'llm'}),assisted);
 assert.ok(buildRequest('llm',assisted,config).messages[0].content.startsWith(req.questions.move.instructions));
 const guided=decisionInput({...payload,strategy:'guided',recent_actions:['left','up']});
 assert.equal(guided.move_analysis,undefined);
 assert.deepEqual(guided.recent_actions,['left','up']);
 assert.equal(buildRequest('jev',guided,config).questions.move.instructions,GUIDED_INSTRUCTIONS);
 assert.equal(decisionInput({...payload,strategy:'direct',recent_actions:['up']}).recent_actions,undefined);
 assert.throws(()=>decisionInput({...payload,recent_actions:['invalid']}),/历史动作无效/);
 assert.throws(()=>decisionInput({...payload,strategy:'unknown'}),/策略无效/);
});

test('snake order, occupied-neighbor gaps and merge opportunities have explicit definitions',()=>{
 const snake=[[1024,512,256,128],[8,16,32,64],[4,2,0,0],[0,0,0,0]];
 const features=layoutFeatures(snake);
 assert.equal(features.snake_inversion_penalty,0);
 assert.equal(features.top_row_full,true);assert.equal(features.anchor_empty,false);
 const broken=structuredClone(snake);[broken[0][0],broken[0][1]]=[broken[0][1],broken[0][0]];
 assert.ok(layoutFeatures(broken).snake_inversion_penalty>0);
 const pairs=layoutFeatures([[2,2,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]]);
 assert.equal(pairs.adjacent_equal_pairs,2); // overlapping, not two executable merges
 assert.equal(pairs.adjacent_exponent_gap,0);
 const analysis=analyzeMoves(board);
 assert.equal(analysis.right.worst_next_legal_moves,0);
 assert.ok(analysis.left.worst_next_legal_moves>0);
 for(const a of Object.values(analysis)){
  assert.ok(a.expected_next_legal_moves>=a.worst_next_legal_moves);
  assert.ok(a.expected_next_legal_moves<=4);
 }
});
test('adapter preserves strategy and prompt version on both success and failure; no action override',async()=>{
 const raw={model:'LOCAL-TEST-FIXTURE',answers:{move:{type:'choice',choice:'right',probabilities:{left:.46,right:.54},confidence:.08}}};
 const result=await decide(payload,config,new AbortController().signal,async()=>Response.json(raw));
 assert.equal(result.direction,'right'); // preserve model choice, even though left has lower immediate risk
 assert.equal(result.strategy,'assisted');assert.equal(result.prompt_version,ASSISTED_VERSION);
 assert.equal(result.request.state.move_analysis.right.immediate_loss_probability,.9);
 await assert.rejects(decide(payload,config,new AbortController().signal,async()=>new Response('test',{status:429})),error=>{
  assert.equal(error.evidence.strategy,'assisted');assert.equal(error.evidence.prompt_version,ASSISTED_VERSION);return true;
 });
});
