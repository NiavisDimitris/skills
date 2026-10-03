# Design QA fix plan — Checkout v3
Verdict: FAIL · Parity 41% · States: 8/9 verified (9 designed, 8 specified, 8 implemented)
Source: figma https://www.figma.com/design/Ck3fQ9xYzA1/Checkout-v3?node-id=2140-118 · App: http://localhost:5179/checkout/cart (local) · Ticket: CHK-214 · Generated: 2026-10-03T09:40:00Z
Triage: recommended (top 5 by rank). Choose in report.html, or run /design-qa triage CHK-214 --fix DQ-001,DQ-007,DQ-016,DQ-017,DQ-011
Dismissed: 1 · accepted as intentional: 1

## Fix now (5)
1. **DQ-001 — Stock status is a hand-styled span.pill, not the Acme DS Badge (success)** (BLOCKER, component, state cart/with-data)
   - Where: src/features/cart/CartLineItem.tsx:42 · selector `[data-testid=stock-badge]`
   - Expected: Badge variant=success: 6px radius, --ads-color-success-bg on --ads-color-success-fg, weight 600 (token Badge) · Actual: <span class="pill pill-green">: 999px pill, #D1FAE5 on #065F46, weight 500 (token none)
   - Fix: Render <Badge variant="success"> for the stock status and delete .pill / .pill-green from cart.css.
2. **DQ-007 — Country is a native <select>, not the Acme DS Select** (BLOCKER, component, state shipping/with-data)
   - Where: src/features/shipping/ShippingForm.tsx:64 · selector `[data-testid=country]`
   - Expected: Select (size md): 10px radius, 12px inset, DS chevron and listbox (token Select) · Actual: Native <select class="country-select">: 8px radius, 10px inset, OS chevron and menu (token none)
   - Fix: Use <Select> from @acme/ds with the country options; delete .country-select.
3. **DQ-016 — Review page does not render the “Items in this order” region** (BLOCKER, structure, state review/with-data)
   - Where: src/features/review/ReviewPage.tsx:54 · selector `[data-testid=review-items]`
   - Expected: Items in this order (3): thumbnail, name, variant and price per line, under the Payment block (token none) · Actual: absent: the card ends after the Payment block (token none)
   - Fix: Render <ReviewItems items={cart.items} /> after the Payment block (Acme DS surface-muted panel, 40px thumbnails).
4. **DQ-017 — Promo-applied state is not implemented: applying a code shows no discount line or new total** (BLOCKER, state, state review/promo-applied)
   - Where: src/features/review/PromoCode.tsx:14 · selector `[data-testid=promo-row]`
   - Expected: Promo row “Promo SPRING10 −€22.90” with Badge (success), total €225.50, promo field hidden (token none) · Actual: Not implemented: Apply has no handler and the total stays €248.40 (token none)
   - Fix: Wire Apply to POST /api/cart/promo and render the promo row (Badge success) and the discounted total; hide the field once applied.
5. **DQ-011 — Card name field is labelled “Cardholder name”; the design says “Name on card”** (WARNING, structure, state payment/with-data)
   - Where: src/i18n/en/checkout.json:57 · selector `label[for=f-cardname]`
   - Expected: Name on card (token none) · Actual: Cardholder name (token none)
   - Fix: Set payment.cardName to “Name on card”.

### Paste to your coding agent
```text
Fix these design-parity findings in order. Do not change data or copy beyond what each item says. Run the project's tests after each item.

[DQ-001] Stock status is a hand-styled span.pill, not the Acme DS Badge (success)
Ledger: component · State: cart/with-data · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=stock-badge] (Figma: Cart / With data / Line items / Line item / Badge)
Property: component
Expected: Badge variant=success: 6px radius, --ads-color-success-bg on --ads-color-success-fg, weight 600 (token: Badge; source: figma)
Actual: <span class="pill pill-green">: 999px pill, #D1FAE5 on #065F46, weight 500 (token: none) at src/features/cart/CartLineItem.tsx:42
  <span className="pill pill-green">{t('cart.inStock')}</span>
Fix: Render <Badge variant="success"> for the stock status and delete .pill / .pill-green from cart.css.
Patch hint: <Badge variant="success">{t('cart.inStock')}</Badge>
Files: src/features/cart/CartLineItem.tsx, src/features/cart/cart.css
Evidence: evidence/screens/cart/figma/with-data.png, evidence/screens/cart/app/with-data.png, evidence/screens/cart/computed/with-data.json, evidence/screens/cart/dom/with-data.json

[DQ-007] Country is a native <select>, not the Acme DS Select
Ledger: component · State: shipping/with-data · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=country] (Figma: Shipping / With data / Address / Country / Select)
Property: component
Expected: Select (size md): 10px radius, 12px inset, DS chevron and listbox (token: Select; source: figma)
Actual: Native <select class="country-select">: 8px radius, 10px inset, OS chevron and menu (token: none) at src/features/shipping/ShippingForm.tsx:64
  <select className="country-select" value={country} onChange={…}>
Fix: Use <Select> from @acme/ds with the country options; delete .country-select.
Patch hint: <Select label="Country" value={country} onChange={setCountry} options={countries} />
Files: src/features/shipping/ShippingForm.tsx, src/features/shipping/shipping.css
Evidence: evidence/screens/shipping/figma/with-data.png, evidence/screens/shipping/app/with-data.png, evidence/screens/shipping/computed/with-data.json, evidence/screens/shipping/dom/with-data.json

[DQ-016] Review page does not render the “Items in this order” region
Ledger: structure · State: review/with-data · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=review-items] (Figma: Review / With data / Order details / Items in this order)
Property: presence
Expected: Items in this order (3): thumbnail, name, variant and price per line, under the Payment block (token: none; source: figma)
Actual: absent: the card ends after the Payment block (token: none) at src/features/review/ReviewPage.tsx:54
  {/* TODO(CHK-219): order items */}
Fix: Render <ReviewItems items={cart.items} /> after the Payment block (Acme DS surface-muted panel, 40px thumbnails).
Patch hint: <ReviewItems items={cart.items} />
Files: src/features/review/ReviewPage.tsx
Evidence: evidence/screens/review/figma/with-data.png, evidence/screens/review/app/with-data.png, evidence/screens/review/dom/with-data.json, evidence/screens/review/diff/with-data.png

[DQ-017] Promo-applied state is not implemented: applying a code shows no discount line or new total
Ledger: state · State: review/promo-applied · Severity: BLOCKER · Resolution: FIX_CODE
Element: [data-testid=promo-row] (Figma: Review / Promo applied / Order summary / Promo row)
Property: state
Expected: Promo row “Promo SPRING10 −€22.90” with Badge (success), total €225.50, promo field hidden (token: none; source: figma)
Actual: Not implemented: Apply has no handler and the total stays €248.40 (token: none) at src/features/review/PromoCode.tsx:14
  <Button variant="secondary">Apply</Button>
Fix: Wire Apply to POST /api/cart/promo and render the promo row (Badge success) and the discounted total; hide the field once applied.
Patch hint: –
Files: src/features/review/PromoCode.tsx, src/features/checkout/OrderSummary.tsx
Evidence: evidence/screens/review/figma/promo-applied.png

[DQ-011] Card name field is labelled “Cardholder name”; the design says “Name on card”
Ledger: structure · State: payment/with-data · Severity: WARNING · Resolution: FIX_CODE
Element: label[for=f-cardname] (Figma: Payment / With data / Card details / Name on card / Label)
Property: label
Expected: Name on card (token: none; source: figma)
Actual: Cardholder name (token: none) at src/i18n/en/checkout.json:57
  "payment.cardName": "Cardholder name"
Fix: Set payment.cardName to “Name on card”.
Patch hint: "payment.cardName": "Name on card"
Files: src/i18n/en/checkout.json
Evidence: evidence/screens/payment/figma/with-data.png, evidence/screens/payment/app/with-data.png, evidence/screens/payment/dom/with-data.json
```

## Design-system mismatches
### Tokens (4)
- DQ-002 — Order total uses a hardcoded #1F2937 instead of --ads-color-text-primary — expected --ads-color-text-primary (#111827) · actual #1F2937
- DQ-003 — Line items are padded with a hardcoded 22px, not --ads-space-5 (20px) — expected --ads-space-5 (20px) · actual 22px
- DQ-009 — Unselected delivery option border is a hardcoded #D1D5DB, not --ads-color-border — expected --ads-color-border (#E5E7EB) · actual #D1D5DB
- DQ-018 — Place order button radius is a hardcoded 8px, not --ads-radius-md (10px) — expected --ads-radius-md (10px) · actual 8px
### Components (2)
- DQ-001 — Stock status is a hand-styled span.pill, not the Acme DS Badge (success) — expected Badge (Badge variant=success: 6px radius, --ads-color-success-bg on --ads-color-success-fg, weight 600) · actual <span class="pill pill-green">: 999px pill, #D1FAE5 on #065F46, weight 500
- DQ-007 — Country is a native <select>, not the Acme DS Select — expected Select (Select (size md): 10px radius, 12px inset, DS chevron and listbox) · actual Native <select class="country-select">: 8px radius, 10px inset, OS chevron and menu
### Motion (2)
- DQ-008 — Continue to payment has no hover transition (design: 160ms ease-out, --ads-motion-base) — expected --ads-motion-base (160ms ease-out on background-color and border-color) · actual none: the background switches instantly
- DQ-020 — Confirmation check animates over 600ms linear instead of 320ms ease-out (--ads-motion-slow) — expected --ads-motion-slow (ads-pop-in 320ms ease-out (cubic-bezier(0, 0, 0.58, 1)) on load) · actual pop 600ms linear on load

## Debt (7) — tickets
- DQ-013 — App renders an extra “Try again” button inside the declined-card Alert, not in the design (WARNING, owner engineering) — no ticket yet — Remove the Try again button from PaymentError; keep the Alert title and body only.
- DQ-002 — Order total uses a hardcoded #1F2937 instead of --ads-color-text-primary (WARNING, owner engineering) — no ticket yet — Drop the colour override so the total inherits --ads-color-text-primary from the DS summary.
- DQ-003 — Line items are padded with a hardcoded 22px, not --ads-space-5 (20px) (WARNING, owner engineering) — no ticket yet — Remove the padding override; the DS line item already uses --ads-space-5.
- DQ-008 — Continue to payment has no hover transition (design: 160ms ease-out, --ads-motion-base) (WARNING, owner engineering) — no ticket yet — Delete the .continue-btn override so the DS Button keeps its hover transition.
- DQ-009 — Unselected delivery option border is a hardcoded #D1D5DB, not --ads-color-border (WARNING, owner engineering) — no ticket yet — Remove the border-color override on .ads-radio-card.
- DQ-018 — Place order button radius is a hardcoded 8px, not --ads-radius-md (10px) (WARNING, owner engineering) — no ticket yet — Delete .place-order; the DS Button already uses --ads-radius-md.
- DQ-020 — Confirmation check animates over 600ms linear instead of 320ms ease-out (--ads-motion-slow) (WARNING, owner engineering) — no ticket yet — Use the DS keyframes and motion tokens for the success icon.

## Missing states / needs decision
- Review / Promo applied: MISSING_IN_CODE — Designed (Review / Promo applied) and specified (AC-7), not implemented: Apply has no handler, so no app capture or pixel diff.
- OD-1: Payment security note: the app names the payment processor (“Payments are processed by Stripe. We never store your card details.”); the design says “Your payment is encrypted and secure.” Which ships? — options: Restore the designed copy (fix code): Matches the frame; the processor disclosure added for CHK-198 disappears from the payment step.; Keep the processor disclosure (sign off as intentional): The app keeps the Stripe sentence; DQ-012 is recorded as an accepted divergence with Legal as the approver. — recommendation: Ask Legal whether CHK-198 requires the processor name on this step. If it does, sign DQ-012 off as intentional; otherwise restore the designed copy.

## Dismissed (2)
- DQ-004 — Line-item thumbnail corner is 8px; the design binds --ads-radius-md (10px) — not-an-issue — "The thumbnail is the shared ProductImage, whose 8px corner is the catalogue-wide standard (grid, product page, mini-cart). On a 64px photo the 2px difference is not visible at 1x or 2x; checked on device." — by Maya Chen, 2026-10-03
- DQ-021 — Confirmation heading drops the customer’s first name — intentional — "Confirmation pages are often left open on shared and in-store screens; Legal asked to keep the customer’s name off the heading. Approved in the Checkout v3 design review." — by Priya Raman (Product), 2026-09-29

## Cannot verify
- DQ-014 — Payment / With data: Card number focus ring cannot be verified (no focus driver) — Not captured: add surfaces.checkout.screens.payment.states.focus

Next step — design backfill: 3 undesigned state(s) found; see report-backfill.md.
