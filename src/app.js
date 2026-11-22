'use strict';
const express = require('express');
const session = require('express-session');
const path = require('path');
const { pool, tx } = require('./db');
const bt = require('./businessTime');
const sla = require('./sla');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const PRIORITIES = ['critical', 'medium', 'low'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, name, max = 5000) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required`);
  if (v.length > max) throw new HttpError(400, `${name} is too long`);
  return v.trim();
}
function ticketId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Ticket not found');
  return id;
}

// ---------- shared helpers ----------
async function logEvent(c, ticketId, actor, type, payload = {}) {
  await c.query('INSERT INTO events(ticket_id, actor, type, payload) VALUES ($1,$2,$3,$4)',
    [ticketId, actor, type, JSON.stringify(payload)]);
}
async function loadHolidays() {
  const { rows } = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS d FROM holidays");
  bt.setHolidays(rows.map((r) => r.d));
}
async function lockTicket(c, id) {
  const { rows } = await c.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0]) throw new HttpError(404, 'Ticket not found');
  return rows[0];
}
const foldWaiting = (t, now) =>
  t.waiting_since ? bt.businessMinutesBetween(+new Date(t.waiting_since), now) : 0;

// Auto-close tickets whose customer has been silent for ~5 working days.
// Evaluated lazily (startup, list reads, and a timer) so it works on hosts that sleep.
async function sweep() {
  const { rows } = await pool.query("SELECT id, waiting_since FROM tickets WHERE status='waiting_customer'");
  const now = Date.now();
  for (const r of rows) {
    const ws = +new Date(r.waiting_since);
    if (bt.businessMinutesBetween(ws, now) < sla.AUTO_CLOSE_MINUTES) continue;
    const closeAt = new Date(bt.addBusinessMinutes(ws, sla.AUTO_CLOSE_MINUTES));
    await tx(async (c) => {
      const u = await c.query(
        "UPDATE tickets SET status='closed', closed_at=$2 WHERE id=$1 AND status='waiting_customer' RETURNING id",
        [r.id, closeAt]);
      if (u.rowCount) await logEvent(c, r.id, 'system', 'auto_closed',
        { reason: 'customer silent for 5 working days', closed_effective_at: closeAt.toISOString() });
    });
  }
}

// ---------- customer-facing view: THE ONLY place customer data is read (INC-0304) ----------
// Internal notes are excluded here, in SQL, so no customer path can ever return them.
async function customerView(c, id) {
  const t = await c.query(
    'SELECT id, subject, status, priority, created_at, parent_ticket_id FROM tickets WHERE id=$1', [id]);
  const m = await c.query(
    "SELECT id, author_type, author_label, body, created_at FROM messages WHERE ticket_id=$1 AND visibility='public' ORDER BY id",
    [id]);
  return { ticket: t.rows[0], messages: m.rows };
}
async function customerTicket(req, c) {
  const id = ticketId(req);
  const email = str(req.query.email || req.body?.email, 'email').toLowerCase();
  const { rows } = await c.query('SELECT customer_email FROM tickets WHERE id=$1', [id]);
  if (!rows[0] || rows[0].customer_email.toLowerCase() !== email) throw new HttpError(404, 'Ticket not found');
  return id;
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'frontdesk-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ============ AUTH ============
  app.post('/api/auth/login', wrap(async (req, res) => {
    const email = str(req.body.email, 'email').toLowerCase();
    const password = str(req.body.password, 'password');
    const { rows } = await pool.query('SELECT id, name FROM agents WHERE lower(email)=$1', [email]);
    if (!rows[0] || password !== (process.env.AGENT_PASSWORD || 'demo')) {
      throw new HttpError(401, 'Invalid email or password');
    }
    req.session.agentId = rows[0].id;
    res.json({ id: rows[0].id, name: rows[0].name });
  }));

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/auth/me', wrap(async (req, res) => {
    if (!req.session?.agentId) throw new HttpError(401, 'Not logged in');
    const { rows } = await pool.query('SELECT id, name FROM agents WHERE id=$1', [req.session.agentId]);
    if (!rows[0]) throw new HttpError(401, 'Unknown agent');
    res.json(rows[0]);
  }));

  // =============== CUSTOMER API ===============
  const cust = express.Router();

  cust.post('/tickets', wrap(async (req, res) => {
    const name = str(req.body.name, 'name', 200);
    const email = str(req.body.email, 'email', 200).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
    const subject = str(req.body.subject, 'subject', 300);
    const body = str(req.body.body, 'body');
    const priority = req.body.priority || 'medium';
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'priority is invalid');
    const view = await tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO tickets(customer_name, customer_email, subject, priority) VALUES ($1,$2,$3,$4) RETURNING id',
        [name, email, subject, priority]);
      const id = rows[0].id;
      await c.query("INSERT INTO messages(ticket_id, author_type, author_label, visibility, body) VALUES ($1,'customer',$2,'public',$3)",
        [id, name, body]);
      await logEvent(c, id, `customer:${email}`, 'ticket_created', { priority });
      return customerView(c, id);
    });
    res.status(201).json(view);
  }));

  cust.get('/tickets', wrap(async (req, res) => {
    const email = str(req.query.email, 'email').toLowerCase();
    const { rows } = await pool.query(
      'SELECT id, subject, status, created_at FROM tickets WHERE lower(customer_email)=$1 ORDER BY id DESC', [email]);
    res.json(rows);
  }));

  cust.get('/tickets/:id', wrap(async (req, res) => {
    const id = await customerTicket(req, pool);
    res.json(await customerView(pool, id));
  }));

  cust.get('/tickets/:id/export.csv', wrap(async (req, res) => {
    const id = await customerTicket(req, pool);
    const { messages } = await customerView(pool, id);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = ['time,from,message', ...messages.map((m) =>
      [new Date(m.created_at).toISOString(), q(m.author_label), q(m.body)].join(','))];
    res.type('text/csv').send(lines.join('\n'));
  }));

  // Customer reply. Resumes the SLA clock, reopens a resolved ticket inside the window,
  // or starts a new linked ticket when the old one is closed / past the reopen window.
  cust.post('/tickets/:id/reply', wrap(async (req, res) => {
    const body = str(req.body.body, 'body');
    const id = await customerTicket(req, pool);
    const out = await tx(async (c) => {
      const t = await lockTicket(c, id);
      const now = Date.now();
      const actor = `customer:${t.customer_email}`;
      const canReopen = t.status === 'resolved' &&
        now <= bt.addBusinessMinutes(+new Date(t.resolved_at), sla.REOPEN_MINUTES);

      if (t.status === 'closed' || (t.status === 'resolved' && !canReopen)) {
        const n = await c.query(
          'INSERT INTO tickets(customer_name, customer_email, subject, priority, parent_ticket_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [t.customer_name, t.customer_email, `Re: ${t.subject}`, t.priority, t.id]);
        const nid = n.rows[0].id;
        await c.query("INSERT INTO messages(ticket_id, author_type, author_label, visibility, body) VALUES ($1,'customer',$2,'public',$3)",
          [nid, t.customer_name, body]);
        await logEvent(c, nid, actor, 'ticket_created', { follows_ticket: t.id, reason: 'old ticket not reopenable' });
        await logEvent(c, t.id, 'system', 'followed_by_new_ticket', { new_ticket: nid });
        return { newTicket: true, ...(await customerView(c, nid)) };
      }

      await c.query("INSERT INTO messages(ticket_id, author_type, author_label, visibility, body) VALUES ($1,'customer',$2,'public',$3)",
        [id, t.customer_name, body]);
      const next = t.assignee_id ? 'in_progress' : 'open';
      if (canReopen) {
        // time spent resolved is not Arvo's time: add it to the paused total
        await c.query(
          'UPDATE tickets SET status=$2, resolved_at=NULL, paused_minutes=paused_minutes+$3, reopen_count=reopen_count+1 WHERE id=$1',
          [id, next, bt.businessMinutesBetween(+new Date(t.resolved_at), now)]);
        await logEvent(c, id, actor, 'reopened', { reopen_count: t.reopen_count + 1 });
      } else if (t.status === 'waiting_customer') {
        await c.query(
          'UPDATE tickets SET status=$2, waiting_since=NULL, paused_minutes=paused_minutes+$3 WHERE id=$1',
          [id, next, foldWaiting(t, now)]);
        await logEvent(c, id, actor, 'customer_replied', { resumed_clock: true });
      } else {
        await logEvent(c, id, actor, 'customer_replied', {});
      }
      return { newTicket: false, ...(await customerView(c, id)) };
    });
    res.status(201).json(out);
  }));

  app.use('/api/customer', cust);

  // =============== AGENT API ===============
  // Public roster used by the agent picker (names only)
  app.get('/api/agents', wrap(async (req, res) => {
    res.json((await pool.query('SELECT id, name FROM agents ORDER BY id')).rows);
  }));

  const agent = express.Router();

  agent.use(async (req, res, next) => {
    try {
      const id = req.session?.agentId;
      if (!Number.isInteger(id)) throw new HttpError(401, 'Please log in');
      const { rows } = await pool.query('SELECT id, name FROM agents WHERE id=$1', [id]);
      if (!rows[0]) throw new HttpError(401, 'Unknown agent');
      req.agent = rows[0];
      next();
    } catch (e) { next(e); }
  });
  const actorOf = (a) => `agent:${a.id}:${a.name}`;
  const decorate = (t, now) => ({ ...t, sla: sla.evaluate(t, now) });

  agent.get('/tickets', wrap(async (req, res) => {
    await sweep();
    const scope = req.query.scope || 'mine';
    const where = {
      mine: "t.assignee_id=$1 AND t.status NOT IN ('resolved','closed')",
      unassigned: "t.assignee_id IS NULL AND t.status NOT IN ('resolved','closed')",
      all: "t.status NOT IN ('resolved','closed')",
      done: "(t.assignee_id=$1 OR t.assignee_id IS NULL) AND t.status IN ('resolved','closed')",
    }[scope];
    if (!where) throw new HttpError(400, 'scope is invalid');
    const params = where.includes('$1') ? [req.agent.id] : [];
    const { rows } = await pool.query(
      `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id
       WHERE ${where} ORDER BY t.id DESC LIMIT 200`, params);
    const now = Date.now();
    const list = rows.map((t) => decorate(t, now));
    list.sort((a, b) => (b.sla.is_late - a.sla.is_late) ||
      String(a.sla.resolution.due_at).localeCompare(String(b.sla.resolution.due_at)));
    res.json(list);
  }));

  agent.get('/tickets/:id', wrap(async (req, res) => {
    const id = ticketId(req);
    await sweep();
    const t = await pool.query(
      'SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id WHERE t.id=$1', [id]);
    if (!t.rows[0]) throw new HttpError(404, 'Ticket not found');
    const messages = (await pool.query('SELECT * FROM messages WHERE ticket_id=$1 ORDER BY id', [id])).rows;
    const events = (await pool.query('SELECT id, actor, type, payload, created_at FROM events WHERE ticket_id=$1 ORDER BY id', [id])).rows;
    res.json({ ticket: decorate(t.rows[0]), messages, events });
  }));

  // INC-0291: single conditional UPDATE, so only one agent can win.
  agent.post('/tickets/:id/take', wrap(async (req, res) => {
    const id = ticketId(req);
    const t = await tx(async (c) => {
      const u = await c.query(
        "UPDATE tickets SET assignee_id=$1, status='in_progress' WHERE id=$2 AND assignee_id IS NULL AND status='open' RETURNING *",
        [req.agent.id, id]);
      if (!u.rows[0]) {
        const e = await c.query('SELECT assignee_id FROM tickets WHERE id=$1', [id]);
        if (!e.rows[0]) throw new HttpError(404, 'Ticket not found');
        throw new HttpError(409, 'This ticket was already taken by another agent');
      }
      await logEvent(c, id, actorOf(req.agent), 'taken', { agent_id: req.agent.id });
      return u.rows[0];
    });
    res.json(decorate(t));
  }));

  agent.post('/tickets/:id/messages', wrap(async (req, res) => {
    const id = ticketId(req);
    const body = str(req.body.body, 'body');
    const visibility = req.body.visibility === 'internal' ? 'internal' : 'public';
    const setWaiting = visibility === 'public' && req.body.setWaiting === true;
    const t = await tx(async (c) => {
      const t = await lockTicket(c, id);
      if (t.status === 'closed') throw new HttpError(409, 'Ticket is closed');
      if (visibility === 'public') {
        if (t.assignee_id !== req.agent.id) throw new HttpError(403, 'Take this ticket before replying to the customer');
        if (t.status === 'resolved') throw new HttpError(409, 'Ticket is resolved');
      }
      const now = Date.now();
      const m = await c.query(
        'INSERT INTO messages(ticket_id, author_type, author_agent_id, author_label, visibility, body) VALUES ($1,\'agent\',$2,$3,$4,$5) RETURNING id',
        [id, req.agent.id, req.agent.name, visibility, body]);
      // never put the note text in the audit log
      await logEvent(c, id, actorOf(req.agent), visibility === 'internal' ? 'internal_note_added' : 'agent_replied',
        { message_id: m.rows[0].id });
      if (visibility === 'public' && !t.first_response_at) {
        await c.query('UPDATE tickets SET first_response_at=now(), first_response_minutes=$2 WHERE id=$1',
          [id, sla.activeMinutes(t, now)]);
        await logEvent(c, id, actorOf(req.agent), 'first_response', { active_minutes: sla.activeMinutes(t, now) });
      }
      if (setWaiting && t.status !== 'waiting_customer') {
        await c.query("UPDATE tickets SET status='waiting_customer', waiting_since=now() WHERE id=$1", [id]);
        await logEvent(c, id, actorOf(req.agent), 'waiting_on_customer', { clock_paused: true });
      }
      return (await c.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
    });
    res.status(201).json(decorate(t));
  }));

  agent.post('/tickets/:id/status', wrap(async (req, res) => {
    const id = ticketId(req);
    const to = req.body.status;
    if (!['waiting_customer', 'resolved'].includes(to)) throw new HttpError(400, 'status must be waiting_customer or resolved');
    const t = await tx(async (c) => {
      const t = await lockTicket(c, id);
      if (t.assignee_id !== req.agent.id) throw new HttpError(403, 'Only the assigned agent can change status');
      if (['resolved', 'closed'].includes(t.status)) throw new HttpError(409, `Ticket is already ${t.status}`);
      if (t.status === to) throw new HttpError(409, `Ticket is already ${to}`);
      const now = Date.now();
      if (to === 'waiting_customer') {
        await c.query("UPDATE tickets SET status='waiting_customer', waiting_since=now() WHERE id=$1", [id]);
        await logEvent(c, id, actorOf(req.agent), 'waiting_on_customer', { clock_paused: true });
      } else {
        await c.query(
          "UPDATE tickets SET status='resolved', resolved_at=now(), paused_minutes=paused_minutes+$2, waiting_since=NULL WHERE id=$1",
          [id, foldWaiting(t, now)]);
        await logEvent(c, id, actorOf(req.agent), 'resolved', {});
      }
      return (await c.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
    });
    res.json(decorate(t));
  }));

  // Priority change rule: the clock never resets. The new priority's budget is measured
  // against the original start time, so an upgrade can make a ticket instantly late.
  agent.post('/tickets/:id/priority', wrap(async (req, res) => {
    const id = ticketId(req);
    const to = req.body.priority;
    if (!PRIORITIES.includes(to)) throw new HttpError(400, 'priority is invalid');
    const t = await tx(async (c) => {
      const t = await lockTicket(c, id);
      if (['resolved', 'closed'].includes(t.status)) throw new HttpError(409, `Ticket is already ${t.status}`);
      if (t.priority === to) throw new HttpError(409, 'Priority is unchanged');
      await c.query('UPDATE tickets SET priority=$2 WHERE id=$1', [id, to]);
      const after = (await c.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
      const s = sla.evaluate(after);
      await logEvent(c, id, actorOf(req.agent), 'priority_changed',
        { from: t.priority, to, clock_reset: false, late_after_change: s.is_late });
      return after;
    });
    res.json(decorate(t));
  }));

  agent.get('/holidays', wrap(async (req, res) => {
    res.json((await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, name FROM holidays ORDER BY day")).rows);
  }));
  agent.post('/holidays', wrap(async (req, res) => {
    const day = str(req.body.day, 'day', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
    await pool.query('INSERT INTO holidays(day, name) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET name=$2',
      [day, str(req.body.name, 'name', 100)]);
    await loadHolidays();
    res.status(201).json({ ok: true });
  }));

  app.use('/api', agent);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

module.exports = { createApp, loadHolidays, sweep };
