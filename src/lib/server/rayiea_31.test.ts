import assert from 'node:assert/strict';
import { providerFetchSignal, DEFAULT_PROVIDER_FETCH_TIMEOUT_MS } from '../src/lib/server/provider-clients/fetch-signal';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('rayiea 31 provider fetch signal defaults timeout', () => {
  const signal = providerFetchSignal(undefined);
  assert.ok(signal);
  assert.equal(DEFAULT_PROVIDER_FETCH_TIMEOUT_MS, 120_000);
});
