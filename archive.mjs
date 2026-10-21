import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateBoard, maxTile, legalMoves } from './public/game.mjs';
import { summarizeUsage } from './public/app.mjs';
import { DemoError } from './providers.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function snapshot(value) {
  try { validateBoard(value.board); } catch { throw new DemoError('日志棋盘无效'); }
  if (!Number.isSafeInteger(value.score) || value.score < 0 || !Number.isSafeInteger(value.steps) || value.steps < 0) throw new DemoError('日志分数或步号无效');
  return { board: value.board, score: value.score, steps: value.steps };
}
export function sanitizeLog(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    return value.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => sanitizeLog(v,secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,v]) =>
    [key, /^(authorization|proxy.authorization|api.?key|key|password|secret|access.?token|refresh.?token|cookie|set.cookie)$/i.test(key) ? '[REDACTED]' : sanitizeLog(v,secrets)]));
  return value;
}
function overview(data) {
  const session=data.session, events=session.events, stats=summarizeUsage(events), final=session.final || session.initial;
  const n=x=>x===null?'未知':x;
  const objective=events.at(-1)?.run_settings?.objective;
  const finished=objective==='target-2048-v1' && maxTile(final.board)>=2048;
  return `# 2048 对局资料\n\n- 对局 ID：${session.id}\n- 开始时间：${session.created_at}\n- 最近保存：${data.saved_at}\n- 种子：${JSON.stringify(session.seed)}\n- 模型：${[...new Set(events.filter(e=>e.mode!=='manual').map(e=>e.result?.model || e.requested_model || e.mode))].join(' / ') || '无模型调用'}\n- 决策策略：${[...new Set(events.filter(e=>e.mode!=='manual').map(e=>e.mode+' / '+(e.result?.algorithm_version || e.result?.prompt_version || e.evidence?.prompt_version || e.strategy || 'direct')))].join(' / ') || '无模型请求'}\n- 玩法：${objective==='target-2048-v1'?'2048 封顶':objective==='endless-v1'?'无限挑战':'历史记录未标明'}\n- 当前结果：${final.steps} 步 / ${final.score} 分 / 最大 ${maxTile(final.board)}\n- 棋盘状态：${finished?'达到 2048，挑战成功':!legalMoves(final.board).length?'无有效方向，结束':'尚可继续（不代表已完成整局）'}\n- 响应警告：${events.reduce((n,e)=>n+(e.result?.warnings?.length || 0),0)} 条（详见同名 JSON 的 result.warnings）\n- 模型 API 请求：${stats.requests}；已执行 ${stats.applied}；失败/取消/丢弃 ${stats.failed}；等待或未确认 ${stats.pending}\n- 本地算法决策：${events.filter(e=>e.mode==='local').length} 次；无 API Token 或费用\n- 已报告输入 Token：${n(stats.known.input?stats.input:null)}；输出：${n(stats.known.output?stats.output:null)}；合计：${n(stats.known.total?stats.total:null)}\n- 输入或输出用量未知的已结束请求：${stats.unknown}\n\n原始证据见同名 JSON，包括每次请求、原始返回、提示词版本、用量、时间线和前后棋盘。模型字段来自 API 返回；动作是否执行来自浏览器记录。pending 可能表示尚未收到最终记录，不能视作成功或未计费。单局不能推断通用胜率；混合模式不能归功于单一模型；未计算价格或账单。\n`;
}
export function createArchive(directory, secrets = new Set()) {
  const root=resolve(directory);
  let queue=Promise.resolve();
  async function atomic(path, content) {
    const temp=path+'.'+randomUUID()+'.tmp';
    try {
      const handle=await open(temp,'wx',0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await rename(temp,path);
    } finally { await unlink(temp).catch(()=>{}); }
  }
  async function write(payload) {
    const s=payload?.session;
    const events=payload?.events ?? (payload?.event ? [payload.event] : []);
    if (!Array.isArray(events) || events.length>100) throw new DemoError('日志批次数量无效');
    if (!s || !uuid.test(s.id) || typeof s.seed!=='string' || s.seed.length>200 || typeof s.created_at!=='string' || !Number.isFinite(Date.parse(s.created_at))) throw new DemoError('日志对局信息无效');
    const initial=snapshot(s.initial), final=payload.final?snapshot(payload.final):null;
    for (const event of events) {
      if (!event || !uuid.test(event.id) || !['manual','llm','jev','local'].includes(event.mode) || !['pending','applied','failed','cancelled','discarded'].includes(event.status)) throw new DemoError('日志事件无效');
      snapshot(event.before); if(event.after) snapshot(event.after);
    }
    await mkdir(root,{recursive:true,mode:0o700});
    const path=join(root,s.id+'.json');
    let data;
    try { data=JSON.parse(await readFile(path,'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if (!data) data={format:'xiaohuang-2048-archive-v1',engine:'2048-v1/fnv1a-mulberry32',source:'local-browser-session',runtime:{node:process.version,platform:process.platform},session:{id:s.id,created_at:s.created_at,seed:s.seed,initial,events:[]}};
    if (data.session.created_at!==s.created_at || data.session.seed!==s.seed || JSON.stringify(data.session.initial)!==JSON.stringify(initial)) throw new DemoError('对局 ID 已被其他初始状态占用',409);
    for (const event of events) {
      const index=data.session.events.findIndex(e=>e.id===event.id);
      if (index<0) data.session.events.push(event);
      else if (data.session.events[index].status==='pending') data.session.events[index]=event;
      else if (JSON.stringify(data.session.events[index])!==JSON.stringify(sanitizeLog(event,secrets))) throw new DemoError('已完成日志不能被旧记录覆盖',409);
    }
    if (final && (!data.session.final || final.steps>=data.session.final.steps)) data.session.final=final;
    data.saved_at=new Date().toISOString();
    data=sanitizeLog(data,secrets);
    await atomic(path,JSON.stringify(data,null,2)+'\n');
    await atomic(join(root,s.id+'.md'),overview(data));
    return {saved_at:data.saved_at,path,summary_path:join(root,s.id+'.md'),events:data.session.events.length,batch_events:events.length};
  }
  return {save(payload) { const task=queue.then(()=>write(payload));queue=task.catch(()=>{});return task; }};
}
