# Design debt log

open 6 · resolved 0

| Status | Since | Feature | Finding | Severity | Owner | Title | Where | Ticket |
|---|---|---|---|---|---|---|---|---|
| open | 2026-09-22 | Orders list (ACME-482) | DQ-004 | WARNING | engineering | Card padding is 20px instead of --ads-space-6 (24px) | src/features/orders/orders.css:12 · .orders-card | [ACME-511](https://acme.atlassian.net/browse/ACME-511) |
| open | 2026-09-22 | Orders list (ACME-482) | DQ-006 | WARNING | engineering | Page title weight is 500 instead of --ads-font-weight-semibold (600) | src/components/PageHeader.module.css:8 · h1.page-title | [ACME-512](https://acme.atlassian.net/browse/ACME-512) |
| open | 2026-09-22 | Orders list (ACME-482) | DQ-007 | WARNING | engineering | Skeleton bars use a 2px radius instead of --ads-radius-md (6px) | src/features/orders/OrdersSkeleton.tsx:14 · .orders-skeleton .ads-skeleton | [ACME-513](https://acme.atlassian.net/browse/ACME-513) |
| open | 2026-09-22 | Orders list (ACME-482) | DQ-008 | WARNING | engineering | Row hover transition is 400ms ease instead of 160ms ease-out (--ads-motion-base) | src/features/orders/orders.css:31 · .orders-row | [ACME-514](https://acme.atlassian.net/browse/ACME-514) |
| open | 2026-09-22 | Orders list (ACME-482) | DQ-016 | WARNING | engineering | Loading skeleton appears immediately instead of after 300 ms (AC-4) | src/features/orders/OrdersPage.tsx:37 · [data-testid=orders-skeleton] | [ACME-515](https://acme.atlassian.net/browse/ACME-515) |
| open | 2026-09-22 | Orders list (ACME-482) | DQ-021 | WARNING | engineering | Skeleton is swapped for the rows with no fade (missing 200ms dissolve) | src/features/orders/OrdersPage.tsx:41 · [data-testid=orders-skeleton] | [ACME-516](https://acme.atlassian.net/browse/ACME-516) |
