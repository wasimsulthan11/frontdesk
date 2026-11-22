'use strict';
// Integration tests for the three incidents. Needs DATABASE_URL (use a scratch database).
const test = require('node:test');
const assert = require('node:assert');
const { pool, init } = require('../src/db');
const { createApp, loadHolidays } = require('../src/app');

const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';
let base;
let server;

const api = async (method, url, { agent, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(agent ? { 'x-agent-id': String(agent) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
};
const newTicket = async (priority = 'medium') =>
  (await api('POST', '/api/customer/tickets', {
    body: { name: 'Cara', email: 'cara@example.com', subject: 'Cannot log in', body: 'Help please', priority },
  })).json.ticket.id;

test.before(async () => {
  if (SKIP) return;
  await init(); await loadHolidays();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) server.close(); await pool.end(); });

test('INC-0291: two agents taking the same ticket, exactly one wins', { skip: SKIP }, async () => {
  const id = await newTicket();
  const results = await Promise.all([
    api('POST', `/api/tickets/${id}/take`, { agent: 1 }),
    api('POST', `/api/tickets/${id}/take`, { agent: 2 }),
    api('POST', `/api/tickets/${id}/take`, { agent: 3 }),
  ]);
  assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
});

test('INC-0291: only the assignee can reply to the customer', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 1 });
  const r = await api('POST', `/api/tickets/${id}/messages`, { agent: 2, body: { body: 'hi', visibility: 'public' } });
  assert.strictEqual(r.status, 403);
});

test('INC-0304: internal notes never appear in any customer-facing response', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 1 });
  const secret = 'SECRET-HANDLING-NOTE-xyz';
  await api('POST', `/api/tickets/${id}/messages`, { agent: 1, body: { body: secret, visibility: 'internal' } });
  await api('POST', `/api/tickets/${id}/messages`, { agent: 1, body: { body: 'Hello Cara', visibility: 'public' } });
  const q = 'email=cara@example.com';
  const views = [
    await api('GET', `/api/customer/tickets/${id}?${q}`),
    await api('GET', `/api/customer/tickets?${q}`),
    await api('GET', `/api/customer/tickets/${id}/export.csv?${q}`),
    await api('POST', `/api/customer/tickets/${id}/reply`, { body: { email: 'cara@example.com', body: 'thanks' } }),
  ];
  for (const v of views) assert.ok(!v.text.includes(secret), 'internal note leaked');
  assert.ok(views[0].text.includes('Hello Cara'));
  // agents still see it
  const agentView = await api('GET', `/api/tickets/${id}`, { agent: 1 });
  assert.ok(agentView.text.includes(secret));
  // and it is not copied into the audit log
  assert.ok(!JSON.stringify(agentView.json.events).includes(secret));
});

test('INC-0304: a customer cannot read another customer\'s ticket', { skip: SKIP }, async () => {
  const id = await newTicket();
  const r = await api('GET', `/api/customer/tickets/${id}?email=other@example.com`);
  assert.strictEqual(r.status, 404);
});

test('INC-0318: audit events cannot be changed or deleted', { skip: SKIP }, async () => {
  const id = await newTicket();
  await assert.rejects(pool.query('UPDATE events SET actor=$1 WHERE ticket_id=$2', ['x', id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM events WHERE ticket_id=$1', [id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE events'), /append-only/);
});

test('INC-0318: actions are recorded with actor and time', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 4 });
  await api('POST', `/api/tickets/${id}/messages`, { agent: 4, body: { body: 'On it', visibility: 'public' } });
  const { json } = await api('GET', `/api/tickets/${id}`, { agent: 4 });
  const types = json.events.map((e) => e.type);
  assert.deepStrictEqual(types, ['ticket_created', 'taken', 'agent_replied', 'first_response']);
  assert.ok(json.events.every((e) => e.actor && e.created_at));
  assert.ok(json.events[1].actor.startsWith('agent:4:'));
});

test('waiting on customer pauses the clock; customer reply resumes it', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 1 });
  await api('POST', `/api/tickets/${id}/messages`, { agent: 1, body: { body: 'Which browser?', visibility: 'public', setWaiting: true } });
  let t = (await api('GET', `/api/tickets/${id}`, { agent: 1 })).json.ticket;
  assert.strictEqual(t.status, 'waiting_customer');
  assert.strictEqual(t.sla.is_waiting, true);
  await api('POST', `/api/customer/tickets/${id}/reply`, { body: { email: 'cara@example.com', body: 'Chrome' } });
  t = (await api('GET', `/api/tickets/${id}`, { agent: 1 })).json.ticket;
  assert.strictEqual(t.status, 'in_progress');
  assert.strictEqual(t.waiting_since, null);
});

test('reopen works inside the window; after it a new linked ticket is made', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 1 });
  await api('POST', `/api/tickets/${id}/status`, { agent: 1, body: { status: 'resolved' } });
  let r = await api('POST', `/api/customer/tickets/${id}/reply`, { body: { email: 'cara@example.com', body: 'Still broken' } });
  assert.strictEqual(r.json.newTicket, false);
  assert.strictEqual(r.json.ticket.status, 'in_progress');

  await api('POST', `/api/tickets/${id}/status`, { agent: 1, body: { status: 'resolved' } });
  await pool.query("UPDATE tickets SET resolved_at = now() - interval '30 days' WHERE id=$1", [id]);
  r = await api('POST', `/api/customer/tickets/${id}/reply`, { body: { email: 'cara@example.com', body: 'Again' } });
  assert.strictEqual(r.json.newTicket, true);
  assert.strictEqual(r.json.ticket.parent_ticket_id, id);
});

test('silent customer: ticket auto-closes after 5 working days', { skip: SKIP }, async () => {
  const id = await newTicket();
  await api('POST', `/api/tickets/${id}/take`, { agent: 1 });
  await api('POST', `/api/tickets/${id}/status`, { agent: 1, body: { status: 'waiting_customer' } });
  await pool.query("UPDATE tickets SET waiting_since = now() - interval '30 days' WHERE id=$1", [id]);
  const t = (await api('GET', `/api/tickets/${id}`, { agent: 1 })).json.ticket;
  assert.strictEqual(t.status, 'closed');
});

test('priority change keeps the clock; critical upgrade can make a ticket late at once', { skip: SKIP }, async () => {
  const id = await newTicket('low');
  await pool.query("UPDATE tickets SET created_at = now() - interval '10 days' WHERE id=$1", [id]);
  const r = await api('POST', `/api/tickets/${id}/priority`, { agent: 1, body: { priority: 'critical' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.sla.is_late, true);
});
