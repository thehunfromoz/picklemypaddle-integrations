# picklemypaddle-integrations

Small service behind the Pickle My Paddle website. Jira epics: SCRUM-8 (orders and CRM),
SCRUM-9 (payments), SCRUM-10 (clubs).

Planned responsibilities:

- Receive order submissions (details + front/back paddle photos), validate and store them.
- Private status links for customers and clubs.
- Adapters, so each vendor can be swapped without touching the site:
  - CRM: HubSpot first
  - Payments: Stripe (payment links, invoices, webhooks)
  - Scheduling: HubSpot Meetings
- HubSpot properties/pipelines and Stripe products kept as configuration-as-code.

Not started yet; stories are written after the refinement rounds.
