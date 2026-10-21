import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBoard, maxTile, isGameOver } from './public/game.mjs';
import { estimateCost } from './public/app.mjs';

const names = {
  manual: '手动',
  'llm:direct': '大模型 · 原始', 'llm:guided': '大模型 · 攻略', 'llm:assisted': '大模型 · 增强',
  'jev:direct': 'Jev · 原始', 'jev:guided': 'Jev · 攻略', 'jev:assisted': 'Jev · 增强',
  'local:simple': '代码 AI · JavaScript', 'local:nneonneo': '代码 AI · nneonneo'
};
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function modeKey(event) {
  if (event.mode === 'manual') return 'manual';
  if (['llm','jev'].includes(event.mode)) {
    const version = event.result?.prompt_version ?? event.evidence?.prompt_version ?? '';
    const inferred = version.includes('assisted') ? 'assisted' : version.includes('guide') ? 'guided' : 'direct';
    const strategy = event.strategy ?? event.result?.strategy ?? event.evidence?.strategy ?? inferred;
    if (!['direct','guided','assisted'].includes(strategy)) throw Error('Unknown strategy');
    return event.mode + ':' + strategy;
  }
  if (event.mode !== 'local') throw Error('Unknown mode');
  // Group by the selected engine, preserving its logged version/fallback separately.
  const engine = event.local_engine ?? event.result?.local_engine ??
    (/nneonneo/.test(event.requested_model || event.result?.model || '') ? 'nneonneo' : 'simple');
  if (!['simple','nneonneo'].includes(engine)) throw Error('Unknown engine');
  return 'local:' + engine;
}
function snapshot(value) {
  validateBoard(value?.board);
  if (!Number.isSafeInteger(value.score) || value.score < 0 || !Number.isSafeInteger(value.steps) || value.steps < 0) throw Error('Invalid snapshot');
  return value;
}
function timestamp(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
function endTime(event) {
  const times = (event.timeline || []).map(p => timestamp(p.at)).filter(t => t !== null);
  const started = timestamp(event.at);
  if (started !== null) times.push(started);
  if (!times.length) return null;
  if (!event.timeline?.length && finite(event.round_trip_ms) && started !== null) times.push(started + event.round_trip_ms);
  return Math.max(...times);
}
export function summarizeSession(data) {
  if (data?.source !== 'local-browser-session' || !data.session) return { excluded: 'unsupported' };
  const s = data.session, events = s.events;
  if (!Array.isArray(events)) throw Error('Invalid events');
  if (!events.length) return { excluded: 'empty' };
  const keys = [...new Set(events.map(modeKey))];
  if (keys.length !== 1) return { excluded: 'mixed' };
  const initial = snapshot(s.initial), created = timestamp(s.created_at);
  if (created === null || typeof s.id !== 'string') throw Error('Invalid session');
  const key = keys[0], origin = timestamp(events[0].at);
  let current = initial, elapsed = 0, timeKnown = origin !== null, costKnown = true, applied = 0, failed = 0, pending = 0, unknown = 0;
  const costs = { CNY: 0, USD: 0 }, currencies = new Set(), models = new Set(), versions = new Set(), objectives = new Set();
  const point = status => ({ step: current.steps - initial.steps, elapsed_ms: timeKnown ? elapsed : null,
    score: current.score, max_tile: maxTile(current.board), costs: costKnown ? { ...costs } : null,
    known_costs: { ...costs }, cost_complete: costKnown, unknown_costs: unknown, pending_costs: pending, status });
  const points = [point('initial')];
  for (const event of events) {
    if (!['pending','applied','failed','cancelled','discarded'].includes(event.status)) throw Error('Invalid event');
    if (event.result?.model || event.requested_model) models.add(String(event.result?.model || event.requested_model));
    if (event.result?.algorithm_version || event.result?.prompt_version || event.evidence?.prompt_version) versions.add(event.result?.algorithm_version || event.result?.prompt_version || event.evidence?.prompt_version);
    objectives.add(event.run_settings?.objective || 'legacy-2048');
    const end = endTime(event);
    if (end === null || origin === null) timeKnown = false;
    else elapsed = Math.max(elapsed, end - origin);
    const cost = estimateCost(event);
    if (cost.status === 'estimated') {
      costs[cost.currency] += cost.amount; currencies.add(cost.currency);
    } else if (!['manual','local'].includes(cost.status)) {
      costKnown = false;
      if (cost.status !== 'pending') unknown++;
    }
    if (event.status === 'applied') {
      const next = snapshot(event.after);
      if (next.steps !== current.steps + 1 || next.score < current.score) throw Error('Discontinuous moves');
      current = next; applied++;
    } else if (event.status === 'pending') pending++;
    else failed++;
    points.push(point(event.status));
  }
  return { key, label: names[key], session_id: s.id, seed: String(s.seed ?? ''), created_at: s.created_at,
    saved_at: data.saved_at, models: [...models], versions: [...versions], objectives: [...objectives],
    steps: applied, initial_steps: initial.steps, score: current.score, max_tile: maxTile(current.board), elapsed_ms: timeKnown ? elapsed : null,
    status: objectives.size === 1 && objectives.has('target-2048-v1') && maxTile(current.board) >= 2048 ? 'target_reached' : isGameOver(current.board) ? 'game_over' : pending ? 'pending' : 'can_continue',
    attempts: events.length, failed, pending, unknown_costs: unknown, costs, cost_complete: costKnown, currencies: [...currencies],
    fallback_events: events.filter(e => e.result?.raw_response?.fallback_from).length, points };
}
export function latestSessions(summaries) {
  const latest = new Map();
  for (const s of summaries) {
    if (s.excluded) continue;
    const old = latest.get(s.key);
    // Start time determines the latest game. Re-saving/resuming an old game does not promote it.
    if (!old || Date.parse(s.created_at) > Date.parse(old.created_at) || (s.created_at === old.created_at && s.session_id > old.session_id)) latest.set(s.key, s);
  }
  return Object.keys(names).map(key => latest.get(key)).filter(Boolean);
}
export function createStatisticsReader(directory) {
  const cache = new Map();
  let active;
  async function collect() {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
    const files = entries.filter(e => e.isFile() && /^[0-9a-f-]{36}\.json$/i.test(e.name)).map(e => e.name);
    for (const key of cache.keys()) if (!files.includes(key)) cache.delete(key);
    const summaries = [], excluded = { empty: 0, mixed: 0, unsupported: 0, invalid: 0 };
    for (const file of files) {
      try {
        const path = join(directory, file), info = await stat(path), stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
        let entry = cache.get(file);
        if (entry?.stamp !== stamp) {
          entry = { stamp, value: summarizeSession(JSON.parse(await readFile(path, 'utf8'))) }; cache.set(file, entry);
        }
        if (entry.value.excluded) excluded[entry.value.excluded]++;
        else summaries.push(entry.value);
      } catch { excluded.invalid++; }
    }
    return { generated_at: new Date().toISOString(), scanned: files.length, excluded, series: latestSessions(summaries) };
  }
  return () => {
    if (!active) active = collect().finally(() => { active = null; });
    return active;
  };
}
