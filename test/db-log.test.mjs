// Pure-function tests for the logging helpers. Run: npm test (builds first — imports from dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForDedupe, dailyDedupe, chronicDue } from '../dist/sync/db-log.js';

const bc = (corr) => `shipment-driven pull: HTTP 400: {"error":{"code":"Application_DialogException","message":"You have insufficient quantity of Item 500550577 on inventory.  CorrelationId:  ${corr}."}} — POST /v2.0/c93df08a-282d-4d69-b189-3b021ad6218e/PRODUCTION/api/bmi/pk/v1.0/companies(0f7be801-6df3-f011-8405-0022481cc88c)/bmiSalesOrders(6cd3e9c2-dd9b-f111-8074-000d3a55edba)/Microsoft.NAV.postShipment`;

test('normalizeForDedupe strips CorrelationId and GUIDs so a repeated BC error hashes the same', () => {
  const a = normalizeForDedupe(bc('bfe44fbc-97eb-4120-a945-1d8d122ccb7f'));
  const b = normalizeForDedupe(bc('3ebb04be-f4ff-4c8c-902f-51c34363e428'));
  assert.equal(a, b);
  assert.doesNotMatch(a, /CorrelationId/);
  assert.doesNotMatch(a, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // The part that matters for reading the log survives.
  assert.match(a, /insufficient quantity of Item 500550577/);
});

test('normalizeForDedupe keeps genuinely different errors different', () => {
  assert.notEqual(normalizeForDedupe(bc('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
                  normalizeForDedupe(bc('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa').replace('500550577', '500550578')));
});

test('dailyDedupe collapses the same failure with different CorrelationIds to one key per day', () => {
  const k1 = dailyDedupe('co-ship-pull', 'WSOD305290', bc('bfe44fbc-97eb-4120-a945-1d8d122ccb7f'));
  const k2 = dailyDedupe('co-ship-pull', 'WSOD305290', bc('3ebb04be-f4ff-4c8c-902f-51c34363e428'));
  assert.equal(k1, k2);
  assert.match(k1, /^co-ship-pull:WSOD305290:\d{4}-\d{2}-\d{2}:/);
});

test('chronicDue: never attempted → due', () => {
  assert.equal(chronicDue({ lastAttempt: null, flushAt: null, now: new Date('2026-08-27T12:00:00Z'), intervalMs: 3_600_000 }), true);
});

test('chronicDue: attempted 10 minutes ago → not due, 61 minutes ago → due', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  assert.equal(chronicDue({ lastAttempt: new Date('2026-08-27T11:50:00Z'), flushAt: null, now, intervalMs: 3_600_000 }), false);
  assert.equal(chronicDue({ lastAttempt: new Date('2026-08-27T10:59:00Z'), flushAt: null, now, intervalMs: 3_600_000 }), true);
});

test('chronicDue: a flush requested AFTER the last attempt forces a retry; a flush BEFORE it does not', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const lastAttempt = new Date('2026-08-27T11:50:00Z');
  assert.equal(chronicDue({ lastAttempt, flushAt: new Date('2026-08-27T11:55:00Z'), now, intervalMs: 3_600_000 }), true);
  assert.equal(chronicDue({ lastAttempt, flushAt: new Date('2026-08-27T11:40:00Z'), now, intervalMs: 3_600_000 }), false);
});
