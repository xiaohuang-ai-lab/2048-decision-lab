export const DIRECTIONS = ['up', 'down', 'left', 'right'];
export const LABELS = { up: '向上', down: '向下', left: '向左', right: '向右' };
export const ARROWS = { up: '↑', down: '↓', left: '←', right: '→' };

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== 4 || board.some(row =>
    !Array.isArray(row) || row.length !== 4 || row.some(n =>
      !Number.isSafeInteger(n) || n < 0 || (n !== 0 && (n < 2 || !Number.isInteger(Math.log2(n))))))) {
    throw new Error('棋盘必须是 4 × 4 的矩阵，格子为 0 或 2 的正整数次幂。');
  }
  return board;
}

// Pure move: no random spawning, no mutation, each tile merges at most once.
export function move(board, direction) {
  if (!DIRECTIONS.includes(direction)) throw new Error('未知方向');
  const next = board.map(row => [...row]);
  let gained = 0;
  const merged = [];
  for (let line = 0; line < 4; line++) {
    const cells = Array.from({ length: 4 }, (_, i) => {
      if (direction === 'left') return [line, i];
      if (direction === 'right') return [line, 3 - i];
      if (direction === 'up') return [i, line];
      return [3 - i, line];
    });
    const values = cells.map(([r, c]) => board[r][c]).filter(Boolean);
    const output = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === values[i + 1]) {
        const value = values[i] * 2;
        merged.push(cells[output.length]);
        output.push(value);
        gained += value;
        i++;
      } else output.push(values[i]);
    }
    cells.forEach(([r, c], i) => { next[r][c] = output[i] || 0; });
  }
  return { board: next, gained, merged, changed: next.some((row, r) => row.some((n, c) => n !== board[r][c])) };
}
export function legalMoves(board) { return DIRECTIONS.filter(d => move(board, d).changed); }
export function isGameOver(board) { return legalMoves(board).length === 0; }
export function isGameFinished(board, objective) {
  return (objective === 'target-2048-v1' && maxTile(board) >= 2048) || isGameOver(board);
}
export function maxTile(board) { return Math.max(...board.flat()); }
export function emptyCount(board) { return board.flat().filter(n => !n).length; }

// FNV-1a seed + Mulberry32, versioned by the exported experiment format.
export function seededRandom(seed) {
  let a = 2166136261;
  for (const char of String(seed)) a = Math.imul(a ^ char.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function spawn(board, random) {
  const empty = [];
  board.forEach((row, r) => row.forEach((n, c) => { if (!n) empty.push([r, c]); }));
  if (!empty.length) return { board, spawned: null };
  const [row, col] = empty[Math.floor(random() * empty.length)];
  const value = random() < 0.9 ? 2 : 4;
  const next = board.map(row => [...row]);
  next[row][col] = value;
  return { board: next, spawned: { row, col, value } };
}
export function newGame(seed) {
  const random = seededRandom(seed);
  let board = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  board = spawn(board, random).board;
  board = spawn(board, random).board;
  return { board, random, score: 0, steps: 0 };
}
