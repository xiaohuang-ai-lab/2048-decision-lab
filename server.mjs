import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createStatisticsReader } from './statistics.mjs';
import { createArchive } from './archive.mjs';
import { createConfigStore } from './config-store.mjs';
import { configFromEnv, publicConfig, updateProvider, decide, DemoError } from './providers.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'],
  '/stats': ['stats.html', 'text/html'], '/stats.mjs': ['stats.mjs', 'text/javascript'],
  '/stats.css': ['stats.css', 'text/css'], '/chart.mjs': ['chart.mjs', 'text/javascript'],
  '/game.mjs': ['game.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function createApp(config, { fetcher = fetch, archiveDir = resolve(root, 'logs'), configFile = null } = {}) {
  config = structuredClone(config);
  const configStore = configFile ? createConfigStore(configFile, config) : null;
  const viewConfig = () => Object.fromEntries(Object.entries(publicConfig(config)).map(([mode, value]) => [mode, {
    ...value, storage: configStore ? 'local' : 'memory', saved: configStore?.has(mode) ?? false
  }]));
  let active = false;
  const secrets = new Set([config.llm.key, config.jev.key].filter(Boolean));
  const archive = createArchive(archiveDir, secrets);
  const statistics = createStatisticsReader(archiveDir);
  function json(res, status, value) {
    let content = JSON.stringify(value);
    for (const secret of secrets) content = content.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(content);
  }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const port = req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: '仅支持本地访问' });
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (req.method === 'GET' && path === '/api/stats') {
      if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error:'请求来源无效'});
      try { return json(res, 200, await statistics()); }
      catch { return json(res, 500, {error:'无法读取本地统计，请检查日志目录权限。'}); }
    }
    if (req.method === 'GET' && path === '/api/config') return json(res, 200, viewConfig());
    if (req.method === 'GET' && files[path]) {
      const [file, type] = files[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(readFileSync(resolve(root, 'public', file)));
    }
    if (req.method !== 'POST' || !['/api/decide', '/api/config', '/api/logs'].includes(path)) return json(res, 404, { error: 'Not found' });
    if (req.headers.origin !== `http://${req.headers.host}` || req.headers['x-demo-request'] !== '2048' ||
        !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '请求来源无效' });
    const isLog = path === '/api/logs';
    if (!isLog && active) return json(res, 429, { error: '已有一个模型请求正在执行，请稍后再试。' });
    if (!isLog) active = true;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > (isLog ? 2000000 : 8192)) throw new DemoError('请求过大', 413);
      }
      let payload;
      try { payload = JSON.parse(body); } catch { throw new DemoError('请求不是有效 JSON'); }
      if (isLog) return json(res, 200, await archive.save(payload));
      if (path === '/api/config') {
        const updated = updateProvider(config, payload);
        try { await configStore?.save(payload.mode, updated); }
        catch { throw new DemoError('本地配置保存失败，原配置保持不变。请检查磁盘和 .local 目录权限。', 500); }
        if (updated.key) secrets.add(updated.key);
        config[payload.mode] = updated;
        return json(res, 200, viewConfig());
      }
      const result = await decide(payload, config, controller.signal, fetcher);
      if (!res.destroyed) json(res, 200, result);
    } catch (error) {
      if (!res.destroyed) json(res, error instanceof DemoError ? error.status : 500, {
        error: error instanceof DemoError ? error.message : '本地服务发生错误', evidence: error.evidence || null
      });
    } finally { if (!isLog) active = false; }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = resolve(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || 2048);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
  let server;
  try { server = createApp(configFromEnv(), { configFile: resolve(root, '.local/config.json') }); }
  catch (error) { console.error(error.message); process.exit(1); }
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已占用，请设置其他 PORT。' : '本地服务启动失败。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`2048 决策实验室 → http://127.0.0.1:${port}（不会自动调用模型）`));
}
