# Frontdesk

Support ticket system for Arvo Systems. Node.js, Express, PostgreSQL, and a plain HTML/JS agent screen served by the same app (one service to deploy).

## Run locally

Requires Node 18+ and PostgreSQL.

```bash
createdb frontdesk
export DATABASE_URL=postgres://localhost:5432/frontdesk   # add user:password if needed
npm install
npm start            # http://localhost:3000
npm test             # business-time tests always run; incident tests need DATABASE_URL
```

The schema, 9 sample agents and sample holidays are created automatically on startup. Use a scratch database for tests (they create tickets).

## Deploy (Render, free)

1. Push this folder to GitHub.
2. Render > New > Blueprint > select the repo. `render.yaml` creates the web service and the Postgres database.
3. Open the service URL. Free services sleep after inactivity, so the first request can take about a minute. Auto-close is evaluated lazily for this reason (see below).

Set `PGSSL=true` if you connect to a database over its external URL.

## How the screen works

- Pick an agent in the header (no real login; see "Not finished").
- **My tickets** shows open tickets assigned to you, late ones first, each with a progress bar for the clock that matters now. Badges show Late and Waiting on customer.
- **Unassigned** is where you take tickets. **All open** and **Done** are also available.
- Open a ticket to reply to the customer or write a **team-only note** (yellow, clearly labelled).
- "Add test ticket" and "Send as customer" simulate the customer side, because there is no email intake.

## Rules I found in the story, and how each is implemented

| Rule | Implementation |
|---|---|
| SLA by severity | `src/sla.js`. Critical: reply 2h, fix by end of the same working day. Medium: reply 4h, fix 3 working days. Low: reply 1 working day, fix 5 working days. |
| Working hours | `src/businessTime.js`. 09:30-18:30 IST, Mon-Fri, minus the `holidays` table. A ticket created 18:00 Friday has used 30 minutes by Sunday morning, not a weekend. |
| Waiting on customer pauses the clock | `waiting_since` is stored; on customer reply the waited working minutes are added to `paused_minutes`. Deadlines are `created + budget + paused`. |
| Auto-close after about 1 working week of silence | 5 working days (2700 working minutes) in `waiting_customer`. Evaluated lazily on startup, on list/detail reads, and every 5 minutes, so it still works when a free host has been asleep. Closed time is back-dated to when it was due. |
| Reopen for about 1 week | Customer reply within 5 working days of "done" reopens the ticket. After that (or if auto-closed) a **new ticket** is created, linked via `parent_ticket_id`. |
| Agent screen | `public/index.html` |
| Reply vs team note | `messages.visibility` (`public` or `internal`). |

### Decision: changing priority mid-ticket (the open question from the meeting)

**The clock never resets.** Budgets are measured from the original creation time, so changing priority only changes the allowed time. Upgrading a 3-day-old low ticket to critical makes it late immediately, and the history event records `late_after_change`. Resetting the clock would hide real delay. Downgrading gives more time. Easy to change in `POST /tickets/:id/priority` if Arvo prefers another rule.

### Other assumptions

- Critical "fix the same working day" means by 18:30 on the day the clock starts (or the next working day if raised after hours).
- "Half a day" is 4 working hours; "about three days" is 3 x 9 working hours; reopen/auto-close "about one week" is 5 working days.
- Time between "done" and a customer reopening is not counted against Arvo.
- A ticket that is already late stays late while waiting on the customer. Pausing stops *new* lateness.
- Holidays shipped are samples for Kerala 2026. Verify and edit with `POST /api/holidays {"day":"2026-12-31","name":"..."}`.

## The three incidents

- **INC-0291 (double take):** `POST /api/tickets/:id/take` is a single conditional `UPDATE ... WHERE assignee_id IS NULL AND status='open'`. One agent wins, the others get 409. Only the assignee can send public replies or change status (403 otherwise). Tested with 3 simultaneous requests.
- **INC-0304 (private notes):** Customer endpoints (`/api/customer/*`) read through one function, `customerView`, that filters `visibility='public'` in SQL. There are no other customer read paths: screen, API, list and CSV export all use it. The audit log stores only the note's id, never its text. A DB constraint stops customers from creating internal messages. Tested across view, list, export and reply responses.
- **INC-0318 (audit trail):** `events` is append-only, enforced by database triggers that reject UPDATE, DELETE and TRUNCATE. Timestamps come from the database clock. Every state change writes its event in the same transaction as the change. Each event records actor, type, time and a small payload. The ticket screen shows the history.

## API (agent side needs header `X-Agent-Id`)

```
GET  /api/agents                       (public)
GET  /api/tickets?scope=mine|unassigned|all|done
GET  /api/tickets/:id                  ticket + all messages + events
POST /api/tickets/:id/take
POST /api/tickets/:id/messages         {body, visibility:'public'|'internal', setWaiting?}
POST /api/tickets/:id/status           {status:'waiting_customer'|'resolved'}
POST /api/tickets/:id/priority         {priority}
GET/POST /api/holidays

POST /api/customer/tickets             {name,email,subject,body,priority}
GET  /api/customer/tickets?email=
GET  /api/customer/tickets/:id?email=
GET  /api/customer/tickets/:id/export.csv?email=
POST /api/customer/tickets/:id/reply   {email, body}
```

## Tests

`test/businessTime.test.js` covers the clock (Friday 6 PM, weekends, holidays, exact end of day). `test/incidents.test.js` covers the three incidents, pause/resume, reopen vs new ticket, auto-close and the priority rule.
