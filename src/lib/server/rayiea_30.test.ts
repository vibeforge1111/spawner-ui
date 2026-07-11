import assert from 'node:assert/strict';
import { safeJsonParse } from '../src/lib/server/safe-json';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('rayiea 30 safe json parse fallback', () => {
  assert.deepEqual(safeJsonParse('{not-json', { fallback: true }, 'rayiea-30'), { fallback: true });
});
