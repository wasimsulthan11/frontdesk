# What I did not finish, and why

(Draft. Edit this so it is true for what you actually shipped.)

**Not built**
- Real authentication. Agents are chosen from a dropdown and sent as a header, so any agent can pretend to be another. Customers are identified only by ticket id plus email, which is guessable. In production this needs login for agents and signed links or login for customers.
- Customer portal and email intake. I added "Add test ticket" and "Send as customer" in the agent screen to stand in for them.
- Agent assignment tools: releasing or reassigning a ticket, and a manager view of late-ticket reports (the data is in the event log).
- Pagination, search and notifications. The list shows the 200 most recent open tickets.
- Browser-based UI testing. The API and rules have automated tests; I clicked through the screen by hand only.

**Decisions I made where the story was silent** (details in the README)
- Priority change keeps the clock (no reset).
- Holiday list is a sample and must be reviewed.
- Auto-close runs lazily rather than from a scheduler because free hosting sleeps.

**Known limits**
- SLA values are computed on read, which is fine for about 40 tickets a day but would need caching at much larger scale.
- The audit log is protected by triggers, but a database superuser could still drop the trigger. A hash chain or write-once storage would be the next step.
