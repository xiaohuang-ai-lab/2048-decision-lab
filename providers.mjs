import { chooseNative, NATIVE_VERSION, NATIVE_SEARCH } from './native-ai.mjs';
import { chooseLocal, LOCAL_VERSION, SEARCH } from './local-ai.mjs';
import { legalMoves, validateBoard, LABELS, maxTile } from './public/game.mjs';

import { analyzeMoves, ASSISTED_VERSION, ASSISTED_INSTRUCTIONS, GUIDED_VERSION, GUIDED_INSTRUCTIONS } from './strategy.mjs';

export const PROMPT_VERSION = '2048-direct-target-v3';
export const INSTRUCTIONS = 'Play standard 2048 on a 4x4 board. Rows are top to bottom and columns left to right; 0 is empty. A move slides all tiles toward that edge. Adjacent equal tiles merge once per move. After a valid move, a random empty cell receives a 2 (90%) or 4 (10%). Choose exactly one available direction to maximize the chance of reaching a 2048 tile while avoiding game over. Reaching 2048 wins and ends the game. Evaluate the current board; no future random tile or search result is provided.';

export class DemoError extends Error {
  constructor(message, status = 400, evidence = {}) { super(message); this.status = status; this.evidence = evidence; }
}
export function configFromEnv(env = process.env) {
  let extra;
  try { extra = JSON.parse(env.LLM_EXTRA_BODY || '{}'); } catch { throw new Error('LLM_EXTRA_BODY 必须是 JSON 对象'); }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('LLM_EXTRA_BODY 必须是 JSON 对象');
  const timeout = Number(env.REQUEST_TIMEOUT_MS || 30000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw new Error('REQUEST_TIMEOUT_MS 需在 100—120000 之间');
  const llmBase = env.LLM_BASE_URL || 'https://api.deepseek.com';
  const llmExtra = new URL(llmBase).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' }, ...extra } : extra;
  const config = {
    timeout,
    llm: { base: llmBase, model: env.LLM_MODEL || 'deepseek-flash', key: env.LLM_API_KEY || '', extra: llmExtra },
    jev: { base: env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1', model: env.TYPESAFE_MODEL || 'jev-1.14.0', key: env.TYPESAFE_API_KEY || '' }
  };
  for (const p of [config.llm, config.jev]) {
    const url = new URL(p.base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型地址必须是无凭据、无查询参数的 HTTP(S) Base URL');
  }
  return config;
}
export function publicConfig(config) {
  return Object.fromEntries(['llm', 'jev'].map(mode => [mode, {
    configured: Boolean(config[mode].key), model: config[mode].model,
    base: config[mode].base, provider: new URL(config[mode].base).hostname
  }]));
}
export function updateProvider(config, payload) {
  if (!payload || !['llm', 'jev'].includes(payload.mode)) throw new DemoError('请选择要配置的模式');
  const old = config[payload.mode];
  if (payload.clear === true) return { ...old, key: '' };
  if (typeof payload.base !== 'string' || payload.base.length > 2000 ||
      typeof payload.model !== 'string' || !payload.model.trim() || payload.model.length > 200 ||
      typeof payload.key !== 'string' || payload.key.length > 4096 || /[\r\n]/.test(payload.key)) {
    throw new DemoError('请填写有效的服务地址、模型名和 API Key');
  }
  let url;
  try { url = new URL(payload.base.trim()); } catch { throw new DemoError('服务地址不是有效 URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash) {
    throw new DemoError('请使用不含凭据或查询参数的 HTTPS 地址；本机服务可使用 HTTP。');
  }
  const base = url.href.replace(/\/$/, ''), key = payload.key.trim();
  const previousBase = new URL(old.base).href.replace(/\/$/, '');
  if (old.key && base !== previousBase && !key) throw new DemoError('服务地址已改变，请重新填写 API Key，避免将原密钥发送到新地址。');
  const result = { ...old, base, model: payload.model.trim(), key: key || old.key };
  if (payload.mode === 'llm' && url.hostname !== new URL(old.base).hostname) {
    result.extra = url.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {};
  }
  return result;
}
export function decisionInput(payload) {
  if (!payload || !['llm', 'jev', 'local'].includes(payload.mode)) throw new DemoError('请选择自动决策模式');
  try { validateBoard(payload.board); } catch (error) { throw new DemoError(error.message); }
  const objective = payload.objective ?? (payload.mode === 'local' ? 'endless-v1' : 'target-2048-v1');
  if (!['endless-v1','target-2048-v1'].includes(objective)) throw new DemoError('玩法无效');
  if (objective === 'endless-v1' && payload.mode !== 'local') throw new DemoError('无限模式不支持大模型和 Jev');
  if (objective === 'target-2048-v1' && maxTile(payload.board) >= 2048) throw new DemoError('已达到 2048，本局结束，请新开一局');
  if (!Number.isSafeInteger(payload.score) || payload.score < 0) throw new DemoError('分数无效');
  if (!Number.isSafeInteger(payload.steps) || payload.steps < 0) throw new DemoError('步数无效');
  if (payload.strategy !== undefined && !['direct','guided','assisted'].includes(payload.strategy)) throw new DemoError('策略无效');
  if (payload.strategy && payload.strategy !== 'direct' && payload.recent_actions !== undefined &&
      (!Array.isArray(payload.recent_actions) || payload.recent_actions.length > 4 || payload.recent_actions.some(d=>!['up','down','left','right'].includes(d)))) throw new DemoError('历史动作无效');
  const available = legalMoves(payload.board);
  if (!available.length) throw new DemoError('本局已结束，请新开一局');
  return { objective, board: payload.board, score: payload.score, move_number: payload.steps + 1,
    available_moves: available, options: Object.fromEntries(available.map(d => [d, LABELS[d]])),
    ...(payload.strategy && payload.strategy !== 'direct' ? { strategy: payload.strategy, recent_actions: payload.recent_actions || [] } : {}),
    ...(payload.strategy === 'assisted' ? { move_analysis: analyzeMoves(payload.board) } : {}) };
}
export function buildRequest(mode, state, config) {
  const provider = config[mode];
  const instructions = state.strategy === 'assisted' ? ASSISTED_INSTRUCTIONS : state.strategy === 'guided' ? GUIDED_INSTRUCTIONS : INSTRUCTIONS;
  if (mode === 'jev') return { model: provider.model, state, questions: {
    move: { type: 'choice', instructions,
      criteria: state.strategy === 'assisted' ? Object.fromEntries(state.available_moves.map(d => [d, `Choose ${d}; evaluate its exact immediate consequences in state.move_analysis.${d} and the long-term layout.`])) : state.options }
  } };
  return { ...provider.extra, model: provider.model, stream: false, max_tokens: 256,
    response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: instructions + ' Return only JSON with one field: {"direction":"up|down|left|right"}. Do not add explanations.' },
      { role: 'user', content: JSON.stringify(state) }
    ] };
}
export function parseDecision(mode, raw, available) {
  let direction, probabilities = null, confidence = null;
  const warnings = [];
  if (mode === 'jev') {
    const answer = raw?.answers?.move;
    direction = answer?.choice;
    probabilities = answer?.probabilities;
    confidence = answer?.confidence;
    const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (answer?.type !== 'choice' || !probabilities || Array.isArray(probabilities) ||
      Object.keys(probabilities).length !== available.length ||
      !available.every(d => validNumber(probabilities[d])) || !validNumber(confidence) ||
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02 ||
      !available.includes(direction)) {
      throw new DemoError('Jev 返回的选择或概率格式无效，本步未执行', 502);
    }
    const highest = Math.max(...Object.values(probabilities));
    if (probabilities[direction] < highest - 1e-6) {
      const top = available.filter(d => probabilities[d] === highest).join('/');
      warnings.push({ code: 'choice_probability_mismatch', choice: direction,
        choice_probability: probabilities[direction], highest_choices: available.filter(d => probabilities[d] === highest), highest_probability: highest,
        message: `Jev 返回字段不一致：choice=${direction}（${probabilities[direction]}），最高概率为 ${top}（${highest}）。仅记录警告，继续使用返回的 choice=${direction}；未改选方向或额外请求。` });
    }
  } else {
    const choice = raw?.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new DemoError('大模型输出未正常完成，本步未执行', 502);
    try { direction = JSON.parse(choice.message.content).direction; }
    catch { throw new DemoError('大模型未返回有效 JSON，本步未执行', 502); }
  }
  if (!available.includes(direction)) throw new DemoError('模型选择了无效方向，本步未执行', 502);
  return { direction, probabilities, confidence, warnings };
}
export async function decide(payload, config, signal, fetcher = fetch) {
  const state = decisionInput(payload.mode === 'local' ? { ...payload, strategy: 'direct' } : payload);
  if (payload.mode === 'local') {
    signal?.throwIfAborted();
    const engine = payload.local_engine ?? 'simple';
    if (!['simple','nneonneo'].includes(engine)) throw new DemoError('本地算法选择无效');
    let result;
    try { result = engine === 'nneonneo' ? await chooseNative(state.board, signal) : chooseLocal(state.board); }
    catch(error) { throw new DemoError(signal?.aborted ? '本地搜索已取消，无 API 费用。' : error.message, 503); }
    const requestedVersion = engine === 'nneonneo' ? NATIVE_VERSION : LOCAL_VERSION;
    const version = result.algorithm;
    const search = engine === 'nneonneo' ? NATIVE_SEARCH : SEARCH;
    return { direction: result.direction, model: version, requested_model: requestedVersion,
      latency_ms: result.latency_ms, usage: null, probabilities: null, confidence: null, warnings: result.warnings || [],
      strategy: 'expectimax', algorithm_version: version, local_engine: engine, decision_policy: 'local-expectimax',
      request: { board: state.board, local_engine: engine, search }, raw_response: result };
  }
  const provider = config[payload.mode];
  if (!provider.key) throw new DemoError('尚未配置此模式的 API Key。请打开「接入设置」填写。', 503);
  const request = buildRequest(payload.mode, state, config);
  const strategy = state.strategy || 'direct';
  const promptVersion = strategy === 'assisted' ? ASSISTED_VERSION : strategy === 'guided' ? GUIDED_VERSION : PROMPT_VERSION;
  const endpoint = provider.base.replace(/\/$/, '') + (payload.mode === 'jev' ? '/systemone' : '/chat/completions');
  const started = performance.now();
  let raw;
  try {
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeout)]) });
    if (!response.ok) throw new DemoError(`模型服务返回 HTTP ${response.status}，本次请求失败。`, 502, { upstream_status: response.status });
    const content = await response.text();
    if (content.length > 1000000) throw new DemoError('模型响应过大，本次请求失败', 502);
    try { raw = JSON.parse(content); } catch { throw new DemoError('模型服务未返回 JSON，本次请求失败', 502); }
    const decision = parseDecision(payload.mode, raw, state.available_moves);
    return { ...decision, model: raw.model || provider.model, requested_model: provider.model,
      latency_ms: Math.round(performance.now() - started), usage: raw.usage || null,
      strategy, prompt_version: promptVersion, decision_policy: 'returned-choice-with-warnings-v2', request, raw_response: raw };
  } catch (error) {
    if (!(error instanceof DemoError)) error = new DemoError(
      signal.aborted ? '请求已取消；上游可能已计费。' : error.name === 'TimeoutError' ? '模型请求超时；上游用量未知。' : '无法连接模型服务；请检查地址和网络。', 502);
    error.evidence = { ...error.evidence, strategy, prompt_version: promptVersion, request,
      ...(raw ? { raw_response: raw } : {}), latency_ms: Math.round(performance.now() - started) };
    throw error;
  }
}
