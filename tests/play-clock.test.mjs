import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayClock, formatPlayTime } from '../public/app.mjs';

test('game clock excludes idle and paused time, resumes once, and resets for a new game', () => {
  let now = 1000;
  const clock = createPlayClock(() => now);
  now += 5000;
  assert.equal(clock.elapsed(), 0);
  clock.start();
  now += 1500;
  clock.start(); // Subsequent AI steps do not restart the clock.
  now += 500;
  assert.equal(clock.elapsed(), 2000);
  clock.pause();
  now += 60000;
  clock.pause();
  assert.equal(clock.elapsed(), 2000);
  clock.start();
  now += 1000;
  assert.equal(clock.elapsed(), 3000);
  clock.reset();
  now += 5000;
  assert.equal(clock.elapsed(), 0);
  clock.start();
  now += 1000;
  assert.equal(formatPlayTime(clock.elapsed()), '00:00:01');
});
