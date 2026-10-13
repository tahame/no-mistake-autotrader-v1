# Architecture

**A modular monolith.** One Node (Fastify, TypeScript) process and one Postgres database, split
into modules with clean boundaries so any of them can be lifted out later without a rewrite.

```
web (React PWA) ──HTTP /api/v1 (OpenAPI at /api/docs)──▶ server
server/src/modules/
  identity       sessions, users, roles with org/location scope, per-person rights, TOTP
  tenancy        tenants, organizations, locations, people
  catalog        menu engine: items, sizes, options, deals, taxes
  inventory      stock items, varieties, mixes, recipes, stock levels, waste, counts
  orders         POS orders, voids, refunds            ◀── isolated (see below)
  ledger         chart of accounts, double-entry posting
  finance        business days, expenses, purchases, suppliers, capital, partners, payroll
  approvals      approval requests, routing, follow-ups, questions on any entry
  notifications  in-app + web push, rules per org and per person
  reporting      read side: dashboards, plate profit, P&L, trial balance
  owner          platform owner portal: tenants, plan modules, health
```

**Boundaries are enforced by a test** (`server/test/boundaries.test.ts`): a module may use another
only through its `index.ts`, and nothing reaches into the composition root (`src/wiring.ts`).
Each module also owns its own Postgres schema (`core`, `catalog`, `inventory`, `orders`,
`finance`, `reporting`).

**Order management is separable.** `modules/orders` imports no other module. What it needs
(open day, prices, taxes, accounts, approvals) comes through `orders/ports.ts`, wired in
`wiring.ts`. What it tells the rest of the system goes out as events (`contracts/order-events.ts`)
through a transactional outbox: finance books the sale, inventory draws the ingredients,
reporting records the facts. To move orders onto its own server: implement the ports as API
calls and deliver the same events over a queue. A day cannot close until all its sale events
have been processed.

**Multi-tenant from the ground up.** Every tenant-owned row carries `tenant_id`, and Postgres
row-level security (forced, with a non-superuser application role) hides other tenants' rows even
if a query forgets to filter. Within a tenant, permissions are checked per organization and
location. Only a person's profile is shared across a customer's organizations.

**Trust.** The audit log is append-only and hash-chained (the owner portal verifies the chain).
Ledger entries and stock movements cannot be edited. Secrets live only in environment variables.

**Packaging for sale later.** `core.tenant_modules` switches whole modules per tenant (plans);
the API checks it per route group.
