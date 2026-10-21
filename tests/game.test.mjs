import test from 'node:test';
import assert from 'node:assert/strict';
import { move, spawn, seededRandom, legalMoves, newGame, validateBoard, DIRECTIONS } from '../public/game.mjs';
const rows = row => [row, [0,0,0,0], [0,0,0,0], [0,0,0,0]];
test('merges once per tile and scores the resulting values', () => {
  const input = rows([2,2,2,2]);
  const actual = move(input, 'left');
  assert.deepEqual(actual.board[0], [4,4,0,0]); assert.equal(actual.gained, 8);
  assert.deepEqual(input[0], [2,2,2,2]);
  assert.deepEqual(move(rows([2,2,4,0]), 'left').board[0], [4,4,0,0]);
  assert.deepEqual(move(rows([2,2,2,0]), 'right').board[0], [0,0,2,4]);
});
test('all directions preserve total tile mass before spawning', () => {
  const board = [[2,4,2,8],[2,4,0,8],[4,0,2,0],[4,0,0,8]];
  for (const d of DIRECTIONS) assert.equal(move(board, d).board.flat().reduce((a,b)=>a+b), board.flat().reduce((a,b)=>a+b));
  assert.deepEqual(move(board,'up').board.map(r=>r[0]),[4,8,0,0]);
  assert.deepEqual(move(board,'down').board.map(r=>r[0]),[0,0,4,8]);
});
test('no-op moves, full-board merges, and game over are distinguished', () => {
  assert.equal(move(rows([2,0,0,0]),'left').changed,false);
  assert.deepEqual(legalMoves([[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]]),[]);
  assert.ok(legalMoves([[2,2,4,8],[4,8,2,4],[2,4,8,2],[4,2,4,8]]).includes('left'));
});
test('seed and action sequence replay exactly; spawns only occupy empty cells', () => {
  const a = newGame('experiment'), b = newGame('experiment');
  assert.deepEqual(a.board,b.board); assert.equal(a.board.flat().filter(Boolean).length,2);
  for(let i=0;i<100;i++) {
    const d=legalMoves(a.board)[0]; if(!d) break;
    a.board=spawn(move(a.board,d).board,a.random).board;
    b.board=spawn(move(b.board,d).board,b.random).board;
    assert.deepEqual(a.board,b.board);
  }
  const filled=[[2,4,8,16],[2,4,8,16],[2,4,8,16],[2,4,8,0]];
  const result=spawn(filled,seededRandom('seed'));
  assert.deepEqual([result.spawned.row,result.spawned.col],[3,3]);
  assert.equal(filled[3][3],0);
});
test('rejects malformed boards', () => {
  for (const board of [[],rows([1,0,0,0]),rows([3,0,0,0]),rows([-2,0,0,0]),rows([NaN,0,0,0])]) assert.throws(()=>validateBoard(board));
});
