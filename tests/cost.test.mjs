import test from 'node:test';
import assert from 'node:assert/strict';
import {pricingSnapshot,estimateCost,summarizeCosts,costText} from '../public/app.mjs';
const provider={provider:'api.deepseek.com',model:'deepseek-flash'};
const price=(period='peak')=>pricingSnapshot('llm',provider,'2026-10-19T09:31:00Z',period);
const event=(usage,extra={})=>({mode:'llm',status:'applied',pricing:price(),result:{usage},...extra});
test('reproduces the observed 20-step cost and handles offpeak rates',()=>{
 const e=event({prompt_tokens:4626,completion_tokens:100,prompt_cache_hit_tokens:0});
 assert.ok(Math.abs(estimateCost(e).amount-0.010052)<1e-12);
 assert.ok(Math.abs(estimateCost({...e,pricing:price('offpeak')}).amount-0.005026)<1e-12);
});
test('counts cached input once and never adds reasoning subsets twice',()=>{
 const cost=estimateCost(event({prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:600},completion_tokens_details:{reasoning_tokens:50}}));
 assert.ok(Math.abs(cost.amount-(400*2+600*.04+100*8)/1e6)<1e-12);
});
test('missing cache uses a declared uncached assumption; missing billable usage is unknown',()=>{
 assert.match(estimateCost(event({prompt_tokens:5,completion_tokens:2})).assumptions.join(''),/全部未命中/);
 assert.equal(estimateCost(event({prompt_tokens:5})).status,'unknown');
 assert.equal(estimateCost(event(null,{status:'cancelled'})).status,'unknown');
 assert.equal(estimateCost(event({prompt_tokens:0,completion_tokens:0})).amount,0);
 assert.equal(estimateCost(event({prompt_tokens:5,completion_tokens:1,prompt_cache_hit_tokens:6})).status,'unknown');
});
test('free Jev output does not require an output count; input is still required',()=>{
 const pricing=pricingSnapshot('jev',{provider:'api.typesafe.ai',model:'jev-1.14.0'},'2026-10-19');
 const cost=estimateCost({mode:'jev',status:'applied',pricing,result:{usage:{input_tokens:1000}}});
 assert.equal(cost.currency,'USD');assert.equal(cost.amount,0.000042);
 assert.equal(estimateCost({mode:'jev',status:'failed',pricing}).status,'unknown');
});
test('fees with error evidence count; mixed currencies remain separate',()=>{
 const failed=event(null,{status:'failed',evidence:{raw_response:{usage:{prompt_tokens:100,completion_tokens:10}}}});
 const jev={mode:'jev',status:'applied',pricing:pricingSnapshot('jev',{provider:'api.typesafe.ai',model:'jev-latest'},'2026-10-19'),result:{usage:{input_tokens:1000,output_tokens:10}}};
 const stats=summarizeCosts([failed,jev,{mode:'manual'},event(null,{status:'pending'}),event(null)]);
 assert.equal(stats.CNY.count,1);assert.equal(stats.USD.count,1);assert.equal(stats.unknown,1);assert.equal(stats.pending,1);
 assert.equal(stats.USD.amount,0.000042);
});
test('Beijing clock boundaries and weekends select expected periods; overrides are explicit',()=>{
 const period=t=>pricingSnapshot('llm',provider,t).period;
 assert.equal(period('2026-10-19T01:00:00Z'),'peak');
 assert.equal(period('2026-10-19T04:00:00Z'),'offpeak');
 assert.equal(period('2026-10-19T06:00:00Z'),'peak');
 assert.equal(period('2026-10-19T10:00:00Z'),'offpeak');
 assert.equal(period('2026-10-18T09:00:00Z'),'offpeak');
 assert.equal(pricingSnapshot('llm',provider,'2026-10-19T09:00:00Z','offpeak').period,'offpeak');
 assert.match(price('auto').assumptions.join(''),/未识别中国法定节假日/);
});
test('custom endpoints and unknown models are not assigned another providers rates',()=>{
 assert.equal(pricingSnapshot('llm',{...provider,provider:'example.com'},'2026-10-19'),null);
 assert.equal(pricingSnapshot('llm',{...provider,model:'unknown'},'2026-10-19'),null);
 assert.equal(estimateCost(event({input_tokens:1,output_tokens:1},{pricing:null})).status,'unknown');
 assert.equal(costText({status:'estimated',amount:0.0000001,currency:'USD'}),'US$<0.000001');
});
