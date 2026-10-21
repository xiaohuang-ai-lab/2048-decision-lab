import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { configFromEnv } from '../providers.mjs';
const payload={mode:'llm',board:[[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],score:0,steps:0};
async function start(server,t) {
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${server.address().port}`;
}
test('HTTP adapter end-to-end against a local fake provider (no real model calls)', async t => {
  const requests=[];
  const provider=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({path:req.url,body:JSON.parse(body)});
    const raw=req.url==='/systemone' ? {model:'fake-jev',answers:{move:{type:'choice',choice:'left',probabilities:{down:.2,left:.6,right:.2},confidence:.7}}} : {model:'fake-llm',choices:[{finish_reason:'stop',message:{content:'{"direction":"left"}'}}]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(raw));
  });
  const upstream=await start(provider,t);
  const config=configFromEnv({LLM_BASE_URL:upstream,TYPESAFE_BASE_URL:upstream,LLM_API_KEY:'fake-secret-a',TYPESAFE_API_KEY:'fake-secret-b'});
  const base=await start(createApp(config),t);
  for(const mode of ['llm','jev']) {
    const response=await fetch(base+'/api/decide',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Demo-Request':'2048'},body:JSON.stringify({...payload,mode})});
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.direction,'left');assert.equal(result.model,`fake-${mode}`);
    assert.equal(JSON.stringify(result).includes('fake-secret'),false);
  }
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content),requests[1].body.state);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/providers.mjs')).status,404);
  assert.equal((await fetch(base+'/')).status,200);
  const cfg=await(await fetch(base+'/api/config')).text();assert.equal(cfg.includes('fake-secret'),false);
  assert.equal((await fetch(base+'/api/decide',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json','X-Demo-Request':'2048'},body:JSON.stringify(payload)})).status,403);
  assert.equal(requests.length,2);
  const invalid=await fetch(base+'/api/decide',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Demo-Request':'2048'},body:JSON.stringify({...payload,board:[]})});
  assert.equal(invalid.status,400);assert.equal(requests.length,2);
});
test('concurrency lock, client cancellation, and upstream timeout', async t => {
  let startedResolve, abortedResolve;
  const started=new Promise(r=>{startedResolve=r;}), aborted=new Promise(r=>{abortedResolve=r;});
  const fetcher=async(url,{signal})=>new Promise((resolve,reject)=>{
    startedResolve();
    signal.addEventListener('abort',()=>{abortedResolve();reject(signal.reason);},{once:true});
  });
  const config=configFromEnv({LLM_API_KEY:'fake',REQUEST_TIMEOUT_MS:'1000'});
  const base=await start(createApp(config,{fetcher}),t);
  const headers={Origin:base,'Content-Type':'application/json','X-Demo-Request':'2048'};
  const controller=new AbortController();
  const first=fetch(base+'/api/decide',{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal}).catch(e=>e);
  await started;
  const second=await fetch(base+'/api/decide',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(second.status,429);
  controller.abort();await first;await aborted;
  const timeoutBase=await start(createApp({...config,timeout:100},{fetcher}),t);
  const timed=await fetch(timeoutBase+'/api/decide',{method:'POST',headers:{...headers,Origin:timeoutBase},body:JSON.stringify(payload)});
  assert.equal(timed.status,502);assert.match((await timed.json()).error,/超时/);
});

test('form configuration is memory-only, never echoes keys, and is used by decisions', async t => {
  let calls=0, auth;
  const original=configFromEnv({});
  const base=await start(createApp(original,{fetcher:async(url,options)=>{
    calls++;auth=options.headers.Authorization;
    return Response.json({model:'configured-model',choices:[{finish_reason:'stop',message:{content:'{"direction":"left"}'}}]});
  }}),t);
  const headers={Origin:base,'Content-Type':'application/json','X-Demo-Request':'2048'};
  const post=async(data,origin=base)=>fetch(base+'/api/config',{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify(data)});
  const input={mode:'llm',base:'https://api.example.com/v1',model:'configured-model',key:'local-test-key-123456'};
  const saved=await post(input);assert.equal(saved.status,200);
  const text=await saved.text();assert.equal(text.includes(input.key),false);
  assert.equal(JSON.parse(text).llm.configured,true);assert.equal(calls,0);
  assert.equal(original.llm.key,''); // createApp owns a separate in-memory configuration.
  assert.equal((await post({...input,key:'',model:'edited-model'})).status,200);
  assert.equal((await post({...input,base:'https://other.example.com',key:''})).status,400);
  assert.equal((await post(input,'https://evil.example')).status,403);
  for(const invalid of [{...input,base:'http://external.example'}, {...input,base:'https://user:secret@example.com'}, {...input,base:'https://example.com?key=secret'}, {...input,model:''}, {...input,key:'bad\nkey'}]) {
    assert.equal((await post(invalid)).status,400);
  }
  const response=await fetch(base+'/api/decide',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(response.status,200);assert.equal(auth,'Bearer '+input.key);assert.equal(calls,1);
  assert.equal((await response.json()).requested_model,'edited-model');
  const cleared=await post({mode:'llm',clear:true});assert.equal((await cleared.json()).llm.configured,false);
  assert.equal((await fetch(base+'/api/config')).status,200);
  const fresh=await start(createApp(original),t);
  assert.equal((await(await fetch(fresh+'/api/config')).json()).llm.configured,false);
  assert.equal(calls,1);
});
