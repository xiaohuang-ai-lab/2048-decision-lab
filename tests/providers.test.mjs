import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, publicConfig, buildRequest, decisionInput, decide, parseDecision } from '../providers.mjs';
const board=[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
const payload={mode:'llm',board,score:0,steps:0};
const config=configFromEnv({LLM_API_KEY:'test-llm-secret',TYPESAFE_API_KEY:'test-jev-secret'});
const llmRaw={model:'test-model',choices:[{finish_reason:'stop',message:{content:'{"direction":"left"}'}}],usage:{prompt_tokens:123,completion_tokens:6}};
const jevRaw={model:'jev-1.14.0',answers:{move:{type:'choice',choice:'left',probabilities:{down:.2,left:.6,right:.2},confidence:.7}},usage:{input_tokens:123,output_tokens:30}};
test('providers receive the same state and rule instruction', () => {
  const state=decisionInput(payload), llm=buildRequest('llm',state,config), jev=buildRequest('jev',state,config);
  assert.deepEqual(JSON.parse(llm.messages[1].content),jev.state);
  assert.ok(llm.messages[0].content.startsWith(jev.questions.move.instructions));
  assert.deepEqual(Object.keys(jev.questions.move.criteria),['down','left','right']);
  assert.deepEqual(llm.thinking,{type:'disabled'});
  assert.equal(JSON.stringify(publicConfig(config)).includes('secret'),false);
});
test('Jev and LLM adapters validate documented response shapes', async () => {
  for(const [mode,raw] of [['llm',llmRaw],['jev',jevRaw]]) {
    const result=await decide({...payload,mode},config,new AbortController().signal,async(url,options)=>{
      assert.ok(url.endsWith(mode==='jev'?'/systemone':'/chat/completions'));
      assert.equal(options.redirect,'error');
      assert.ok(options.headers.Authorization.startsWith('Bearer test-'));
      return Response.json(raw);
    });
    assert.equal(result.direction,'left'); assert.deepEqual(result.raw_response,raw);
  }
});
test('malformed choices, probabilities and truncated generations are rejected', () => {
  const allowed=['down','left','right'];
  for(const raw of [
    {...llmRaw,choices:[{finish_reason:'length',message:{content:'{"direction":"left"}'}}]},
    {...llmRaw,choices:[{finish_reason:'stop',message:{content:'{"direction":"up"}'}}]},
    {...llmRaw,choices:[{finish_reason:'stop',message:{content:'not json'}}]}
  ]) assert.throws(()=>parseDecision('llm',raw,allowed));
  for(const probabilities of [{down:.1,left:.1,right:.1},{down:.1,left:.9},{down:-.1,left:.9,right:.2}]) {
    assert.throws(()=>parseDecision('jev',{answers:{move:{...jevRaw.answers.move,probabilities}}},allowed));
  }
});
test('missing config never invokes network; HTTP errors are not retried', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;return new Response('private provider body',{status:429});};
  await assert.rejects(decide(payload,configFromEnv({}),new AbortController().signal,fetcher),/尚未配置/);
  assert.equal(calls,0);
  await assert.rejects(decide(payload,config,new AbortController().signal,fetcher),/HTTP 429/);
  assert.equal(calls,1);
});
test('failed semantic parsing retains raw output and request for inspection', async () => {
  const raw={...llmRaw,choices:[{finish_reason:'stop',message:{content:'{"direction":"up"}'}}]};
  await assert.rejects(decide(payload,config,new AbortController().signal,async()=>Response.json(raw)),error=>{
    assert.deepEqual(error.evidence.raw_response,raw); assert.ok(error.evidence.request); return true;
  });
});
test('extra body cannot override model, messages, stream or output contract', () => {
  const cfg=configFromEnv({LLM_EXTRA_BODY:'{"model":"wrong","stream":true,"messages":[],"max_tokens":999}'});
  const request=buildRequest('llm',decisionInput(payload),cfg);
  assert.equal(request.model,'deepseek-flash'); assert.equal(request.stream,false); assert.equal(request.max_tokens,256); assert.equal(request.messages.length,2);
});

test('observed Jev mismatch warns with original choice and evidence; no retry', async () => {
  // Observed response at 2026-10-19T10:05:04.950Z, replay only; no network.
  const raw={model:'jev-1.14.0',answers:{move:{type:'choice',choice:'left',confidence:.2,probabilities:{up:.4,down:.12,left:.39,right:.09}}},usage:{input_tokens:1269,output_tokens:45}};
  const input={mode:'jev',strategy:'assisted',board:[[128,16,8,0],[64,4,16,2],[32,8,4,0],[16,4,2,2]],score:1340,steps:135};
  let calls=0;
  const result=await decide(input,config,new AbortController().signal,async()=>{calls++;return Response.json(raw);});
  assert.equal(result.direction,'left');
  assert.match(result.warnings[0].message,/choice=left（0.39）.*up（0.4）/);
  assert.equal(result.warnings[0].code,'choice_probability_mismatch');
  assert.deepEqual(result.raw_response,raw);
  assert.deepEqual(result.request.state.board,input.board);
  assert.equal(result.decision_policy,'returned-choice-with-warnings-v2');
  assert.equal(calls,1);
  const tie=structuredClone(raw);tie.answers.move.probabilities={up:.4,down:.1,left:.4,right:.1};
  assert.equal(parseDecision('jev',tie,['up','down','left','right']).direction,'left');
  assert.deepEqual(parseDecision('jev',tie,['up','down','left','right']).warnings,[]);
  tie.answers.move.choice='up'; tie.answers.move.probabilities={up:.39,down:.12,left:.4,right:.09};
  const latest=parseDecision('jev',tie,['up','down','left','right']);
  assert.equal(latest.direction,'up'); assert.equal(latest.warnings[0].highest_choices[0],'left');
  tie.answers.move.choice='invalid';
  assert.throws(()=>parseDecision('jev',tie,['up','down','left','right']));
});
