'use strict';
// Demo tickets so a reviewer sees every state on first open.
// Run once:  npm run seed     (or set SEED_DEMO=true and it runs at startup)
// Safe to run again: it only adds demo tickets that are missing.
const { pool, tx, init } = require('./db');
const bt = require('./businessTime');

const H = 3600e3;
const ago = (hours) => new Date(Date.now() - hours * H);
const D = (days) => days * 24;

// h = hours ago. who: customer | agent | note (team-only note). agent = agent id.
const DEMO = [
  { name: 'Anil Kumar', email: 'anil@demo.example', subject: 'Whole team locked out of the dashboard', priority: 'critical',
    status: 'in_progress', agent: 1, createdH: D(2),
    msgs: [{ who: 'customer', h: D(2), body: 'None of our 40 users can log in since this morning. We cannot work at all.' }],
    expect: 'LATE: critical, nobody has replied yet' },
  { name: 'Sara Thomas', email: 'sara@demo.example', subject: 'Invoice shows the wrong GST number', priority: 'medium',
    status: 'waiting_customer', agent: 1, createdH: D(3), firstH: D(3) - 2, waitingH: D(1),
    msgs: [
      { who: 'customer', h: D(3), body: 'Our March invoice has the wrong GST number. Can you correct it?' },
      { who: 'note', agent: 1, h: D(3) - 1, body: 'Checked billing: the old number is still on her account. Needs the new certificate before I can change it.' },
      { who: 'agent', agent: 1, h: D(1), body: 'Could you send a copy of your new GST certificate so we can update the account?' }],
    expect: 'WAITING: clock paused until the customer answers (try "Send as customer")' },
  { name: 'Joby Mathew', email: 'joby@demo.example', subject: 'Export to CSV is missing the last column', priority: 'low',
    status: 'in_progress', agent: 1, createdH: D(1), firstH: D(1) - 3,
    msgs: [
      { who: 'customer', h: D(1), body: 'When I export my report to CSV the Region column is missing.' },
      { who: 'agent', agent: 1, h: D(1) - 3, body: 'Thanks for reporting this. I can reproduce it and am looking into it.' },
      { who: 'note', agent: 1, h: D(1) - 4, body: 'Team note: this customer is on the legacy plan, the export bug only affects that plan. Do not promise a date.' }],
    expect: 'IN PROGRESS: has a team-only note (yellow) that the customer never sees' },
  { name: 'Lakshmi Rao', email: 'lakshmi@demo.example', subject: 'Can we add 5 more users to our plan?', priority: 'low',
    status: 'open', agent: null, createdH: 2,
    msgs: [{ who: 'customer', h: 2, body: 'We are hiring. How do we add 5 more users and what will it cost?' }],
    expect: 'UNASSIGNED: take it from the Unassigned tab' },
  { name: 'Nisha Paul', email: 'nisha@demo.example', subject: 'Payment failed but money was deducted', priority: 'critical',
    status: 'open', agent: null, createdH: 0.5,
    msgs: [{ who: 'customer', h: 0.5, body: 'My card was charged twice and the order still shows unpaid. I cannot access my account.' }],
    expect: 'UNASSIGNED and new: good for testing two agents taking the same ticket' },
  { name: 'Rahul Menon', email: 'rahul@demo.example', subject: 'Password reset email never arrives', priority: 'medium',
    status: 'resolved', agent: 2, createdH: D(3), firstH: D(3) - 1, resolvedH: D(1),
    msgs: [
      { who: 'customer', h: D(3), body: 'I asked for a password reset three times and nothing arrives.' },
      { who: 'agent', agent: 2, h: D(3) - 1, body: 'Your email was on our block list by mistake. I have removed it, please try again.' }],
    expect: 'RESOLVED yesterday: reply as the customer to see it REOPEN' },
  { name: 'Divya Nair', email: 'divya@demo.example', subject: 'Dark mode for the mobile app', priority: 'low',
    status: 'resolved', agent: 2, createdH: D(40), firstH: D(40) - 5, resolvedH: D(33),
    msgs: [
      { who: 'customer', h: D(40), body: 'Is dark mode planned for the mobile app?' },
      { who: 'agent', agent: 2, h: D(40) - 5, body: 'It is on the roadmap but has no date yet. We have noted your vote.' }],
    expect: 'RESOLVED long ago: a customer reply creates a NEW linked ticket' },
  { name: 'Faisal Khan', email: 'faisal@demo.example', subject: 'Question about data retention', priority: 'low',
    status: 'closed', agent: 3, createdH: D(25), firstH: D(25) - 2, waitingH: D(20), closedH: D(12),
    msgs: [
      { who: 'customer', h: D(25), body: 'How long do you keep our data after we cancel?' },
      { who: 'agent', agent: 3, h: D(20), body: 'Could you tell us which region your account was created in?' }],
    expect: 'CLOSED automatically: customer was silent for 5 working days' },
  { name: 'Meghna Iyer', email: 'meghna@demo.example', subject: 'Mobile app crashes on launch after update', priority: 'critical',
    status: 'in_progress', agent: 2, createdH: 3, firstH: 2.5,
    msgs: [
      { who: 'customer', h: 3, body: 'Since the latest update the app closes right after the logo. Our field staff cannot work.' },
      { who: 'agent', agent: 2, h: 2.5, body: 'Sorry about this. Which phone model and Android version are you on? We are checking the crash logs now.' }],
    expect: 'ON TRACK: critical, answered fast, fix still due the same working day' },
  { name: 'Pradeep Varghese', email: 'pradeep@demo.example', subject: 'Report scheduler runs at the wrong time', priority: 'medium',
    status: 'in_progress', agent: 3, createdH: D(6), firstH: D(6) - 3,
    msgs: [
      { who: 'customer', h: D(6), body: 'My 9 AM weekly report arrives at 3:30 AM instead.' },
      { who: 'agent', agent: 3, h: D(6) - 3, body: 'Thanks, this looks like a timezone setting. I am checking how your account is configured.' },
      { who: 'note', agent: 3, h: D(5), body: 'Account timezone is stored as UTC. Needs a data fix from engineering, not a setting change.' }],
    expect: 'LATE FIX: replied on time, but the 3-working-day fix deadline has passed' },
  { name: 'Teena George', email: 'teena@demo.example', subject: 'Feature request: bulk import of contacts', priority: 'low',
    status: 'waiting_customer', agent: 7, createdH: D(6), firstH: D(6) - 4, waitingH: D(4),
    msgs: [
      { who: 'customer', h: D(6), body: 'Can we import 2,000 contacts from a spreadsheet instead of adding them one by one?' },
      { who: 'agent', agent: 7, h: D(4), body: 'Yes, a CSV import is possible. Could you share a sample file so we can check the columns?' }],
    expect: 'NEARLY CLOSED: customer has been silent for days, auto-close is close' },
  { name: 'Biju Alexander', email: 'biju@demo.example', subject: 'Cannot upload files larger than 10 MB', priority: 'medium',
    status: 'open', agent: null, createdH: D(1),
    msgs: [{ who: 'customer', h: D(1), body: 'Uploads fail with an error for anything over 10 MB. We need to send 40 MB design files.' }],
    expect: 'UNASSIGNED AND LATE: nobody has taken it and the reply deadline passed' },
  { name: 'Reshma Das', email: 'reshma@demo.example', subject: 'API responses are very slow since Monday', priority: 'critical',
    status: 'in_progress', agent: 4, createdH: D(4),
    msgs: [
      { who: 'customer', h: D(4), body: 'Our API calls take 20+ seconds now. This started small, but it is blocking our checkout.' },
      { who: 'note', agent: 4, h: D(3), body: 'Raised from Small to Critical after the customer said checkout is blocked. The clock was not reset.' }],
    extra: [{ h: D(3), actor: 'agent:4:Rahul Varma', type: 'priority_changed',
      payload: { from: 'low', to: 'critical', clock_reset: false, late_after_change: true } }],
    expect: 'PRIORITY UPGRADE: raised to critical, clock not reset, so it is late at once. See History' },
  { name: 'Hari Krishnan', email: 'hari@demo.example', subject: 'Change company name on invoices', priority: 'low',
    status: 'resolved', agent: 9, createdH: 30, firstH: 28, resolvedH: 4,
    msgs: [
      { who: 'customer', h: 30, body: 'We have rebranded. Please update the company name on all future invoices.' },
      { who: 'agent', agent: 9, h: 28, body: 'Done. New invoices will show the new name. Old invoices are unchanged for legal reasons.' }],
    expect: 'RESOLVED hours ago: finished well inside its time limits' },
  { name: 'Shilpa Menon', email: 'shilpa@demo.example', subject: 'Email notifications stop after two days', priority: 'medium',
    status: 'in_progress', agent: 6, createdH: D(6), firstH: D(6) - 1, resolvedH: D(4), reopenH: D(2),
    msgs: [
      { who: 'customer', h: D(6), body: 'I stop getting notification emails about 2 days after I log in.' },
      { who: 'agent', agent: 6, h: D(6) - 1, body: 'This was caused by an expiring email token. I have refreshed it and set it to last longer.' },
      { who: 'customer', h: D(2), body: 'It happened again today, so the problem is not fixed.' }],
    expect: 'REOPENED: customer came back after it was marked done. Time spent resolved is not counted' },
  // ---- 15 more examples ----
  { name: 'Meera Joseph', email: 'meera.j@demo.example', subject: 'Reports page loads very slowly', priority: 'medium',
    status: 'in_progress', agent: 1, createdH: D(4), firstH: D(4) - 3,
    msgs: [
      { who: 'customer', h: D(4), body: 'The monthly reports page takes over a minute to open since last week.' },
      { who: 'agent', agent: 1, h: D(4) - 3, body: 'Thanks, we can see the slowdown on your account and are investigating.' }],
    expect: 'LATE on the fix: replied on time, but the 3-day fix window has passed' },
  { name: 'Suresh Pillai', email: 'suresh@demo.example', subject: 'API returns 500 errors on every request', priority: 'critical',
    status: 'in_progress', agent: 2, createdH: D(1), firstH: D(1) - 1,
    msgs: [
      { who: 'customer', h: D(1), body: 'Every call to your API has returned a 500 since 10am. Our checkout is down.' },
      { who: 'agent', agent: 2, h: D(1) - 1, body: 'We have escalated this to engineering and will update you within the hour.' },
      { who: 'note', agent: 2, h: D(1) - 2, body: 'Engineering says a bad deploy is the cause. Rollback planned tonight. Do not give the customer an ETA.' }],
    expect: 'LATE on the fix: critical tickets must be fixed the same working day' },
  { name: 'Bindu Krishnan', email: 'bindu@demo.example', subject: 'Help moving our data from another tool', priority: 'low',
    status: 'waiting_customer', agent: 3, createdH: D(3), firstH: D(3) - 4, waitingH: D(2),
    msgs: [
      { who: 'customer', h: D(3), body: 'We want to move over from another tool. What is the best way to import our history?' },
      { who: 'agent', agent: 3, h: D(2), body: 'Which tool are you coming from? Our importer supports CSV and a few direct connectors.' }],
    expect: 'WAITING: asked the customer a question two days ago' },
  { name: 'Ajay Varghese', email: 'ajay@demo.example', subject: 'Video upload fails at 90 percent', priority: 'medium',
    status: 'in_progress', agent: 3, createdH: 3, firstH: 2,
    msgs: [
      { who: 'customer', h: 3, body: 'When I upload a video it gets to 90 percent and then fails with a vague error.' },
      { who: 'agent', agent: 3, h: 2, body: 'Thanks. Which browser are you using? I am testing the same upload now.' }],
    expect: 'ON TRACK: fresh ticket, replied quickly' },
  { name: 'Tessa Philip', email: 'tessa@demo.example', subject: 'Webhook not firing for new orders', priority: 'medium',
    status: 'open', agent: null, createdH: D(2),
    msgs: [{ who: 'customer', h: D(2), body: 'Our webhook stopped receiving new order events on Thursday. Nothing has changed on our side.' }],
    expect: 'LATE and UNASSIGNED: nobody took it. Open Unassigned and take it' },
  { name: 'Harish Prasad', email: 'harish@demo.example', subject: 'How do I change my billing email?', priority: 'low',
    status: 'resolved', agent: 4, createdH: D(4), firstH: D(4) - 6, resolvedH: D(2),
    msgs: [
      { who: 'customer', h: D(4), body: 'Where can I change the email address that invoices are sent to?' },
      { who: 'agent', agent: 4, h: D(4) - 6, body: 'Go to Settings, then Billing, then Contacts. I have also updated it for you.' }],
    expect: 'RESOLVED two days ago: reply as the customer to reopen' },
  { name: 'Revathi Nair', email: 'revathi@demo.example', subject: 'Site down for customers in Kerala', priority: 'critical',
    status: 'resolved', agent: 5, createdH: D(4), firstH: D(4) - 1, resolvedH: D(4) - 5,
    msgs: [
      { who: 'customer', h: D(4), body: 'Our customers in Kerala cannot open the site. Other states work fine.' },
      { who: 'agent', agent: 5, h: D(4) - 1, body: 'We found a routing problem at our network provider and are fixing it now.' },
      { who: 'agent', agent: 5, h: D(4) - 5, body: 'Fixed. The site is reachable again from Kerala. Sorry for the trouble.' }],
    expect: 'RESOLVED ON TIME: a critical ticket fixed the same day' },
  { name: 'Mohan Lal', email: 'mohan@demo.example', subject: 'Error screenshot for the failed sync', priority: 'medium',
    status: 'waiting_customer', agent: 5, createdH: D(1), firstH: D(1) - 1, waitingH: 6,
    msgs: [
      { who: 'customer', h: D(1), body: 'Our sync with the accounting tool fails every night.' },
      { who: 'agent', agent: 5, h: 6, body: 'Could you send a screenshot of the error message you see in the Sync log?' }],
    expect: 'WAITING: asked for a screenshot a few hours ago' },
  { name: 'Kavya Suresh', email: 'kavya@demo.example', subject: 'Delete 5,000 old contacts at once', priority: 'low',
    status: 'in_progress', agent: 6, createdH: D(2), firstH: D(2) - 4,
    msgs: [
      { who: 'customer', h: D(2), body: 'Is there a way to delete 5,000 old contacts at once instead of one by one?' },
      { who: 'note', agent: 6, h: D(2) - 3, body: 'Bulk delete is only on the Business plan. She is on Starter. Check with sales before offering an upgrade.' },
      { who: 'agent', agent: 6, h: D(2) - 4, body: 'Yes, bulk delete exists. I am checking the best option for your plan and will confirm shortly.' },
      { who: 'note', agent: 6, h: 20, body: 'Sales confirmed a one-month Business trial is fine. Offer it.' }],
    expect: 'IN PROGRESS: two team-only notes hold the plan details' },
  { name: 'Ben Alexander', email: 'ben@demo.example', subject: 'Integration with Zoho Books', priority: 'medium',
    status: 'closed', agent: 6, createdH: D(30), firstH: D(30) - 2, waitingH: D(22), closedH: D(14),
    msgs: [
      { who: 'customer', h: D(30), body: 'Do you have a native integration with Zoho Books?' },
      { who: 'agent', agent: 6, h: D(22), body: 'Not natively, but we can connect through the API. Which features do you need?' }],
    expect: 'CLOSED AUTOMATICALLY: no reply from the customer' },
  { name: 'Nandini Rao', email: 'nandini@demo.example', subject: 'Cannot open invoices before month-end close', priority: 'critical',
    status: 'in_progress', agent: 7, createdH: 1.5, firstH: 1.2,
    msgs: [
      { who: 'customer', h: 1.5, body: 'The invoices page shows a blank screen and we close the month today.' },
      { who: 'agent', agent: 7, h: 1.2, body: 'I can see the issue. I am clearing a cached report on your account now.' }],
    expect: 'ON TRACK: critical, replied within minutes' },
  { name: 'Vineeth Kumar', email: 'vineeth@demo.example', subject: 'Change the account owner', priority: 'medium',
    status: 'resolved', agent: 7, createdH: D(45), firstH: D(45) - 2, resolvedH: D(41),
    msgs: [
      { who: 'customer', h: D(45), body: 'Our admin left the company. How do we make me the new account owner?' },
      { who: 'agent', agent: 7, h: D(45) - 2, body: 'I have transferred ownership after verifying your company email. You now have full access.' }],
    expect: 'RESOLVED LONG AGO: a customer reply starts a NEW linked ticket' },
  { name: 'Smitha Menon', email: 'smitha@demo.example', subject: 'Do you offer an annual discount?', priority: 'low',
    status: 'open', agent: null, createdH: D(1),
    msgs: [{ who: 'customer', h: D(1), body: 'We are thinking of switching to annual billing. Is there a discount?' }],
    expect: 'UNASSIGNED: a small question waiting for someone to take it' },
  { name: 'Rohit Nambiar', email: 'rohit@demo.example', subject: 'Waiting for your API key screenshot', priority: 'medium',
    status: 'waiting_customer', agent: 8, createdH: D(6), firstH: D(6) - 2, waitingH: D(4),
    msgs: [
      { who: 'customer', h: D(6), body: 'My API key stopped working after I regenerated it.' },
      { who: 'agent', agent: 8, h: D(4), body: 'Please send a screenshot of the key page, hiding all but the last 4 characters of the key.' }],
    expect: 'WAITING and nearly closed: silent for about 4 working days' },
  { name: 'Aparna Iyer', email: 'aparna@demo.example', subject: 'Data export stuck for three days', priority: 'critical',
    status: 'in_progress', agent: 9, createdH: D(2), firstH: D(2) - 20,
    msgs: [
      { who: 'customer', h: D(2), body: 'My full data export has been stuck at 40% since Thursday. We need it for an audit.' },
      { who: 'agent', agent: 9, h: D(2) - 20, body: 'Sorry for the delay. I have restarted the export and am watching it.' }],
    expect: 'MISSED FIRST REPLY and LATE: shows how a missed deadline looks in the history' },
];

async function run() {
  let created = 0;
  const { rows: hol } = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS d FROM holidays");
  bt.setHolidays(hol.map((r) => r.d));
  const names = Object.fromEntries((await pool.query('SELECT id, name FROM agents')).rows.map((a) => [a.id, a.name]));

  await tx(async (c) => {
    for (const t of DEMO) {
      const dup = await c.query('SELECT 1 FROM tickets WHERE customer_email=$1 AND subject=$2', [t.email, t.subject]);
      if (dup.rowCount) continue; // already seeded
      created += 1;
      const firstAt = t.firstH != null ? ago(t.firstH) : null;
      const firstMin = firstAt ? bt.businessMinutesBetween(+ago(t.createdH), +firstAt) : null;
      const { rows } = await c.query(
        `INSERT INTO tickets(customer_name, customer_email, subject, priority, status, assignee_id, created_at,
           first_response_at, first_response_minutes, waiting_since, resolved_at, closed_at,
           paused_minutes, reopen_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [t.name, t.email, t.subject, t.priority, t.status, t.agent, ago(t.createdH), firstAt, firstMin,
         t.waitingH != null && t.status !== 'resolved' ? ago(t.waitingH) : null,
         t.resolvedH != null && t.reopenH == null ? ago(t.resolvedH) : null, t.closedH != null ? ago(t.closedH) : null,
         t.reopenH != null ? bt.businessMinutesBetween(+ago(t.resolvedH), +ago(t.reopenH)) : 0, t.reopenH != null ? 1 : 0]);
      const id = rows[0].id;
      const actor = (a) => `agent:${a}:${names[a]}`;
      const ev = [{ h: t.createdH, actor: `customer:${t.email}`, type: 'ticket_created', payload: { priority: t.priority } }];
      if (t.agent) ev.push({ h: t.createdH - 0.1, actor: actor(t.agent), type: 'taken', payload: { agent_id: t.agent } });
      for (const m of t.msgs) {
        await c.query(
          'INSERT INTO messages(ticket_id, author_type, author_agent_id, author_label, visibility, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, m.who === 'customer' ? 'customer' : 'agent', m.agent || null, m.who === 'customer' ? t.name : names[m.agent],
           m.who === 'note' ? 'internal' : 'public', m.body, ago(m.h)]);
        if (m.who === 'agent') ev.push({ h: m.h, actor: actor(m.agent), type: 'agent_replied', payload: {} });
        if (m.who === 'note') ev.push({ h: m.h, actor: actor(m.agent), type: 'internal_note_added', payload: {} });
      }
      if (firstAt) ev.push({ h: t.firstH, actor: actor(t.agent), type: 'first_response', payload: { active_minutes: firstMin } });
      if (t.waitingH != null) ev.push({ h: t.waitingH, actor: actor(t.agent), type: 'waiting_on_customer', payload: { clock_paused: true } });
      if (t.resolvedH != null) ev.push({ h: t.resolvedH, actor: actor(t.agent), type: 'resolved', payload: {} });
      if (t.closedH != null) ev.push({ h: t.closedH, actor: 'system', type: 'auto_closed', payload: { reason: 'customer silent for 5 working days' } });
      if (t.reopenH != null) ev.push({ h: t.reopenH, actor: `customer:${t.email}`, type: 'reopened', payload: { reopen_count: 1 } });
      for (const e of t.extra || []) ev.push(e);
      ev.sort((a, b) => b.h - a.h); // oldest first
      for (const e of ev) {
        await c.query('INSERT INTO events(ticket_id, actor, type, payload, created_at) VALUES ($1,$2,$3,$4,$5)',
          [id, e.actor, e.type, JSON.stringify(e.payload), ago(e.h)]);
      }
      console.log(`#${id} ${t.subject}\n     ${t.expect}`);
    }
  });
  return created;
}

module.exports = { run };

if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first');
    await init();
    const n = await run();
    console.log(n ? `\nCreated ${n} demo tickets.` : 'All demo tickets already exist, nothing to add.');
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
