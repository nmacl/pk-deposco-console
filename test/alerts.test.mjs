// Pure-function tests for the alert classifier. Run: npm test (builds first — imports from dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInventoryFailures, chronicAlerts, formatDigest, shortError, webhookBody } from '../dist/sync/alerts.js';

const row = (o) => ({ id: 1, ts: '2026-09-22T10:00:00Z', worker: 'inv_pull', entity_id: '227', action: 'pull', message: '#227 x NOT applied to BC — Dead-lettered', detail: {}, hits: 1, last_ts: null, ...o });
const bcErr = '"POST …/bmiInventoryAdjustments → HTTP 400: {\\"error\\":{\\"code\\":\\"Application_DialogException\\",\\"message\\":\\"You have insufficient quantity of Item 6000011977 on inventory. CorrelationId: abc\\"}}"';

test('permanent (transient=false) failure → one dead-letter alert keyed on the adjustment id', () => {
  const a = classifyInventoryFailures([row({ detail: { transient: false, item: 'MA26CEZ33-NAV-XL', quantity: -1, error: bcErr } })]);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'inv-dead-letter');
  assert.equal(a[0].dedupeKey, 'inv-dead:227');
  assert.match(a[0].message, /#227 \(MA26CEZ33-NAV-XL -1\)/);
  assert.match(a[0].message, /insufficient quantity of Item 6000011977/);
  assert.doesNotMatch(a[0].message, /CorrelationId/);
});

test('transient failure below the stuck threshold → no alert (it is still retrying normally)', () => {
  assert.equal(classifyInventoryFailures([row({ detail: { transient: true }, hits: 3 })], 6).length, 0);
});

test('transient failure at/over the threshold → stuck alert, re-keyed every threshold-worth of ticks', () => {
  const a6 = classifyInventoryFailures([row({ detail: { transient: true, item: 'X', quantity: 5 }, hits: 6 })], 6);
  const a11 = classifyInventoryFailures([row({ detail: { transient: true, item: 'X', quantity: 5 }, hits: 11 })], 6);
  const a12 = classifyInventoryFailures([row({ detail: { transient: true, item: 'X', quantity: 5 }, hits: 12 })], 6);
  assert.equal(a6[0].kind, 'inv-stuck');
  assert.equal(a6[0].dedupeKey, a11[0].dedupeKey, 'same bucket → same key → alerted once');
  assert.notEqual(a6[0].dedupeKey, a12[0].dedupeKey, 'next bucket → alerts again');
  assert.match(a6[0].message, /blocking every later adjustment/);
});

test('unmappable-SKU dead letter (no transient flag, "DEAD-LETTER" in message) still alerts', () => {
  const a = classifyInventoryFailures([row({ message: "no BC variant for 'V2019-BLK-LG' — DEAD-LETTER", detail: { webshop: 'V2019-BLK-LG', transient: false } })]);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /V2019-BLK-LG/);
});

test('rows from other workers are ignored by the inventory classifier', () => {
  assert.equal(classifyInventoryFailures([row({ worker: 'co', detail: { transient: false } })]).length, 0);
});

test('chronic alerts collapse to one digest per worker per day, re-keyed when the set changes', () => {
  const a = chronicAlerts('co', ['WSOD305291', 'WSOD305290', 'WSOD305290'], '2026-09-22');
  assert.equal(a.length, 1);
  assert.equal(a[0].dedupeKey, 'chronic:co:2026-09-22:WSOD305290,WSOD305291');
  assert.match(a[0].message, /2 chronic sales order shipments/);
  assert.deepEqual(a[0].detail.orders, ['WSOD305290', 'WSOD305291']);
  assert.equal(chronicAlerts('to', [], '2026-09-22').length, 0);
});

test('webhookBody: teams format is an Adaptive Card message; json keeps the plain shape', () => {
  const alerts = [{ kind: 'inv-dead-letter', worker: 'inv_pull', entityId: '227', message: 'boom', dedupeKey: 'x' }];
  const teams = webhookBody('subj', 'txt', alerts, 'teams');
  assert.equal(teams.type, 'message');
  assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.match(teams.attachments[0].content.body[1].text, /227.*boom/);
  assert.equal(webhookBody('subj', 'txt', alerts, 'json').title, 'subj');
});

test('formatDigest summarises by kind and lists each alert', () => {
  const { subject, text } = formatDigest([
    { kind: 'inv-dead-letter', worker: 'inv_pull', entityId: '1', message: 'one', dedupeKey: 'a' },
    { kind: 'inv-stuck', worker: 'inv_pull', entityId: '2', message: 'two', dedupeKey: 'b' },
  ]);
  assert.match(subject, /1 dead-lettered adjustment, 1 stuck adjustment/);
  assert.match(text, /• one\n• two/);
});

test('shortError digs the BC message out of the wrapped JSON and drops the CorrelationId', () => {
  assert.equal(shortError(bcErr), 'You have insufficient quantity of Item 6000011977 on inventory.');
  assert.equal(shortError('plain text'), 'plain text');
});
