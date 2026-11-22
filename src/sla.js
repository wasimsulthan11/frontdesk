'use strict';
const bt = require('./businessTime');
const DAY = bt.WORKDAY_MINUTES;

const AUTO_CLOSE_MINUTES = 5 * DAY; // customer silent ~1 working week
const REOPEN_MINUTES = 5 * DAY;     // reopen window after "resolved"

// Working-minute budgets per priority.
function budgets(priority, createdMs) {
  if (priority === 'critical') {
    // reply in 2h, fix the same working day (end of the day the clock started)
    return { reply: 120, resolve: bt.businessMinutesBetween(createdMs, bt.workdayClose(createdMs)) };
  }
  if (priority === 'medium') return { reply: 240, resolve: 3 * DAY }; // half day, ~3 days
  return { reply: DAY, resolve: 5 * DAY };                            // 1 day, ~1 week
}

// Working minutes the clock has actually run (time waiting on the customer excluded).
function activeMinutes(t, refMs) {
  const created = +new Date(t.created_at);
  let used = bt.businessMinutesBetween(created, refMs) - Number(t.paused_minutes);
  if (t.waiting_since) used -= bt.businessMinutesBetween(+new Date(t.waiting_since), refMs);
  return Math.max(0, used);
}

const round = (n) => Math.round(n * 10) / 10;

function evaluate(t, now = Date.now()) {
  const created = +new Date(t.created_at);
  const b = budgets(t.priority, created);
  const done = t.status === 'resolved' || t.status === 'closed';
  const ref = t.status === 'resolved' ? +new Date(t.resolved_at)
            : t.status === 'closed' ? +new Date(t.closed_at) : now;
  const used = activeMinutes(t, ref);
  const pausedNow = Number(t.paused_minutes) +
    (t.waiting_since && !done ? bt.businessMinutesBetween(+new Date(t.waiting_since), now) : 0);

  const replyDone = !!t.first_response_at;
  const replyUsed = replyDone ? Number(t.first_response_minutes) : used;
  const reply = {
    budget: b.reply, used: round(replyUsed), done: replyDone,
    breached: replyUsed > b.reply,
    due_at: replyDone || done ? null : new Date(bt.addBusinessMinutes(created, b.reply + pausedNow)).toISOString(),
  };
  const resolution = {
    budget: b.resolve, used: round(used), breached: used > b.resolve,
    due_at: done ? null : new Date(bt.addBusinessMinutes(created, b.resolve + pausedNow)).toISOString(),
  };
  return {
    reply, resolution,
    is_waiting: t.status === 'waiting_customer',
    is_late: !done && ((!replyDone && reply.breached) || resolution.breached),
    reopen_until: t.status === 'resolved'
      ? new Date(bt.addBusinessMinutes(+new Date(t.resolved_at), REOPEN_MINUTES)).toISOString() : null,
  };
}

module.exports = { AUTO_CLOSE_MINUTES, REOPEN_MINUTES, budgets, activeMinutes, evaluate };
