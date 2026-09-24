# Design QA fix plan — Orders list
Verdict: FAIL · Parity 45% · States: 5/9 verified (7 designed, 4 specified, 7 implemented)
Figma: https://www.figma.com/design/aBcD3fGh1JkLmN0pQrStUv/Acme-Console?node-id=1204-3310 · App: https://acme-console-git-feat-orders-acme.vercel.app/orders (preview) · Ticket: ACME-482 · Generated: 2026-09-22T14:32:08Z
Triage: 4 fix now · 6 debt (6 ticketed) · Maya Chen, 2026-09-22

## Fix now (3)
1. **DQ-001 — Empty state is not implemented** (BLOCKER, state, state empty)
   - Where: src/features/orders/OrdersTable.tsx:64 · selector `[data-testid=orders-table] tbody`
   - Expected: EmptyState: 'No orders yet', helper text and a primary 'Create order' button (token EmptyState) · Actual: Table header over an empty <tbody>; no message or action (token none)
   - Fix: Render the Acme DS EmptyState when there are no orders, with the 'Create order' primary action.
2. **DQ-002 — Table header is a hand-styled <thead>, not Acme DS Table.Header** (BLOCKER, component, state with-data)
   - Where: src/features/orders/OrdersTable.tsx:41 · selector `[data-testid=orders-table] thead`
   - Expected: Table.Header (sticky) with sortable Table.HeaderCell for Total and Created (token Table.Header) · Actual: Native <thead class="orders-th">: bold uppercase labels, 2px rule, no sort affordance (token none)
   - Fix: Replace the hand-built <thead> with Table.Header and Table.HeaderCell (sortable on Total and Created); delete the .orders-th styles.
3. **DQ-003 — Row hover background is a hardcoded hex, not --ads-color-surface-hover** (WARNING, style, state hover)
   - Where: src/features/orders/orders.css:29 · selector `.orders-row:hover`
   - Expected: #F0F4FA (token --ads-color-surface-hover) · Actual: #CFD8E6 (token none)
   - Fix: Replace the hardcoded hover colour with the surface-hover token.

### Paste to your coding agent
```text
Fix these design-parity findings in order. Do not change data or copy beyond what each item says. Run the project's tests after each item.

[DQ-001] Empty state is not implemented
Ledger: state · State: empty · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=orders-table] tbody (Figma: Orders / Empty / EmptyState)
Property: presence
Expected: EmptyState: 'No orders yet', helper text and a primary 'Create order' button (token: EmptyState; source: figma)
Actual: Table header over an empty <tbody>; no message or action (token: none) at src/features/orders/OrdersTable.tsx:64
  <tbody>{orders.map((o) => <OrderRow key={o.id} order={o} />)}</tbody>
Fix: Render the Acme DS EmptyState when there are no orders, with the 'Create order' primary action.
Patch hint: if (!orders.length) return <EmptyState icon="inbox" title="No orders yet" description="Orders you create or import will appear here." action={<Button variant="primary" onClick={onCreate}>Create order</Button>} />;
Files: src/features/orders/OrdersTable.tsx, src/features/orders/OrdersPage.tsx
Evidence: evidence/figma/empty.png

[DQ-002] Table header is a hand-styled <thead>, not Acme DS Table.Header
Ledger: component · State: with-data · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=orders-table] thead (Figma: Orders / With data / Card / Table.Header)
Property: component
Expected: Table.Header (sticky) with sortable Table.HeaderCell for Total and Created (token: Table.Header; source: figma)
Actual: Native <thead class="orders-th">: bold uppercase labels, 2px rule, no sort affordance (token: none) at src/features/orders/OrdersTable.tsx:41
  <thead className="orders-th">
    <tr>{columns.map((c) => <th key={c.id}>{c.label}</th>)}</tr>
  </thead>
Fix: Replace the hand-built <thead> with Table.Header and Table.HeaderCell (sortable on Total and Created); delete the .orders-th styles.
Patch hint: <Table.Header sticky>{columns.map((c) => <Table.HeaderCell key={c.id} sortable={c.sortable} align={c.align}>{c.label}</Table.HeaderCell>)}</Table.Header>
Files: src/features/orders/OrdersTable.tsx, src/features/orders/orders.css
Evidence: evidence/figma/with-data.png, evidence/app/with-data.png, evidence/dom/with-data.json

[DQ-003] Row hover background is a hardcoded hex, not --ads-color-surface-hover
Ledger: style · State: hover · Severity: WARNING · Resolution: FIX_CODE
Element: .orders-row:hover (Figma: Orders / Row / State=Hover)
Property: background-color
Expected: #F0F4FA (token: --ads-color-surface-hover; source: figma)
Actual: #CFD8E6 (token: none) at src/features/orders/orders.css:29
  .orders-row:hover { background: #CFD8E6; }
Fix: Replace the hardcoded hover colour with the surface-hover token.
Patch hint: .orders-row:hover { background: var(--ads-color-surface-hover); }
Files: src/features/orders/orders.css
Evidence: evidence/figma/hover.png, evidence/app/hover.png, evidence/diff/hover.png, evidence/computed/hover.json
```

## Sync to Figma (1)
- DQ-010 — 'Updated' column ships in code but is missing from the design (WARNING, structure, state with-data) — Add the approved 'Updated' column to the Figma frame and the Table.Row instances. — Figma: Orders / With data / Card / Table.Header

### Paste to your design agent
```text
Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item.

[DQ-010] 'Updated' column ships in code but is missing from the design
Ledger: structure · State: with-data · Severity: WARNING · Resolution: SYNC_FIGMA
Element: th[data-col=updated] (Figma: Orders / With data / Card / Table.Header)
Property: columns
Expected: Order · Customer · Status · Total · Created (token: none; source: figma)
Actual: Order · Customer · Status · Total · Created · Updated (token: none) at src/features/orders/columns.ts:42
  { id: 'updated', header: 'Updated', cell: (o) => formatDateTime(o.updatedAt) },
Fix: Add the approved 'Updated' column to the Figma frame and the Table.Row instances.
Patch hint: Figma: duplicate the Created column, rename it 'Updated', format 'MMM d, HH:mm'.
Files: –
Evidence: evidence/figma/with-data.png, evidence/app/with-data.png, evidence/dom/with-data.json
```

## Debt (6) — tickets
- DQ-004 — Card padding is 20px instead of --ads-space-6 (24px) (WARNING, owner engineering) — ACME-511 — Use the spacing token for the card padding.
- DQ-006 — Page title weight is 500 instead of --ads-font-weight-semibold (600) (WARNING, owner engineering) — ACME-512 — Use the semibold weight token for page titles (shared PageHeader).
- DQ-007 — Skeleton bars use a 2px radius instead of --ads-radius-md (6px) (WARNING, owner engineering) — ACME-513 — Drop the inline radius override so Skeleton uses --ads-radius-md.
- DQ-008 — Row hover transition is a hardcoded 400ms instead of --ads-motion-base (160ms) (WARNING, owner engineering) — ACME-514 — Use the motion tokens for the row hover transition.
- DQ-016 — Loading skeleton appears immediately instead of after 300 ms (AC-4) (WARNING, owner engineering) — ACME-515 — Delay the skeleton by 300 ms so fast responses never flash it.
- DQ-009 — Bulk-action bar has no design (Acme DS candidate) (DS_CANDIDATE, owner design) — ACME-516 — Design the bulk-selection pattern (select column + action bar) in Acme DS, then swap the local component for it, or remove it (OD-1).

## Missing states / needs decision
- Empty: MISSING_IN_CODE — Designed and specified (AC-2) but not implemented: with no orders the page renders the table header over an empty body.
- Bulk selected: MISSING_IN_DESIGN — Code ships a bulk-action bar (Export, Cancel orders) that has no design. Needs a decision: OD-1.
- Long content: NOT_SPECIFIED — Not designed, specified or driven. Suggest a long-names fixture and a truncation rule in the ticket.
- OD-1: Bulk selection ships in code but has no design. Design it as an Acme DS pattern, or remove it from this release? — options: Design it (Acme DS pattern): Designer adds a select column and bulk-action bar to Acme DS; code swaps BulkActionBar for the DS component. About 3 days of design and 1 of code; the feature stays.; Remove it for now: Delete BulkActionBar and the select-all control; ship without bulk actions. Parity is restored today and the feature returns with its own ticket. — recommendation: Design it. The component already works and other list pages (Customers, Invoices) need the same pattern. Keep it behind the orders-bulk flag until the Acme DS version lands.
- OD-2: Pagination: keep it in the toolbar (as built) or move it below the table (as designed)? Resolved on 2026-09-18. — options: Keep it in the toolbar (as built): Page controls stay above the fold on 12-row pages; the Figma frame needs an update.; Move it below the table (as designed): Matches the frame; page controls fall below the fold at 900px viewport height. — recommendation: Keep as built: signed off by Product on 2026-09-18 (DQ-011). Update the Figma frame so the next pass compares like with like.

## Cannot verify
- DQ-014 — Selected row background cannot be verified (no driver for the selected state) — Not captured: add surfaces.orders.states.selected
- Row selected: Designed and implemented, but no driver hook: add surfaces.orders.states.selected to design-qa.config.json so capture can open a row.
