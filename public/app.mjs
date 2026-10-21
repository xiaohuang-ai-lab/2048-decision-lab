import { LABELS, ARROWS, move, spawn, newGame, maxTile, legalMoves, isGameFinished } from './game.mjs';
// Usage helpers also run in Node tests; missing usage is never treated as zero.
export function normalizeUsage(raw) {
  const number = (...values) => values.find(n => Number.isSafeInteger(n) && n >= 0) ?? null;
  const input = number(raw?.input_tokens, raw?.prompt_tokens);
  const output = number(raw?.output_tokens, raw?.completion_tokens);
  return {
    input, output,
    total: number(raw?.total_tokens, input !== null && output !== null ? input + output : null),
    cached: number(raw?.prompt_tokens_details?.cached_tokens, raw?.input_tokens_details?.cached_tokens, raw?.prompt_cache_hit_tokens),
    reasoning: number(raw?.completion_tokens_details?.reasoning_tokens, raw?.output_tokens_details?.reasoning_tokens)
  };
}
export function eventUsage(event) {
  return normalizeUsage(event.result?.usage ?? event.result?.raw_response?.usage ?? event.evidence?.raw_response?.usage);
}
export function summarizeUsage(events) {
  const result = { requests: 0, pending: 0, unknown: 0, failed: 0, applied: 0,
    input: 0, output: 0, total: 0, cached: 0, reasoning: 0,
    known: { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 } };
  for (const event of events) {
    if (['manual','local'].includes(event.mode)) continue;
    result.requests++;
    if (event.status === 'pending') result.pending++;
    if (['failed', 'cancelled', 'discarded'].includes(event.status)) result.failed++;
    if (event.status === 'applied') result.applied++;
    const usage = eventUsage(event);
    if (event.status !== 'pending' && (usage.input === null || usage.output === null)) result.unknown++;
    for (const key of Object.keys(result.known)) {
      if (usage[key] !== null) { result[key] += usage[key]; result.known[key]++; }
    }
  }
  return result;
}

// Published list-price snapshot; estimates are not invoices and never mix currencies.
export function pricingSnapshot(mode, provider, at, period = 'auto') {
  const base = { version: '2026-10-19-v1', checked_at: '2026-10-19', model: provider?.model, provider: provider?.provider };
  if (mode === 'jev' && provider?.provider === 'api.typesafe.ai' && ['jev-1.14.0','jev-1.13.0','jev-latest','jev-preview'].includes(provider.model)) {
    return { ...base, currency: 'USD', input_per_million: 0.042, cached_input_per_million: 0.042, output_per_million: 0,
      source_url: 'https://typesafe.ai/blog/jack-jill-jev-case-study', period: 'standard', assumptions: ['按官方公开标价，未含合同优惠、税费或充值抵扣。'] };
  }
  if (mode !== 'llm' || provider?.provider !== 'api.deepseek.com' || !['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro'].includes(provider.model)) return null;
  const date = new Date(Date.parse(at) + 8 * 3600000);
  if (!Number.isFinite(date.getTime()) || !['auto','peak','offpeak'].includes(period)) return null;
  const hour = date.getUTCHours(), weekday = date.getUTCDay();
  const peak = period === 'peak' || (period === 'auto' && weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)));
  const pro = provider.model === 'deepseek-v4-pro';
  const factor = peak ? 1 : 0.5;
  return { ...base, currency: 'CNY', input_per_million: (pro ? 9 : 2) * factor,
    cached_input_per_million: (pro ? 0.30 : 0.04) * factor, output_per_million: (pro ? 27 : 8) * factor,
    source_url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', period: peak ? 'peak' : 'offpeak', period_selection: period,
    assumptions: [period === 'auto' ? '按请求时间和北京时间工作日时段推算；未识别中国法定节假日，节假日请选空闲价。' : '按用户选择的高峰或空闲费率估算。', '未含优惠、税费或充值抵扣；以服务商账单为准。'] };
}
export function estimateCost(event) {
  const unknown = reason => ({ status: 'unknown', amount: null, currency: event.pricing?.currency ?? null, reason });
  if (event.mode === 'local') return { status: 'local', amount: 0, currency: null, reason: '本机代码计算，不使用 Token；API 费用为 0，未估算本机电费' };
  if (event.mode === 'manual') return { status: 'manual', amount: null, currency: null, reason: '手动操作，无 API 费用' };
  if (event.status === 'pending') return { status: 'pending', amount: null, currency: event.pricing?.currency ?? null, reason: '等待用量' };
  const price = event.pricing;
  if (!price) return unknown('未匹配官方服务和模型价格，或旧记录没有价格快照');
  if (!['CNY','USD'].includes(price.currency) || ![price.input_per_million,price.cached_input_per_million,price.output_per_million].every(n=>Number.isFinite(n)&&n>=0)) return unknown('价格数据无效');
  const usage = eventUsage(event);
  if (usage.input === null || (usage.output === null && price.output_per_million !== 0)) return unknown('计费所需的 Token 用量未返回');
  if (usage.cached !== null && usage.cached > usage.input) return unknown('缓存命中用量超过输入量');
  const cached = usage.cached ?? 0;
  const components = {
    input_uncached: (usage.input - cached) * price.input_per_million / 1e6,
    input_cached: cached * price.cached_input_per_million / 1e6,
    output: (usage.output ?? 0) * price.output_per_million / 1e6
  };
  return { status: 'estimated', currency: price.currency, amount: components.input_uncached + components.input_cached + components.output, components,
    assumptions: [...(price.assumptions || []), ...(usage.cached === null && price.input_per_million !== price.cached_input_per_million ? ['缓存用量未返回，暂按输入全部未命中估算。'] : [])] };
}
export function summarizeCosts(events) {
  const result = { CNY: {amount:0,count:0}, USD: {amount:0,count:0}, unknown:0, pending:0 };
  for (const event of events) {
    const cost=estimateCost(event);
    if (cost.status === 'estimated') { result[cost.currency].amount += cost.amount; result[cost.currency].count++; }
    else if (cost.status === 'unknown') result.unknown++;
    else if (cost.status === 'pending') result.pending++;
  }
  return result;
}
export function costText(cost) {
  if (['manual','local'].includes(cost.status)) return '无 API 费用';
  if (cost.status === 'pending') return '等待用量';
  if (cost.status !== 'estimated') return '未知';
  const value = cost.amount > 0 && cost.amount < 0.000001 ? '<0.000001' : cost.amount.toFixed(6);
  return `${cost.currency === 'CNY' ? '¥' : 'US$'}${value}`;
}

export function terminalBlocks(event, fullResponse = false) {
  const blocks = [];
  const raw = event.result?.raw_response ?? event.evidence?.raw_response;
  if (raw !== undefined && raw !== null) {
    if (fullResponse) {
      blocks.push({ kind: 'output', label: event.mode === 'local' ? 'LOCAL · 搜索结果（评分非获胜概率）' : 'API response · 格式化 JSON', text: JSON.stringify(raw, null, 2) });
    } else if (event.mode === 'jev') {
      const answer = raw.answers?.move;
      blocks.push({ kind: 'output', label: 'JEV answers.move · 格式化 JSON', text: JSON.stringify(answer ?? raw, null, 2) });
    } else {
      const message = raw.choices?.[0]?.message;
      if (typeof message?.content === 'string' && message.content.length) {
        blocks.push({ kind: 'output', label: 'LLM message.content · 原文', text: message.content });
      } else if (message?.content != null) {
        blocks.push({ kind: 'output', label: 'LLM message.content · 格式化 JSON', text: JSON.stringify(message.content, null, 2) });
      }
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
        blocks.push({ kind: 'tool', label: 'LLM tool_calls · 格式化 JSON', text: JSON.stringify(message.tool_calls, null, 2) });
      }
      if (message?.function_call) {
        blocks.push({ kind: 'tool', label: 'LLM function_call · 格式化 JSON', text: JSON.stringify(message.function_call, null, 2) });
      }
      if (!blocks.length) blocks.push({ kind: 'output', label: event.mode === 'local' ? 'LOCAL · 搜索结果（评分非获胜概率）' : 'API response · 格式化 JSON', text: JSON.stringify(raw, null, 2) });
    }
  }
  for (const warning of event.result?.warnings ?? []) blocks.push({ kind: 'warning', label: `WARN · ${warning.code}`, text: warning.message });
  if (event.retry) blocks.push({ kind: 'warning', label: 'RETRY · 应用策略', text: `本步第 ${event.retry.attempt} 次请求（首次 + 最多 ${event.retry.max_retries} 次重试）${event.retry.next_scheduled ? '；计划 1 秒后重试，可暂停取消' : event.retry.next_scheduled === false ? '；重试次数耗尽' : ''}` });
  if (event.status === 'pending') blocks.push({ kind: 'pending', label: 'WAIT · 应用日志', text: event.mode === 'local' ? '准备或执行本地搜索…' : event.request_sent_at ? '请求已发出，等待模型完整响应…' : '正在保存请求准备记录，尚未调用模型…' });
  if (event.status !== 'pending') {
    const latency = event.result?.latency_ms ?? event.evidence?.latency_ms;
    blocks.push({ kind: 'timing', label: 'TIME · 应用测量', text: `${event.mode === 'local' ? '本地决策（含进程通信/冷启动）' : '模型调用（含网络）'}=${latency ?? 'unknown'} ms${event.result?.raw_response?.search_ms !== undefined ? `  原生搜索=${event.result.raw_response.search_ms} ms` : ''}  客户端往返=${event.round_trip_ms ?? 'unknown'} ms` });
    const cost = estimateCost(event);
    blocks.push({ kind: 'cost', label: 'COST · 应用估算，非账单', text: costText(cost) });
    const usage = eventUsage(event), n = value => value === null ? 'unknown' : String(value);
    blocks.push({ kind: 'usage', label: 'USAGE · 服务报告', text: event.mode === 'local' ? '不适用 · 本机代码搜索，无模型 Token 消耗' : `input=${n(usage.input)}  output=${n(usage.output)}  total=${n(usage.total)}  cached=${n(usage.cached)}  reasoning=${n(usage.reasoning)}` });
  }
  if (event.status === 'applied') blocks.push({ kind: 'execute', label: 'EXEC · 应用日志', text: `move=${event.direction}  score_delta=+${event.gained}  score=${event.after?.score ?? '?'}${event.spawned ? `  spawn=${event.spawned.value}@row${event.spawned.row + 1},col${event.spawned.col + 1}` : ''}` });
  if (event.error) blocks.push({ kind: 'error', label: 'ERROR · 应用日志', text: event.error });
  else if (event.status === 'discarded') blocks.push({ kind: 'error', label: 'DISCARD · 应用日志', text: '局面已改变，本次返回未执行。' });
  return blocks;
}

export const MAX_RETRIES = 5;
export function retryPlan(failures) {
  return { retry: failures <= MAX_RETRIES, delay_ms: 1000, max_retries: MAX_RETRIES };
}

export function createPlayClock(now = () => performance.now()) {
  let accumulated = 0, started = null;
  return {
    start() { if (started === null) started = now(); },
    pause() { if (started !== null) { accumulated += Math.max(0, now() - started); started = null; } },
    reset() { accumulated = 0; started = null; },
    elapsed() { return accumulated + (started === null ? 0 : Math.max(0, now() - started)); }
  };
}
export function formatPlayTime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

// Coalesce pending/completed versions before sending; only discard acknowledged snapshots.
export function createArchiveBuffer({ send, onChange = () => {}, onError = () => {}, delayMs = 1000 }) {
  const pending = new Map();
  let timer, worker = null, failed = false, flushAgain = false, lastSaved = null;
  const notify = () => onChange({ pending: pending.size, saving: !!worker, failed, lastSaved });
  const schedule = () => {
    if (!timer && !worker && !failed && pending.size) timer = setTimeout(() => { timer = null; flush(); }, delayMs);
  };
  function enqueue(payload) {
    const copy = structuredClone(payload);
    pending.set(`${copy.session.id}:${copy.event?.id || 'initial'}`, copy);
    notify(); schedule();
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (failed) return Promise.resolve(false);
    if (worker) { flushAgain = true; return worker; }
    if (!pending.size) return Promise.resolve(true);
    const entries = [...pending];
    worker = Promise.resolve().then(async () => {
      try {
        for (let offset = 0; offset < entries.length;) {
          const selected = [], first = entries[offset][1];
          let bytes = 0;
          while (offset < entries.length && selected.length < 100) {
            const entry = entries[offset], next = entry[1];
            const size = new TextEncoder().encode(JSON.stringify(next)).length;
            if (next.session.id !== first.session.id || (selected.length && bytes + size > 1500000)) break;
            selected.push(entry); bytes += size; offset++;
          }
          const payload = { session: first.session, events: selected.flatMap(([, p]) => p.event ? [p.event] : []),
            final: selected.at(-1)[1].final };
          const result = await send(payload);
          if (result.batch_events !== payload.events.length) throw Error('日志服务尚不支持批量保存，请重启服务');
          for (const [key, value] of selected) if (pending.get(key) === value) pending.delete(key);
          lastSaved = result; notify();
        }
        return true;
      } catch (error) { failed = true; notify(); onError(error); return false; }
    }).finally(() => {
      worker = null; notify();
      const immediate = flushAgain; flushAgain = false;
      if (immediate && !failed) flush(); else schedule();
    });
    notify();
    return worker;
  }
  return { enqueue, flush, retry() { failed = false; return flush(); },
    get size() { return pending.size; }, get failed() { return failed; } };
}

function mountApp() {
const $ = id => document.getElementById(id);
const playClock = createPlayClock();
function renderPlayClock() { $('play-time').textContent = formatPlayTime(playClock.elapsed()); }
const names = { manual: '手动', llm: '大模型', jev: 'Jev', local: '代码 AI' };
const strategyNames = { expectimax:'Expectimax 搜索', direct:'原始', guided:'攻略提示词', assisted:'攻略 + 局面指标' };
const localConfig = { configured: true, model: 'expectimax-local-endless-v2', provider: '本机代码' };
let config = { local: localConfig }, mode = 'manual', game, session, running = false, busy = false, epoch = 0, controller, timer;
let objective = 'target-2048-v1';
let remaining = 0;
let runLimit = 20;
let consecutiveFailures = 0, retryGroup = null;
const sessions = [];
const archiveBuffer = createArchiveBuffer({
  async send(payload) {
    const response = await fetch('/api/logs', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '2048' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
    return result;
  },
  onChange({ pending, saving, failed, lastSaved }) {
    $('autosave-status').className = failed ? 'status error' : 'micro';
    $('autosave-retry').hidden = !failed;
    $('autosave-status').textContent = failed
      ? `保存失败 · ${pending} 条记录仍在本页内存中，请重试保存或导出备份，勿刷新或关闭。`
      : pending ? `${saving ? '后台保存中' : '等待后台保存 · 约每秒批量写入'} · ${pending} 条待保存；不阻塞决策。`
      : lastSaved ? `已保存到本地 · ${new Date(lastSaved.saved_at).toLocaleTimeString()} · ${lastSaved.path}（另有同名 Markdown 摘要）`
      : '暂无待保存记录。';
  },
  onError() {
    stop('本地日志保存失败，自动运行已暂停。请重试保存或手动导出。');
    render();
  }
});
function queueArchive(owner, event) {
  const { id, created_at, seed, initial } = owner;
  archiveBuffer.enqueue({ session: { id, created_at, seed, initial },
    ...(event ? { event } : {}), final: owner.final || owner.initial });
}
$('autosave-retry').addEventListener('click', () => archiveBuffer.retry());
window.addEventListener('beforeunload', event => {
  if (archiveBuffer.size || busy) { archiveBuffer.flush(); event.preventDefault(); event.returnValue = ''; }
});

let inspectedId = null;
const phaseLabels = { pending: '等待模型返回', applied: '已执行', failed: '失败 · 未执行', cancelled: '已取消', discarded: '已丢弃 · 未执行' };
const tokenText = n => n === null ? '未知' : n.toLocaleString('en-US');
function phase(event, label) { (event.timeline ??= []).push({ at: new Date().toISOString(), label }); }
function createEvent() {
  const event = { id: crypto.randomUUID(), at: new Date().toISOString(), mode, before: snapshot(),
    requested_model: mode === 'manual' ? null : mode === 'local' ? ($('local-engine').value === 'nneonneo' ? 'nneonneo (pinned native)' : localConfig.model) : config[mode]?.model, timeline: [],
    local_engine: mode === 'local' ? $('local-engine').value : undefined,
    strategy: mode === 'local' ? 'expectimax' : mode !== 'manual' ? $('strategy').value : 'direct',
    run_settings: { interval_ms: Number($('interval').value), step_limit: runLimit, objective, archive_policy: 'background-batch-v1' } };
  event.pricing = pricingSnapshot(mode, config[mode], event.at, $('billing-period').value);
  return event;
}

function status(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
function ended() { return isGameFinished(game.board, objective); }
function reachedTarget() { return objective === 'target-2048-v1' && maxTile(game.board) >= 2048; }
function snapshot() { return { board: game.board.map(row => [...row]), score: game.score, steps: game.steps }; }
function newSession(seed) {
  stop();
  if (session) session.final = snapshot();
  game = newGame(seed);
  playClock.reset();
  renderPlayClock();
  session = { id: crypto.randomUUID(), created_at: new Date().toISOString(), seed,
    initial: snapshot(), events: [] };
  sessions.push(session);
  inspectedId = null;
  $('seed').value = seed;
  renderBoard(); render();
  status('新棋盘已就绪。当前模式：' + names[mode] + '。');
  queueArchive(session);
}
function stop(message) {
  playClock.pause();
  renderPlayClock();
  running = false; epoch++;
  consecutiveFailures = 0; retryGroup = null;
  clearTimeout(timer);
  controller?.abort();
  archiveBuffer.flush();
  // In-flight callbacks retain their own session/event and cannot alter a new board.
  if (message) status(message);
}
function renderBoard(result) {
  const cells = [];
  game.board.forEach((row, r) => row.forEach((value, c) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (value > 2048) cell.classList.add('large-tile');
    if (value >= 10000) cell.classList.add('long-tile'); cell.dataset.value = value;
    cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', `第 ${r + 1} 行第 ${c + 1} 列：${value || '空'}`);
    cell.textContent = value || '';
    if (result?.spawned?.row === r && result?.spawned?.col === c) cell.classList.add('spawned');
    if (result?.merged?.some(([mr, mc]) => mr === r && mc === c)) cell.classList.add('merged');
    cells.push(cell);
  }));
  $('board').replaceChildren(...cells);
  $('score').textContent = game.score;
  $('max-tile').textContent = maxTile(game.board);
  $('steps').textContent = game.steps;
  $('game-overlay').hidden = !ended();
  if (ended()) {
    $('end-title').textContent = reachedTarget() ? '2048，挑战成功！' : '这一局，到这里。';
    $('end-description').textContent = `${game.steps} 步 · ${game.score} 分 · 最大方块 ${maxTile(game.board)}`;
  }
}
function render() {
  const isAI = mode !== 'manual';
  const endless = objective === 'endless-v1';
  const configured = config[mode]?.configured;
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.mode === mode);
    button.disabled = endless && ['llm','jev'].includes(button.dataset.mode);
    button.title = button.disabled ? '无限模式仅支持手动和代码 AI' : '';
  });
  $('objective').disabled = running || busy;
  $('objective-note').textContent = endless ? '仅支持手动 / 代码 AI · 切换玩法将新开一局' : '达到 2048 即结束 · 切换玩法将新开一局';
  $('step-limit-5000').hidden = !endless;
  $('step-limit-5000').disabled = !endless;
  $('step-limit-unlimited').hidden = !endless;
  $('step-limit-unlimited').disabled = !endless;
  if (!endless && ($('step-limit').value === 'unlimited' || Number($('step-limit').value) > 1000)) $('step-limit').value = '1000';
  $('mode-tag').textContent = running ? '运行中' : `${names[mode]}模式`;
  $('model-mark').textContent = { manual: '↗', llm: 'L', jev: 'J', local: '{}' }[mode];
  $('model-title').textContent = mode === 'local' ? ($('local-engine').value === 'nneonneo' ? 'nneonneo · 原生 Expectimax' : localConfig.model) : isAI ? (config[mode]?.model || names[mode]) : '这一局，你来决定';
  $('model-description').textContent = !isAI ? '继续合并，挑战更大的方块。' : mode === 'local' ? ($('local-engine').value === 'nneonneo' ? '成熟开源算法：位棋盘、查表与自适应搜索。' : '简化版前瞻搜索，兼顾空位、单调排列和合并机会。') : `当前策略：${strategyNames[$('strategy').value]}；由模型选择方向。`;
  $('connection').textContent = !isAI ? '手动模式无需 API' : mode === 'local' ? '● 本机运行 · 无需密钥 · 无 API 费用' : configured ? `● 已配置 · ${config[mode].provider} · 尚不代表连接成功` : '○ 尚未配置 API · 点击右上角「接入设置」';
  $('connection').className = 'connection' + (configured ? ' ready' : '');
  $('ai-controls').hidden = !isAI; $('manual-controls').hidden = isAI;
  $('run').textContent = running || busy ? '暂停 ■' : '开始运行 ▶';
  $('run').disabled = !running && !busy && (!configured || ended());
  $('single-step').disabled = busy || running || !configured || ended();
  $('step-limit').disabled = running || busy; $('interval').disabled = running || busy;
  $('billing-period').disabled = running || busy;
  $('strategy-controls').hidden = !isAI || mode === 'local';
  $('local-engine-controls').hidden = mode !== 'local';
  $('local-engine').disabled = running || busy;
  $('local-search-note').hidden = mode !== 'local';
  $('local-search-note').textContent = $('local-engine').value === 'nneonneo' ? '沿用上游自适应深度与低概率分支截断；只读取当前棋盘。评分不等于胜率，历史百局全胜不保证本次通关。' : '最多前瞻 3 步，每次最多访问 12,000 个节点；采用完整搜索过的深度，不读取未来随机数。评分不等于胜率。';
  $('run-note').textContent = mode === 'local' ? '上一手完成后继续搜索；无额外步间等待时连续运行。搜索失败最多重试 5 次，可暂停。全部在本机计算，无 API 费用。' : '0 秒仅取消额外等待，上一手完成后请求下一手。失败后间隔 1 秒，最多重试 5 次（可能额外计费）；成功后计数重置，暂停可取消。';
  if (endless && $('step-limit').value === 'unlimited') $('run-note').textContent = '不限步数，持续到无路可走或手动暂停。离开页面、保存失败或重试耗尽仍会暂停。全部在本机计算，无 API 费用。';
  $('strategy').disabled = running || busy;
  document.querySelectorAll('[data-direction]').forEach(button => { button.disabled = isAI || ended() || busy; });
  const completed = session.events.filter(e => e.result);
  $('requests').textContent = completed.length;
  $('avg-latency').textContent = completed.length ? `${Math.round(completed.reduce((sum, e) => sum + e.result.latency_ms, 0) / completed.length)} ms` : '—';
  renderTelemetry();
  renderHistory();
  renderTerminal();
}
let terminalText = '', terminalSignature = '';
function renderTerminal() {
  const filter = $('terminal-filter').value;
  const events = session.events.filter(event => event.mode !== 'manual' && (filter === 'all' || event.mode === filter));
  const limit = $('terminal-limit').value === 'all' ? events.length : Number($('terminal-limit').value);
  const visible = events.slice(-limit);
  const fullResponse = $('terminal-raw').checked;
  const signature = JSON.stringify([session.id,filter,limit,fullResponse,visible]);
  if (signature === terminalSignature) return;
  terminalSignature = signature;
  const output = $('terminal-output'), oldScroll = output.scrollTop;
  const pieces = [];
  const entries = visible.map(event => {
    const article = document.createElement('article'); article.className = 'terminal-entry';
    const header = document.createElement('div'); header.className = 'terminal-entry-header';
    const number = session.events.indexOf(event) + 1;
    const time = new Date(event.at).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, fractionalSecondDigits:3});
    const model = event.result?.model || event.evidence?.raw_response?.model || event.requested_model || 'unknown';
    const title = `[${time}] #${number} ${names[event.mode]} / ${model} / step ${event.before.steps + 1}${` / ${strategyNames[event.strategy] || '原始'}策略`}`;
    header.textContent = title; article.append(header); pieces.push(title);
    for (const block of terminalBlocks(event,fullResponse)) {
      const label = document.createElement('div'), content = document.createElement('pre');
      label.className = `terminal-label ${block.kind}`; label.textContent = block.label;
      content.className = `terminal-content ${block.kind}`; content.textContent = block.text;
      article.append(label,content); pieces.push(`${block.label}\n${block.text}`);
    }
    pieces.push('');
    return article;
  });
  output.replaceChildren(...entries);
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'terminal-empty';
    empty.textContent = '> 等待决策输出。选择大模型、Jev 或代码 AI，点击「单步」开始。'; output.append(empty);
  }
  terminalText = pieces.join('\n');
  $('terminal-count').textContent = `${visible.length} / ${events.length} 条请求`;
  $('terminal-copy').disabled = !visible.length;
  $('terminal-copy').textContent = '复制当前输出';
  output.scrollTop = $('terminal-follow').checked ? output.scrollHeight : oldScroll;
}
$('terminal-filter').addEventListener('change', renderTerminal);
$('terminal-limit').addEventListener('change', renderTerminal);
$('terminal-raw').addEventListener('change', renderTerminal);
$('terminal-follow').addEventListener('change', () => {
  if ($('terminal-follow').checked) $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
});
$('terminal-output').addEventListener('scroll', () => {
  const output = $('terminal-output');
  if (output.scrollHeight - output.clientHeight - output.scrollTop > 30) $('terminal-follow').checked = false;
});
$('terminal-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(terminalText); $('terminal-copy').textContent = '已复制'; }
  catch { $('terminal-copy').textContent = '复制失败，请手动选择文本'; }
});
function renderHistory() {
  $('empty-history').hidden = session.events.length > 0;
  const limit = $('log-limit').value === 'all' ? session.events.length : Number($('log-limit').value);
  $('history').replaceChildren(...session.events.slice(-limit).reverse().map(event => {
    const row = document.createElement('tr');
    if (event.id === inspectedId) row.className = 'inspected';
    const usage = eventUsage(event), manual = ['manual','local'].includes(event.mode);
    const latency = event.result?.latency_ms ?? event.evidence?.latency_ms;
    const values = [`#${session.events.indexOf(event) + 1} · ${names[event.mode]}${event.mode !== 'manual' ? ` · ${strategyNames[event.strategy] || '原始'}` : ''}`, event.direction ? ARROWS[event.direction] + ' ' + LABELS[event.direction] : '—',
      event.gained === undefined ? '—' : `+${event.gained}`, latency === undefined ? '—' : `${latency} ms`,
      manual ? '—' : event.status === 'pending' ? '等待' : `${tokenText(usage.input)} / ${tokenText(usage.output)}`, costText(estimateCost(event)), phaseLabels[event.status]];
    values.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    const cell = document.createElement('td'), button = document.createElement('button');
    button.className = 'text-button'; button.textContent = '查看'; button.setAttribute('aria-label', `查看记录 ${session.events.indexOf(event) + 1}`);
    button.addEventListener('click', () => { inspectedId = event.id; $('follow-latest').checked = false; renderHistory(); renderInspector(); });
    cell.append(button); row.append(cell);
    return row;
  }));
}
function renderTelemetry() {
  const costs = summarizeCosts(session.events);
  for (const currency of ['CNY','USD']) $('cost-' + currency.toLowerCase()).textContent = costs[currency].count ? costText({status:'estimated',currency,amount:costs[currency].amount}) : '—';
  $('cost-note').textContent = `已估算 ${costs.CNY.count + costs.USD.count} 次请求 · ${costs.unknown} 次费用未知 · ${costs.pending} 次等待用量。不同币种不合并，未知项不按免费处理；这里只是已知用量的估算小计。`;
  const summary = summarizeUsage(session.events);
  $('usage-input').textContent = summary.known.input ? tokenText(summary.input) : '—';
  $('usage-output').textContent = summary.known.output ? tokenText(summary.output) : '—';
  $('usage-total').textContent = summary.known.total ? tokenText(summary.total) : '—';
  $('usage-requests').textContent = `${summary.requests}`;
  $('usage-note').textContent = `本局模型 API 已报告用量 · ${summary.applied} 次已执行 · ${summary.failed} 次失败 / 取消 / 丢弃 · ${summary.pending} 次等待返回 · ${summary.unknown} 次输入或输出用量未知。缓存与推理 token 是子项，不重复加到合计。`;
  $('usage-by-mode').textContent = ['llm','jev'].map(key => {
    const stats = summarizeUsage(session.events.filter(event => event.mode === key));
    return `${names[key]}：${stats.requests} 次请求 / ${stats.known.total ? tokenText(stats.total) : '—'} 已报告 tokens`;
  }).join('　·　') + `　·　代码 AI：${session.events.filter(e=>e.mode==='local').length} 次本地决策（不计 API 用量）`;
  updateLiveClock();
  if ($('follow-latest').checked) inspectedId = session.events.at(-1)?.id ?? null;
  renderInspector();
}
function updateLiveClock() {
  renderPlayClock();
  const event = session.events.filter(e => e.mode !== 'manual').at(-1);
  $('live-elapsed').textContent = event?.status === 'pending' ? `${((Date.now() - Date.parse(event.at)) / 1000).toFixed(1)} s 等待中` : event?.round_trip_ms !== undefined ? `${event.round_trip_ms} ms 往返` : '—';
}
function renderInspector() {
  const event = session.events.find(e => e.id === inspectedId);
  $('log-inspector').hidden = !event;
  if (!event) return;
  $('inspect-title').textContent = `记录 #${session.events.indexOf(event) + 1} · ${names[event.mode]} · 第 ${event.before.steps + 1} 步尝试`;
  $('inspect-state').textContent = phaseLabels[event.status];
  $('inspect-warning').textContent = (event.result?.warnings ?? []).map(w => w.message).join('\n');
  $('inspect-warning').hidden = !event.result?.warnings?.length;
  const model = event.result?.model || event.evidence?.raw_response?.model || event.requested_model;
  $('inspect-model').textContent = event.mode === 'local' ? `本地算法：${event.result?.algorithm_version || event.requested_model} · Expectimax 搜索，无提示词` : model ? `模型：${model}${` · ${strategyNames[event.strategy] || '原始'}策略`} · 提示词版本：${event.result?.prompt_version || event.evidence?.prompt_version || '待返回'}` : '手动操作，无模型调用';
  $('inspect-error').hidden = !event.error;
  $('inspect-error').textContent = event.error || '';
  $('inspect-timeline').replaceChildren(...(event.timeline || []).map(item => {
    const li = document.createElement('li');
    li.textContent = `${new Date(item.at).toLocaleTimeString('zh-CN', {hour12:false})} · ${item.label}`;
    return li;
  }));
  const usage = eventUsage(event);
  const usageRows = [['输入',usage.input],['输出',usage.output],['合计',usage.total],['缓存命中（输入子项）',usage.cached],['推理（输出子项）',usage.reasoning]];
  $('inspect-usage').replaceChildren(...usageRows.map(([label,value]) => {
    const item = document.createElement('div'), title = document.createElement('span'), number = document.createElement('strong');
    title.textContent = label; number.textContent = ['manual','local'].includes(event.mode) ? '—' : event.status === 'pending' ? '等待' : tokenText(value);
    item.append(title,number); return item;
  }));
  const cost = estimateCost(event), price = event.pricing;
  $('inspect-cost').textContent = `本次估算：${costText(cost)}${cost.reason ? ' · ' + cost.reason : ''}`;
  $('inspect-cost-detail').textContent = event.mode === 'local' ? '本机 CPU 计算，无模型 API 调用。设备和电费未计入。' : price ? `每百万 Token：未缓存输入 ${price.input_per_million} / 缓存输入 ${price.cached_input_per_million} / 输出 ${price.output_per_million} ${price.currency}；${price.period === 'peak' ? '高峰价' : price.period === 'offpeak' ? '空闲价' : '标准价'}。核对日期 ${price.checked_at}。${(cost.assumptions || price.assumptions || []).join(' ')}` : '该记录没有可用价格快照，未套用其他服务的单价。';
  const boardText = board => board.map(row => row.map(n => String(n || '·').padStart(5)).join(' ')).join('\n');
  $('inspect-before').textContent = boardText(event.before.board);
  $('inspect-after').textContent = event.after ? boardText(event.after.board) : '本步尚未执行，棋盘未改变。';
  $('inspect-action').textContent = event.direction ? `${ARROWS[event.direction]} ${LABELS[event.direction]} · 合并 +${event.gained ?? 0} 分${event.spawned ? ` · 新块 ${event.spawned.value} 在第 ${event.spawned.row + 1} 行、第 ${event.spawned.col + 1} 列` : ''}` : '尚无已执行动作';
  const format = value => value === undefined || value === null ? '服务尚未返回此项。' : JSON.stringify(value,null,2);
  $('inspect-request').textContent = event.mode === 'manual' ? '手动操作，无 API 请求。' : format(event.result?.request ?? event.evidence?.request ?? { mode:event.mode, ...event.before });
  $('inspect-response').textContent = event.mode === 'manual' ? '手动操作，无模型响应。' : format(event.result?.raw_response ?? event.evidence?.raw_response);
  $('inspect-raw-usage').textContent = event.mode === 'local' ? '不适用：本地算法不消耗模型 Token。' : event.mode === 'manual' ? '手动操作，无用量。' : format(event.result?.usage ?? event.result?.raw_response?.usage ?? event.evidence?.raw_response?.usage);
  $('inspect-latency').textContent = `${event.mode === 'local' ? '本地决策' : '模型调用（含网络）'}：${event.result?.latency_ms ?? event.evidence?.latency_ms ?? '—'} ms · 客户端往返：${event.round_trip_ms ?? '—'} ms`;
}
$('follow-latest').addEventListener('change', () => { renderTelemetry(); renderHistory(); });
$('log-limit').addEventListener('change', renderHistory);
setInterval(updateLiveClock, 250);
function apply(direction, event) {
  const result = move(game.board, direction);
  if (!result.changed) return false;
  const spawned = spawn(result.board, game.random);
  game.board = spawned.board; game.score += result.gained; game.steps++;
  Object.assign(event, { direction, gained: result.gained, spawned: spawned.spawned, after: snapshot(), status: 'applied' });
  phase(event, '动作已执行，棋盘与得分已更新');
  session.final = snapshot();
  renderBoard({ ...result, ...spawned });
  if (ended()) stop(reachedTarget() ? '已达到 2048，本局挑战成功。' : '已无有效方向，本局结束。');
  render(); return true;
}
function manualMove(direction) {
  if (mode !== 'manual' || busy || ended() || archiveBuffer.failed) return;
  const event = createEvent();
  if (!move(game.board, direction).changed) { status('这个方向无法移动，换个方向试试。'); return; }
  playClock.start();
  session.events.push(event);
  apply(direction, event);
  queueArchive(session, event);
  if (ended()) archiveBuffer.flush();
  if (!ended()) status(`${LABELS[direction]} · 合并得分 +${event.gained}`);
}
async function step() {
  if (busy || mode === 'manual' || ended() || !config[mode]?.configured) return;
  if (archiveBuffer.failed) { stop('请先重试保存或导出日志备份。'); render(); return; }
  playClock.start();
  const thisEpoch = epoch, owner = session;
  const event = createEvent();
  retryGroup ??= crypto.randomUUID();
  event.retry = { group_id: retryGroup, attempt: consecutiveFailures + 1, max_retries: MAX_RETRIES };
  let retryDelay = null;
  event.status = 'pending'; phase(event, mode === 'local' ? '准备本地搜索，日志加入后台保存队列' : '准备模型请求，日志加入后台保存队列');
  owner.events.push(event);
  const request = { mode, objective, ...event.before, local_engine: event.local_engine, strategy: mode === 'local' ? 'direct' : event.strategy, recent_actions: owner.events.filter(e=>e.status==='applied').slice(-4).map(e=>e.direction) };
  busy = true;
  const localController = new AbortController(); controller = localController;
  const started = performance.now();
  status(`${names[mode]} 正在选择下一步…`, 'busy'); render();
  try {
    queueArchive(owner, event);
    if (thisEpoch !== epoch || owner !== session || localController.signal.aborted) throw new Error('请求已取消，未调用模型。');
    event.request_sent_at = new Date().toISOString();
    event.pricing = pricingSnapshot(event.mode, config[event.mode], event.request_sent_at, $('billing-period').value);
    phase(event, mode === 'local' ? '启动本地 Expectimax 搜索' : '请求发出，等待模型响应');
    render();
    const response = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '2048' }, body: JSON.stringify(request), signal: AbortSignal.any([localController.signal, AbortSignal.timeout(150000)]) });
    const result = await response.json();
    phase(event, '收到本地服务响应');
    event.round_trip_ms = Math.round(performance.now() - started);
    if (!response.ok) { event.evidence = result.evidence; throw new Error(result.error || '请求失败'); }
    event.result = result;
    for (const warning of result.warnings ?? []) phase(event, `警告：${warning.message}`);
    phase(event, `动作通过校验：${LABELS[result.direction]}`);
    if (thisEpoch !== epoch || owner !== session) { event.status = 'discarded'; phase(event, '局面已改变，丢弃旧结果'); return; }
    if (!apply(result.direction, event)) throw new Error('返回动作无法执行，本次未执行');
    consecutiveFailures = 0; retryGroup = null;
    if (!ended()) status(`${names[mode]} 选择${LABELS[result.direction]} · ${result.latency_ms} ms · +${event.gained} 分`);
  } catch (error) {
    event.status = localController.signal.aborted ? 'cancelled' : 'failed';
    phase(event, localController.signal.aborted ? '请求已取消，未执行动作' : '本次请求或动作失败');
    event.error = localController.signal.aborted && event.mode === 'local' ? '本地搜索已取消，无 API 费用。' : localController.signal.aborted ? (event.request_sent_at ? '客户端取消，上游可能已计费，返回用量未知。' : '调用模型前已停止，未发送模型请求。') : error.name === 'TimeoutError' ? '本地请求超时，上游用量可能未知。' : error.message;
    event.round_trip_ms = Math.round(performance.now() - started);
    if (running && thisEpoch === epoch && owner === session && !localController.signal.aborted) {
      const plan = retryPlan(++consecutiveFailures);
      event.retry.next_scheduled = plan.retry;
      if (plan.retry) {
        retryDelay = plan.delay_ms;
        event.retry.delay_ms = retryDelay;
        phase(event, `计划 1 秒后重试 ${consecutiveFailures}/${MAX_RETRIES}，棋盘保持不变；可暂停取消`);
        status(`${event.error} · 1 秒后重试 ${consecutiveFailures}/${MAX_RETRIES}，可点击暂停取消。`, 'busy');
      } else {
        phase(event, '首次请求及 5 次重试均失败，停止运行');
        stop(); status(`${event.error} · 已重试 ${MAX_RETRIES} 次仍失败，自动暂停。`, 'error');
      }
    }
  } finally {
    event.cost_estimate = estimateCost(event);
    queueArchive(owner, event);
    busy = false;
    if (controller === localController) controller = null;
    render();
    if (!running || owner !== session) archiveBuffer.flush();
    if (running && thisEpoch === epoch && owner === session) {
      if (event.status === 'applied') remaining--;
      if (remaining <= 0) { stop('已达到本轮步数上限，自动暂停。'); render(); }
      else if (event.status === 'applied' || retryDelay !== null) timer = setTimeout(step, retryDelay ?? Number($('interval').value));
    }
  }
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (objective === 'endless-v1' && ['llm','jev'].includes(button.dataset.mode)) return;
  stop(busy ? (mode === 'local' ? '模式已切换，正在取消本地搜索，无 API 费用。' : '模式已切换，正在取消上一个请求；上游用量可能未知。') : '模式已切换，棋盘保持不变。');
  mode = button.dataset.mode; render();
}));
$('objective').addEventListener('change', () => {
  objective = $('objective').value;
  if (objective === 'endless-v1' && ['llm','jev'].includes(mode)) mode = 'local';
  newSession(crypto.randomUUID().slice(0, 8));
  status(objective === 'endless-v1' ? '已开启无限挑战，仅支持手动和代码 AI。' : '已开启 2048 封顶挑战，达到目标即结束。');
});
$('local-engine').addEventListener('change', () => { render(); status('本地算法已切换。独立对比建议新开一局。'); });
$('strategy').addEventListener('change', () => {
  render();
  status('策略已切换，仅影响后续请求。比较效果建议各自新开一局。');
});
$('step-limit').addEventListener('change', render);
$('run').addEventListener('click', () => {
  if (running || busy) { stop(busy ? (mode === 'local' ? '已暂停，本地搜索已取消，无 API 费用。' : '已暂停。未完成的请求已取消，上游可能已计费。') : '已暂停，可以继续运行或导出记录。'); render(); return; }
  runLimit = objective === 'endless-v1' && $('step-limit').value === 'unlimited' ? 'unlimited' : Number($('step-limit').value);
  remaining = runLimit === 'unlimited' ? Infinity : runLimit; running = true; step();
});
$('single-step').addEventListener('click', () => { runLimit = 1; remaining = 1; running = true; step(); });
document.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => manualMove(button.dataset.direction)));
document.addEventListener('keydown', event => {
  if ($('settings').open || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || mode !== 'manual' || event.altKey || event.ctrlKey || event.metaKey) return;
  const direction = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' }[event.key];
  if (direction) { event.preventDefault(); manualMove(direction); }
});
let pointer;
$('board').addEventListener('pointerdown', event => { pointer = [event.clientX, event.clientY]; $('board').setPointerCapture(event.pointerId); });
$('board').addEventListener('pointerup', event => {
  if (!pointer) return;
  const dx = event.clientX - pointer[0], dy = event.clientY - pointer[1]; pointer = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 25) return;
  manualMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
});
$('board').addEventListener('pointercancel', () => { pointer = null; });
for (const id of ['new-game', 'end-new']) $(id).addEventListener('click', () => newSession(crypto.randomUUID().slice(0, 8)));
$('replay-seed').addEventListener('click', () => { if ($('seed').value.trim()) newSession($('seed').value.trim()); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { playClock.pause(); renderPlayClock(); archiveBuffer.flush(); }
  if (document.hidden && (running || busy)) { stop(mode === 'local' ? '页面离开前台，本地运行已自动暂停。' : '页面离开前台，已自动暂停；未完成请求用量可能未知。'); render(); }
});
$('export').addEventListener('click', () => {
  session.final = snapshot();
  const data = { format: 'xiaohuang-2048-v1', exported_at: new Date().toISOString(), engine: '2048-v1/fnv1a-mulberry32',
    note: 'Actual gameplay logs. Model probabilities are not win probabilities. Missing usage is unknown, not zero. Mixed-mode sessions are not independent model benchmarks.',
    environment: { user_agent: navigator.userAgent }, config, sessions };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `2048-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let configMode = 'llm', savingConfig = false;
function showConfigFields() {
  const provider = config[configMode];
  if (!provider) return;
  document.querySelectorAll('[data-config-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.configMode === configMode));
  $('config-base').value = provider.base;
  $('config-model').value = provider.model;
  $('config-key').value = '';
  $('config-key').placeholder = provider.configured ? '已配置 · 留空保留现有密钥' : '粘贴 API Key';
  $('config-badge').textContent = provider.configured ? '已配置' : '未配置';
  $('key-state').textContent = provider.configured ? (provider.saved ? '已保存本机，不回显' : '已配置，不回显') : '尚未填写';
  $('clear-config').disabled = !provider.configured;
  $('config-provider-label').textContent = configMode === 'llm' ? 'Chat Completions 兼容接口' : 'TypeSafe · System One';
  $('config-base-help').textContent = configMode === 'llm' ? '填写基础地址，不含 /chat/completions。' : '默认 https://api.typesafe.ai/v1，不含 /systemone。';
  $('config-feedback').textContent = '';
  $('config-feedback').className = 'config-feedback';
}
$('open-settings').addEventListener('click', async () => {
  stop(busy ? '已暂停，正在取消请求。' : '已暂停，可修改模型配置。'); render();
  configMode = mode === 'jev' ? 'jev' : 'llm';
  $('settings').showModal();
  if (!Object.keys(config).length) await loadConfig();
  showConfigFields();
});
$('close-settings').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('close', () => { $('config-key').value = ''; });
$('settings').addEventListener('cancel', event => { if (savingConfig) event.preventDefault(); });
for (const button of document.querySelectorAll('[data-config-mode]')) button.addEventListener('click', () => {
  configMode = button.dataset.configMode; showConfigFields();
});
async function saveConfig(clear = false) {
  if (savingConfig) return;
  if (!clear && !$('config-form').reportValidity()) return;
  savingConfig = true;
  const payload = clear ? { mode: configMode, clear: true } : {
    mode: configMode, base: $('config-base').value, model: $('config-model').value, key: $('config-key').value
  };
  const controls = [...$('config-form').querySelectorAll('input, button'), ...document.querySelectorAll('[data-config-mode]'), $('close-settings')];
  controls.forEach(el => { el.disabled = true; });
  $('config-feedback').textContent = '正在保存到本地服务…';
  $('config-feedback').className = 'config-feedback';
  try {
    const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '2048' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败，请重试');
    config = { ...result, local: localConfig };
    showConfigFields(); render();
    $('config-feedback').textContent = clear ? '密钥已清除，此模式已停用。' : config[configMode].configured ? (config[configMode].storage === 'local' ? '已保存到本机，刷新或重启后自动恢复。' : '已保存到服务内存，立即生效。') : '地址和模型已保存，填写 API Key 后即可运行。';
    status(clear ? '密钥已清除。' : '模型配置已更新，尚未发起模型调用。');
  } catch (error) {
    $('config-feedback').textContent = error.name === 'TimeoutError' ? '保存超时，结果未知；重新打开页面核对配置。' : error.message;
    $('config-feedback').className = 'config-feedback error';
  } finally {
    payload.key = undefined;
    $('config-key').value = '';
    savingConfig = false;
    controls.forEach(el => { el.disabled = false; });
    $('clear-config').disabled = !config[configMode]?.configured;
  }
}
$('config-form').addEventListener('submit', event => { event.preventDefault(); saveConfig(); });
$('clear-config').addEventListener('click', () => saveConfig(true));
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error();
    config = { ...await response.json(), local: localConfig };
    render();
  } catch { status('无法读取本地服务配置，请通过 Node 服务地址打开此页面。', 'error'); }
}
newSession('xiaohuang-001'); loadConfig();

}
if (typeof document !== 'undefined') mountApp();
