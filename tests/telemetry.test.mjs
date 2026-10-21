import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, eventUsage, summarizeUsage, terminalBlocks, retryPlan } from '../public/app.mjs';

test('maps Jev and Chat Completions usage without double-counting subsets', () => {
  assert.deepEqual(normalizeUsage({input_tokens:120,output_tokens:20}),{input:120,output:20,total:140,cached:null,reasoning:null});
  assert.deepEqual(normalizeUsage({prompt_tokens:120,completion_tokens:20,total_tokens:140,prompt_tokens_details:{cached_tokens:70},completion_tokens_details:{reasoning_tokens:5}}),{input:120,output:20,total:140,cached:70,reasoning:5});
  assert.equal(normalizeUsage({prompt_cache_hit_tokens:50}).cached,50);
});
test('distinguishes missing usage, reported zero, partial usage and invalid values', () => {
  assert.deepEqual(normalizeUsage(null),{input:null,output:null,total:null,cached:null,reasoning:null});
  assert.equal(normalizeUsage({input_tokens:0,output_tokens:0}).total,0);
  assert.equal(normalizeUsage({input_tokens:10}).total,null);
  assert.equal(normalizeUsage({input_tokens:-2,output_tokens:'5',total_tokens:NaN}).total,null);
});
test('counts failed and discarded usage and excludes manual events', () => {
  const failed={mode:'llm',status:'failed',evidence:{raw_response:{usage:{prompt_tokens:30,completion_tokens:4}}}};
  assert.equal(eventUsage(failed).total,34);
  const stats=summarizeUsage([
    {mode:'manual',status:'applied'},
    {mode:'jev',status:'applied',result:{usage:{input_tokens:10,output_tokens:0}}}, failed,
    {mode:'jev',status:'cancelled'}, {mode:'llm',status:'pending'},
    {mode:'llm',status:'discarded',result:{usage:{prompt_tokens:7,completion_tokens:3}}}
  ]);
  assert.equal(stats.requests,5);assert.equal(stats.input,47);assert.equal(stats.output,7);assert.equal(stats.total,54);
  assert.equal(stats.known.total,3);assert.equal(stats.unknown,1);assert.equal(stats.pending,1);assert.equal(stats.failed,3);
  assert.equal(stats.applied,1);
});

test('terminal preserves exact LLM content and separates execution from model output', () => {
  const content='  {"direction": "left"}\n';
  const blocks=terminalBlocks({mode:'llm',status:'applied',direction:'left',gained:4,after:{score:8},result:{raw_response:{choices:[{message:{content}}]}}});
  assert.equal(blocks[0].text,content);
  assert.equal(blocks.filter(b=>b.kind==='execute').length,1);
  assert.match(blocks.find(b=>b.kind==='usage').text,/total=unknown/);
});
test('terminal preserves Jev choice fields and can display the full response', () => {
  const answer={choice:'left',probabilities:{left:0.8,right:0.2},confidence:0.7};
  const raw={answers:{move:answer},usage:{input_tokens:10,output_tokens:2}};
  const event={mode:'jev',status:'failed',evidence:{raw_response:raw},error:'test error'};
  assert.deepEqual(JSON.parse(terminalBlocks(event)[0].text),answer);
  assert.deepEqual(JSON.parse(terminalBlocks(event,true)[0].text),raw);
  assert.ok(!terminalBlocks(event).some(b=>b.kind==='execute'));
});
test('terminal shows actual tool and legacy function fields on rejected responses', () => {
  for (const field of ['tool_calls','function_call']) {
    const call={name:'move',arguments:'{"direction":"left"}'};
    const value=field==='tool_calls'?[{id:'fixture',type:'function',function:call}]:call;
    const blocks=terminalBlocks({mode:'llm',status:'failed',error:'Unexpected completion',evidence:{raw_response:{choices:[{message:{content:null,[field]:value}}]}}});
    assert.deepEqual(JSON.parse(blocks.find(b=>b.kind==='tool').text),value);
    assert.ok(blocks.some(b=>b.kind==='error'));
    assert.ok(!blocks.some(b=>b.kind==='execute'));
  }
});
test('pending terminal contains no invented output or token usage', () => {
  const blocks=terminalBlocks({mode:'jev',status:'pending'});
  assert.deepEqual(blocks.map(b=>b.kind),['pending']);
});

test('a warning remains visible alongside execution and is not counted as failure', () => {
  const event={mode:'jev',status:'applied',direction:'up',gained:0,after:{score:4},result:{warnings:[{code:'choice_probability_mismatch',message:'fixture warning'}]}};
  const blocks=terminalBlocks(event);
  assert.equal(blocks.find(b=>b.kind==='warning').text,'fixture warning');
  assert.ok(blocks.some(b=>b.kind==='execute'));
  assert.ok(!blocks.some(b=>b.kind==='error'));
  assert.equal(summarizeUsage([event]).failed,0);
  assert.equal(summarizeUsage([event]).applied,1);
});

test('five retries follow the initial failure; retry metadata stays separate from model output', () => {
  for (let failures=1;failures<=5;failures++) assert.deepEqual(retryPlan(failures),{retry:true,delay_ms:1000,max_retries:5});
  assert.equal(retryPlan(6).retry,false);
  const event={mode:'llm',status:'failed',error:'invalid direction',retry:{attempt:2,max_retries:5,next_scheduled:true},evidence:{raw_response:{usage:{prompt_tokens:20,completion_tokens:4}}}};
  const blocks=terminalBlocks(event);
  assert.match(blocks.find(b=>b.label.startsWith('RETRY')).text,/第 2 次请求/);
  assert.equal(summarizeUsage([event]).total,24);
  assert.equal(summarizeUsage([event]).failed,1);
});
