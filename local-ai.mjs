import { DIRECTIONS, move, validateBoard } from './public/game.mjs';

// Original JS implementation of the expectimax / monotonicity ideas described at
// https://github.com/nneonneo/2048-ai . No bitboard code or trained model is used.
export const LOCAL_VERSION = 'expectimax-local-endless-v2';
export const SEARCH = Object.freeze({ max_depth: 3, node_budget: 12000 });

export function evaluate(board) {
  const ranks = board.map(row => row.map(n => n ? Math.log2(n) : 0));
  let empty = 0, disorder = 0, pairs = 0, roughness = 0;
  for (const row of ranks) for (const n of row) if (!n) empty++;
  for (let i = 0; i < 4; i++) for (const line of [ranks[i], ranks.map(row => row[i])]) {
    let increasing = 0, decreasing = 0;
    for (let j = 1; j < 4; j++) {
      const delta = line[j] ** 3 - line[j - 1] ** 3;
      increasing += Math.max(delta, 0); decreasing += Math.max(-delta, 0);
    }
    disorder += Math.min(increasing, decreasing);
    const occupied = line.filter(Boolean);
    for (let j = 1; j < occupied.length; j++) {
      if (occupied[j] === occupied[j - 1]) pairs++;
      roughness += Math.abs(occupied[j] - occupied[j - 1]);
    }
  }
  return { empty, disorder, pairs, roughness,
    score: empty * 300 + pairs * 100 - disorder * 12 - roughness * 10 };
}

export function chooseLocal(board, options = SEARCH) {
  validateBoard(board);
  const { max_depth: maxDepth, node_budget: budget } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4 || !Number.isInteger(budget) || budget < 500 || budget > 100000) throw new Error('搜索参数无效');
  const started = performance.now();
  const roots = DIRECTIONS.map(direction => ({ direction, ...move(board, direction) })).filter(x => x.changed);
  if (!roots.length) throw new Error('本局已结束');
  let nodes = 0, cacheHits = 0, completedDepth = 0, scores, limited = false;
  const limit = Symbol('node-budget');
  const cache = new Map();
  function visit() { if (nodes >= budget) throw limit; nodes++; }
  function player(b, depth) {
    visit();
    const key = depth + ':' + b.flat().join(',');
    if (cache.has(key)) { cacheHits++; return cache.get(key); }
    const moves = DIRECTIONS.map(d => move(b, d)).filter(x => x.changed);
    if (!moves.length) return -1000000;
    const value = depth === 0 ? evaluate(b).score : Math.max(...moves.map(x => chance(x.board, depth - 1)));
    cache.set(key, value);
    return value;
  }
  function chance(b, depth) {
    visit();
    const cells = [];
    b.forEach((row, r) => row.forEach((n, c) => { if (!n) cells.push([r, c]); }));
    if (!cells.length) return player(b, depth);
    let expected = 0;
    for (const [r, c] of cells) for (const [tile, probability] of [[2, 0.9], [4, 0.1]]) {
      const next = b.map(row => [...row]); next[r][c] = tile;
      expected += probability / cells.length * player(next, depth);
    }
    return expected;
  }
  // Only compare a fully completed depth across ALL directions. A truncated
  // iteration never gives earlier directions an unfairly deeper evaluation.
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      const next = Object.fromEntries(roots.map(x => [x.direction, chance(x.board, depth - 1)]));
      scores = next; completedDepth = depth;
    } catch (error) { if (error !== limit) throw error; limited = true; break; }
  }
  const direction = roots.reduce((best, x) => scores[x.direction] > scores[best] ? x.direction : best, roots[0].direction);
  return { direction, algorithm: LOCAL_VERSION, scores,
    score_kind: 'heuristic utility, NOT win probability', search: {
      ...options, completed_depth: completedDepth, visited_nodes: nodes, cache_hits: cacheHits, budget_exhausted: limited,
      spawn_distribution: { uniform_empty_cell: true, tile_2: 0.9, tile_4: 0.1 }
    }, chosen_features_before_spawn: evaluate(roots.find(x => x.direction === direction).board),
    latency_ms: Math.round((performance.now() - started) * 100) / 100 };
}
