'use strict';
const test = require('node:test');
const assert = require('node:assert');
const bt = require('../src/businessTime');

const ist = (s) => new Date(`${s}:00+05:30`).getTime(); // 2026-11-20 is a Friday
const show = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ');

test.beforeEach(() => bt.setHolidays([]));

test('6 PM Friday ticket is not late on Sunday morning', () => {
  assert.strictEqual(bt.businessMinutesBetween(ist('2026-11-20T18:00'), ist('2026-11-22T10:00')), 30);
});

test('2 working hours from 6 PM Friday lands Monday 11:00', () => {
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-20T18:00'), 120)), '2026-11-23 11:00');
});

test('start on a weekend begins Monday 09:30', () => {
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-21T10:00'), 60)), '2026-11-23 10:30');
});

test('before opening and after closing are skipped', () => {
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-23T07:00'), 30)), '2026-11-23 10:00');
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-23T20:00'), 30)), '2026-11-24 10:00');
});

test('a full working day ends at 18:30, not the next morning', () => {
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-23T09:30'), 540)), '2026-11-23 18:30');
});

test('five working days from Monday morning ends Friday 18:30', () => {
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-23T09:30'), 2700)), '2026-11-27 18:30');
});

test('holidays are skipped', () => {
  bt.setHolidays(['2026-11-23']);
  assert.strictEqual(show(bt.addBusinessMinutes(ist('2026-11-20T18:00'), 120)), '2026-11-24 11:00');
  assert.strictEqual(bt.businessMinutesBetween(ist('2026-11-20T18:30'), ist('2026-11-24T09:30')), 0);
});

test('minutes between spans several days', () => {
  assert.strictEqual(bt.businessMinutesBetween(ist('2026-11-20T09:30'), ist('2026-11-23T09:30')), 540);
  assert.strictEqual(bt.businessMinutesBetween(ist('2026-11-23T12:00'), ist('2026-11-23T11:00')), 0);
});

test('add and between are consistent', () => {
  const start = ist('2026-11-19T15:10');
  for (const m of [1, 60, 333, 540, 1000, 2700]) {
    assert.ok(Math.abs(bt.businessMinutesBetween(start, bt.addBusinessMinutes(start, m)) - m) < 1e-6);
  }
});
