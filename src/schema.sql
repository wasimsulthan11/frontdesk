CREATE TABLE IF NOT EXISTS agents (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  email text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  day  date PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                  serial PRIMARY KEY,
  customer_name       text NOT NULL,
  customer_email      text NOT NULL,
  subject             text NOT NULL,
  priority            text NOT NULL CHECK (priority IN ('critical','medium','low')),
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','waiting_customer','resolved','closed')),
  assignee_id         int REFERENCES agents(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  first_response_at   timestamptz,
  first_response_minutes double precision,
  paused_minutes      double precision NOT NULL DEFAULT 0,
  waiting_since       timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  parent_ticket_id    int REFERENCES tickets(id),
  reopen_count        int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);

CREATE TABLE IF NOT EXISTS messages (
  id              serial PRIMARY KEY,
  ticket_id       int NOT NULL REFERENCES tickets(id),
  author_type     text NOT NULL CHECK (author_type IN ('customer','agent')),
  author_agent_id int REFERENCES agents(id),
  author_label    text NOT NULL,
  visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','internal')),
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- customers can never write internal notes
  CHECK (author_type = 'agent' OR visibility = 'public')
);
CREATE INDEX IF NOT EXISTS messages_ticket_idx ON messages(ticket_id);

-- Append-only audit log (INC-0318). Timestamps come from the database clock.
CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  ticket_id  int NOT NULL REFERENCES tickets(id),
  actor      text NOT NULL,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_ticket_idx ON events(ticket_id);

CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events table is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
DROP TRIGGER IF EXISTS events_no_truncate ON events;
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();

-- Seed data (only inserted once)
INSERT INTO agents(name, email) VALUES
 ('Meera Nair','meera@arvo.test'),('Arun Das','arun@arvo.test'),('Priya Menon','priya@arvo.test'),
 ('Rahul Varma','rahul@arvo.test'),('Sneha Joseph','sneha@arvo.test'),('Vivek Pillai','vivek@arvo.test'),
 ('Anjali Raj','anjali@arvo.test'),('Kiran Thomas','kiran@arvo.test'),('Divya Mohan','divya@arvo.test')
ON CONFLICT (email) DO NOTHING;

-- Sample 2026 holidays for Kerala. Edit via POST /api/holidays; verify before real use.
INSERT INTO holidays(day, name) VALUES
 ('2026-01-26','Republic Day'),('2026-04-03','Good Friday'),('2026-04-14','Vishu'),
 ('2026-05-01','May Day'),('2026-08-26','Onam (Thiruvonam)'),('2026-10-02','Gandhi Jayanti'),
 ('2026-10-20','Dussehra'),('2026-11-09','Diwali (observed)'),('2026-12-25','Christmas')
ON CONFLICT (day) DO NOTHING;
