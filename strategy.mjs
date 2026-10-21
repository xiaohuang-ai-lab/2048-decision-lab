import { move, legalMoves, maxTile } from './public/game.mjs';

export const GUIDED_VERSION = '2048-guide-target-v4';
export const ASSISTED_VERSION = '2048-assisted-target-v4';
export const GUIDED_INSTRUCTIONS = `Play standard 2048 on a 4x4 board. Rows top to bottom, columns left to right, 0 means empty. A valid move slides tiles and merges equal adjacent tiles once. Then a uniformly random empty cell gets 2 with probability 0.9 or 4 with probability 0.1. Choose one available direction to maximize the chance of reaching a 2048 tile. Reaching 2048 wins and ends the game.
Use this ordered checklist, with survival taking priority over layout:
1. Avoid immediate game over, including after the next random tile. Never invent a future tile location.
2. Keep working space and multiple legal follow-up directions. With at most two empty cells, prioritize opening space and accessible equal-tile merges; do not chase score while sealing the board.
3. Use a stable upper-left anchor. Prefer keeping the largest tile there, especially once it reaches 64. Build the top row in descending order from left to right, then the second row from right to left, then the third left to right, then the fourth right to left. Feed small merges toward the large end of this snake; do not scatter large tiles behind tiny ones.
4. Compare actual moved boards: right/down are not forbidden. Use them when needed to survive, free space, or repair the chain. Avoid emptying the anchor corner because a new small tile can occupy it. When displaced, restore the large tile only when this does not worsen survival. Do not sacrifice a safe merge merely to make a prettier snake.
5. Prefer accessible equal neighbors and smaller gaps between neighboring nonzero tile exponents. Avoid undoing recent moves merely to shuffle tiles; reverse when it merges, opens space, or repairs layout. recent_actions contains only successful prior directions, not a stored long-term plan.
These are heuristics, not an optimal policy or a guarantee of survival. Compare all legal options; return only the chosen direction in the required response format.`;
export const ASSISTED_INSTRUCTIONS = GUIDED_INSTRUCTIONS + `
The program supplies move_analysis for every legal direction. These are measured features, not recommendations. board_after_move and layout are BEFORE random spawn. empty_cells_after_spawn is the resulting number of empty cells. immediate_loss_probability exactly enumerates zero-mobility outcomes after the NEXT random tile; it is NOT the probability of eventually losing and does not override a winning 2048 merge. expected_next_legal_moves and worst_next_legal_moves measure mobility after that spawn; they are not search scores. A move that reaches 2048 wins immediately; otherwise zero mobility loses.
Layout features: max_tile_in_upper_left, anchor_empty, top_row_full; snake_inversion_penalty is the sum of positive log2 rises along the fixed upper-left snake (empty=0; lower is more ordered); adjacent_exponent_gap is the sum of absolute log2 gaps over occupied horizontal/vertical neighbors (lower is smoother, but do not reduce it by losing space); adjacent_equal_pairs counts equal neighboring pairs (overlapping pairs are not independent merges). Do not optimize any single metric blindly. Compare immediate loss first, then space/mobility, then anchor and merge-chain quality. No multi-step search or future random seed is supplied.`;

export function layoutFeatures(board) {
  const rank = value => value ? Math.log2(value) : 0;
  const snake = board.flatMap((row,r) => r % 2 ? [...row].reverse() : row).map(rank);
  let inversion = 0, gaps = 0, equal = 0;
  for (let i=1;i<snake.length;i++) inversion += Math.max(0,snake[i]-snake[i-1]);
  for (let r=0;r<4;r++) for (let c=0;c<4;c++) {
    for (const [dr,dc] of [[0,1],[1,0]]) {
      const a=board[r][c],b=board[r+dr]?.[c+dc];
      if (a && b) { gaps += Math.abs(rank(a)-rank(b)); if(a===b)equal++; }
    }
  }
  return { snake_inversion_penalty: inversion, adjacent_exponent_gap: gaps, adjacent_equal_pairs: equal,
    anchor_empty: board[0][0] === 0, top_row_full: board[0].every(Boolean) };
}
export function analyzeMoves(board) {
  const analysis = {};
  for (const direction of legalMoves(board)) {
    const moved = move(board, direction), empty = [];
    moved.board.forEach((row,r)=>row.forEach((value,c)=>{if(value===0)empty.push([r,c]);}));
    let loss = 0, mobility = 0, worst = 4;
    for (const [r,c] of empty) for (const [value,probability] of [[2,0.9],[4,0.1]]) {
      const after = moved.board.map(row=>[...row]); after[r][c] = value;
      const legal = legalMoves(after).length;
      if (legal === 0) loss += probability / empty.length;
      mobility += legal * probability / empty.length;
      worst = Math.min(worst, legal);
    }
    analysis[direction] = {
      board_after_move: moved.board, merge_score: moved.gained, merge_count: moved.merged.length,
      empty_cells_after_spawn: Math.max(0, empty.length - 1), max_tile: maxTile(moved.board),
      max_tile_in_upper_left: moved.board[0][0] === maxTile(moved.board),
      immediate_loss_probability: Math.min(1, Math.max(0, Number(loss.toFixed(12)))),
      expected_next_legal_moves: Number(mobility.toFixed(6)), worst_next_legal_moves: worst,
      layout: layoutFeatures(moved.board)
    };
  }
  return analysis;
}
