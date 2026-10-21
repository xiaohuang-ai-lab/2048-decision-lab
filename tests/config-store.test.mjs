import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { configFromEnv } from '../providers.mjs';
import { createConfigStore } from '../config-store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), '2048-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, '.local/config.json') };
}
test('private config survives server recreation, keeps blank keys, clears persistently and never exposes keys', async t => {
  const { dir, file } = await fixture(t);
  const env = { TYPESAFE_API_KEY: 'fixture-env-jev-secret' };
  const start = async () => {
    const server = createApp(configFromEnv(env), { configFile: file, archiveDir: join(dir, 'logs') });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, post: body => fetch(base + '/api/config', { method:'POST', headers: { Origin:base, 'Content-Type':'application/json', 'X-Demo-Request':'2048' }, body:JSON.stringify(body) }) };
  };
  const first = await start();
  const input = { mode:'llm', base:'https://api.deepseek.com', model:'deepseek-flash', key:'fixture-persistent-secret' };
  let response = await first.post(input);
  assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(!text.includes(input.key));
  assert.equal(JSON.parse(text).llm.saved, true);
  assert.equal((await first.post({ ...input, model:'edited-model', key:'' })).status, 200);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.providers.llm.key, input.key);
  assert.equal(stored.providers.jev, undefined); // Saving LLM never silently persists env Jev key.
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, '.local'))).mode & 0o777, 0o700);
  const second = await start();
  const restored = await (await fetch(second.base + '/api/config')).json();
  assert.equal(restored.llm.model, 'edited-model'); assert.equal(restored.llm.configured, true);
  assert.equal((await fetch(second.base + '/.local/config.json')).status, 404);
  assert.equal((await second.post({ mode:'llm', clear:true })).status, 200);
  assert.equal((await second.post({ mode:'jev', clear:true })).status, 200);
  const third = await start();
  const cleared = await (await fetch(third.base + '/api/config')).json();
  assert.equal(cleared.llm.configured, false); assert.equal(cleared.jev.configured, false);
  const clearedText = await readFile(file, 'utf8');
  assert.ok(!clearedText.includes(input.key)); assert.ok(!clearedText.includes(env.TYPESAFE_API_KEY));
});
test('corrupt stored config fails closed without overwriting or printing its contents', async t => {
  const { file } = await fixture(t);
  createConfigStore(file, configFromEnv({}));
  await writeFile(file, 'invalid fixture-secret-json', { mode:0o600 });
  assert.throws(() => createConfigStore(file, configFromEnv({})), error => {
    assert.ok(!error.message.includes('fixture-secret')); return /无法读取/.test(error.message);
  });
  assert.equal(await readFile(file, 'utf8'), 'invalid fixture-secret-json');
});
test('failed atomic write leaves stored configuration intact and removes temporary files', async t => {
  const { dir, file } = await fixture(t);
  const config = configFromEnv({}); const store = createConfigStore(file, config);
  await store.save('llm', { ...config.llm, key:'old-fixture-key' });
  const original = await readFile(file, 'utf8');
  await assert.rejects(store.save('llm', { ...config.llm, key:1n }));
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(join(dir, '.local')), ['config.json']);
});
