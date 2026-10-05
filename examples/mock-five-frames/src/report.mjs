// Builds report.json for the Checkout v3 mock from the captured evidence (compare.json rows,
// computed __rect boxes, diff results) plus the hand-authored findings below, then runs the
// skill's backfill.mjs, render-report.mjs and validate.mjs. Called by ../build.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scorecardHeadline } from '../../../skills/design-qa/scripts/lib/ranking.mjs';

const GENERATED_AT = '2026-10-03T09:40:00Z';
const FIGMA_FILE = 'Ck3fQ9xYzA1';
const FIGMA_URL = (node) => `https://www.figma.com/design/${FIGMA_FILE}/Checkout-v3?node-id=${node.replace(':', '-')}`;
const TICKET = { provider: 'jira', key: 'CHK-214', url: 'https://acme.atlassian.net/browse/CHK-214', title: 'Checkout v3: five-step checkout from cart to confirmation' };
const REVIEWER = 'Maya Chen';

// Designed state frames (Figma node ids) and the ticket criteria they answer.
const STATES = [
  { screen: 'cart', state: 'with-data', node: '2140:120', name: 'Cart / With data', ac: 'AC-1', driver: { driver: 'fixture', detail: 'fixtures/checkout/three-items.json (3 line items)' } },
  { screen: 'cart', state: 'empty', node: '2140:288', name: 'Cart / Empty', ac: 'AC-2', driver: { driver: 'query', detail: 'query ?empty=1 (cart with no items)' } },
  { screen: 'shipping', state: 'with-data', node: '2140:410', name: 'Shipping / With data', ac: 'AC-3', driver: { driver: 'fixture', detail: 'fixtures/checkout/three-items.json, saved address' } },
  { screen: 'shipping', state: 'hover', node: '2140:548', name: 'Shipping / Continue to payment, State=Hover', ac: null, driver: { driver: 'action', detail: 'hover [data-testid=primary-cta]' } },
  { screen: 'payment', state: 'with-data', node: '2140:690', name: 'Payment / With data', ac: 'AC-4', driver: { driver: 'fixture', detail: 'fixtures/checkout/three-items.json, test card 4242' } },
  { screen: 'payment', state: 'error', node: '2140:812', name: 'Payment / Error', ac: 'AC-5', driver: { driver: 'query', detail: 'query ?error=1 (card_declined from the payment API mock)' } },
  { screen: 'review', state: 'with-data', node: '2140:955', name: 'Review / With data', ac: 'AC-6', driver: { driver: 'fixture', detail: 'fixtures/checkout/three-items.json' } },
  { screen: 'review', state: 'promo-applied', node: '2140:1104', name: 'Review / Promo applied', ac: 'AC-7', driver: null },
  { screen: 'confirmation', state: 'with-data', node: '2140:1230', name: 'Confirmation / With data', ac: 'AC-8', driver: { driver: 'fixture', detail: 'fixtures/checkout/placed-order.json' } },
];

const AC = {
  'AC-1': 'The cart lists each item with its variant, stock status, quantity stepper and price, and an order summary with a Go to checkout button.',
  'AC-2': "An empty cart shows the empty state with a 'Continue shopping' action.",
  'AC-3': 'Shipping collects contact details, the address and the country, and offers Standard (free) and Express delivery.',
  'AC-4': 'Payment collects the card details and shows the amount on the Pay button.',
  'AC-5': 'If the card is declined, show an error above the card fields so the customer can correct the card and pay again.',
  'AC-6': 'Review shows the address, delivery method, payment method and the items in the order before the order is placed.',
  'AC-7': 'A valid promo code shows a discount line with the code and the updated total.',
  'AC-8': 'After payment, show the order number, the delivery estimate and a receipt toast.',
};

const SOURCE = {
  cartItem: 'src/features/cart/CartLineItem.tsx',
  cartCss: 'src/features/cart/cart.css',
  summary: 'src/features/checkout/OrderSummary.tsx',
  shippingForm: 'src/features/shipping/ShippingForm.tsx',
  shippingCss: 'src/features/shipping/shipping.css',
  paymentForm: 'src/features/payment/PaymentForm.tsx',
  paymentError: 'src/features/payment/PaymentError.tsx',
  review: 'src/features/review/ReviewPage.tsx',
  reviewCss: 'src/features/review/review.css',
  promo: 'src/features/review/PromoCode.tsx',
  confirm: 'src/features/confirmation/ConfirmationPage.tsx',
  confirmCss: 'src/features/confirmation/confirmation.css',
};

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hex = (rgb) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb));
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()}` : rgb;
};
const union = (rects) => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

export async function buildReport({ HERE, ROOT, SCRIPTS, EVIDENCE, SCREENS, BASE, W, H, node, log }) {
  const REPORT = path.join(HERE, 'report.json');
  const { computeScorecard } = await import(pathToFileURL(path.join(SCRIPTS, 'lib/ranking.mjs')).href);

  // ---- Evidence --------------------------------------------------------------------
  const ev = {};
  for (const s of SCREENS) {
    const dir = path.join(EVIDENCE, 'screens', s.id);
    const side = (sub, states) => Object.fromEntries(states.map((st) => [st, load(path.join(dir, sub, `${st}.json`))]));
    ev[s.id] = {
      compare: load(path.join(dir, 'compare.json')),
      diff: load(path.join(dir, 'diff.json')).results,
      app: side('computed', s.app),
      design: side('design-computed', s.design),
      dom: side('dom', s.app),
    };
  }
  const rect = (screen, side, state, cls, index = 0) => {
    const r = ev[screen][side][state]?.[cls]?.samples?.[index]?.__rect;
    if (!r) throw new Error(`no __rect for ${screen}/${state} ${side} ${cls}[${index}]`);
    return r;
  };
  const P = (screen, kind, state, ext = 'png') => `evidence/screens/${screen}/${kind}/${state}.${ext}`;
  const E = {
    figma: (screen, state, crop) => ({ type: 'figma', path: P(screen, 'figma', state), crop, state: `${screen}/${state}` }),
    app: (screen, state, crop) => ({ type: 'screenshot', path: P(screen, 'app', state), crop, state: `${screen}/${state}` }),
    computed: (screen, state) => ({ type: 'computed', path: P(screen, 'computed', state, 'json'), crop: null, state: `${screen}/${state}` }),
    dom: (screen, state) => ({ type: 'dom', path: P(screen, 'dom', state, 'json'), crop: null, state: `${screen}/${state}` }),
    motion: (screen, state) => ({ type: 'motion', path: P(screen, 'motion', state, 'json'), crop: null, state: `${screen}/${state}` }),
    diff: (screen, state) => ({ type: 'diff', path: P(screen, 'diff', state), crop: null, state: `${screen}/${state}` }),
  };
  // Design and app crops of the same grabbed element.
  const pair = (screen, state, cls, index = 0) => [E.figma(screen, state, rect(screen, 'design', state, cls, index)), E.app(screen, state, rect(screen, 'app', state, cls, index))];
  const row = (screen, state, kind, test) => ev[screen].compare.states[state][kind].filter(test);
  const one = (screen, state, kind, test) => {
    const rows = row(screen, state, kind, test);
    if (!rows.length) throw new Error(`no ${kind} row in ${screen}/${state}`);
    return rows[0];
  };

  // ---- Findings (the claims tie compare.json FAIL rows to the finding that explains them)
  const findings = [];
  const claims = new Map(); // compare row → [finding ids]
  const F = (spec) => {
    const id = `DQ-${String(findings.length + 1).padStart(3, '0')}`;
    const { claim = [], ...f } = spec;
    for (const [screen, state, kind, test] of claim) {
      const rows = row(screen, state, kind, test);
      if (!rows.length) throw new Error(`${id}: claim matched no ${kind} row in ${screen}/${state}`);
      for (const r of rows) claims.set(r, [...(claims.get(r) ?? []), id]);
    }
    findings.push({
      id,
      title: f.title,
      ledger: f.ledger,
      state: `${f.screen}/${f.state}`,
      screen: f.screen,
      severity: f.severity,
      resolution: f.resolution,
      region: f.region,
      element: f.element,
      property: f.property ?? null,
      expected: f.expected,
      actual: f.actual,
      delta: f.delta ?? null,
      tolerance: f.tolerance ?? null,
      fix: f.fix ?? null,
      evidence: f.evidence,
      rank: null,
      signoff: f.signoff ?? null,
      ...(f.dismissal ? { dismissal: f.dismissal } : {}),
      knownDrift: null,
      acRef: f.acRef ?? null,
      ...(f.dataReason ? { dataReason: f.dataReason } : {}),
    });
    return id;
  };
  const el = (selector, figmaLayerPath, figmaNodeId) => ({ selector, figmaLayerPath, figmaNodeId });
  const src = (file, line, snippet = null) => ({ file, line, snippet });
  const is = (cls, prop) => (r) => r.elementClass === cls && (!prop || r.property === prop);

  // Cart ------------------------------------------------------------------------------
  const badge = one('cart', 'with-data', 'style', is('stockBadge', 'background-color'));
  const badgeColor = one('cart', 'with-data', 'style', is('stockBadge', 'color'));
  F({
    title: 'Stock status is a hand-styled span.pill, not the Acme DS Badge (success)',
    ledger: 'component', screen: 'cart', state: 'with-data', severity: 'BLOCKER', resolution: 'FIX_CODE', region: 'Line items',
    element: el('[data-testid=stock-badge]', 'Cart / With data / Line items / Line item / Badge', '2140:162'),
    property: 'component',
    expected: { value: 'Badge variant=success: 6px radius, --ads-color-success-bg on --ads-color-success-fg, weight 600', token: 'Badge', source: 'figma' },
    actual: { value: `<span class="pill pill-green">: 999px pill, ${hex(badge.app)} on ${hex(badgeColor.app)}, weight 500`, token: null, source: src(SOURCE.cartItem, 42, '<span className="pill pill-green">{t(\'cart.inStock\')}</span>') },
    delta: 'Recreated component: radius 999px vs 6px, colours and weight differ (15 style rows)',
    tolerance: 'Same DS component',
    fix: { summary: 'Render <Badge variant="success"> for the stock status and delete .pill / .pill-green from cart.css.', patchHint: '<Badge variant="success">{t(\'cart.inStock\')}</Badge>', files: [SOURCE.cartItem, SOURCE.cartCss], effort: 2 },
    evidence: [...pair('cart', 'with-data', 'stockBadge'), E.computed('cart', 'with-data'), E.dom('cart', 'with-data')],
    acRef: 'AC-1',
    claim: [['cart', 'with-data', 'style', (r) => r.elementClass === 'stockBadge' && r.result === 'FAIL'], ['cart', 'with-data', 'tokens', is('stockBadge')], ['cart', 'with-data', 'components', (r) => r.elementClass === 'stockBadge' && r.result === 'FAIL']],
  });
  const total = one('cart', 'with-data', 'style', is('summaryTotal', 'color'));
  F({
    title: 'Order total uses a hardcoded #1F2937 instead of --ads-color-text-primary',
    ledger: 'style', screen: 'cart', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Order summary',
    element: el('[data-testid=summary-total]', 'Cart / With data / Order summary / Total', '2140:201'),
    property: 'color',
    expected: { value: hex(total.design), token: '--ads-color-text-primary', source: 'figma' },
    actual: { value: hex(total.app), token: null, source: src(SOURCE.cartCss, 31, '.summary-total { color: #1f2937; }') },
    delta: 'Different colour (ΔE 4.1); raw hex in code', tolerance: 'Exact token',
    fix: { summary: 'Drop the colour override so the total inherits --ads-color-text-primary from the DS summary.', patchHint: '.summary-total { color: var(--ads-color-text-primary); }', files: [SOURCE.cartCss], effort: 1 },
    evidence: [...pair('cart', 'with-data', 'summaryTotal'), E.computed('cart', 'with-data')],
    claim: [['cart', 'with-data', 'style', is('summaryTotal', 'color')], ['cart', 'with-data', 'tokens', is('summaryTotal', 'color')]],
  });
  const pad = one('cart', 'with-data', 'style', (r) => r.elementClass === 'lineItem' && r.property === 'padding-bottom');
  F({
    title: `Line items are padded with a hardcoded ${pad.app}, not --ads-space-5 (${pad.design})`,
    ledger: 'style', screen: 'cart', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Line items',
    element: el('[data-testid=line-item]', 'Cart / With data / Line items / Line item', '2140:158'),
    property: 'padding-top, padding-bottom',
    expected: { value: pad.design, token: '--ads-space-5', source: 'figma' },
    actual: { value: pad.app, token: null, source: src(SOURCE.cartCss, 12, `.line-item { padding-top: ${pad.app}; padding-bottom: ${pad.app}; }`) },
    delta: '+2px per side (+12px over the list)', tolerance: '±1px',
    fix: { summary: 'Remove the padding override; the DS line item already uses --ads-space-5.', patchHint: '.line-item { padding-block: var(--ads-space-5); }', files: [SOURCE.cartCss], effort: 1 },
    evidence: [...pair('cart', 'with-data', 'lineItem', 1), E.computed('cart', 'with-data')],
    claim: [['cart', 'with-data', 'style', (r) => r.elementClass === 'lineItem' && r.result === 'FAIL'], ['cart', 'with-data', 'tokens', is('lineItem')]],
  });
  const thumbR = one('cart', 'with-data', 'style', is('thumb', 'border-radius'));
  F({
    title: `Line-item thumbnail corner is ${thumbR.app}; the design binds --ads-radius-md (${thumbR.design})`,
    ledger: 'style', screen: 'cart', state: 'with-data', severity: 'WARNING', resolution: 'DISMISSED', region: 'Line items',
    element: el('[data-testid=line-item-thumb]', 'Cart / With data / Line items / Line item / Thumbnail', '2140:160'),
    property: 'border-radius',
    expected: { value: thumbR.design, token: '--ads-radius-md', source: 'figma' },
    actual: { value: thumbR.app, token: null, source: src('src/components/ProductImage.module.css', 4, '.image { border-radius: 8px; }') },
    delta: '−2px', tolerance: '±1px',
    evidence: [...pair('cart', 'with-data', 'thumb'), E.computed('cart', 'with-data')],
    dismissal: {
      kind: 'not-an-issue',
      reason: 'The thumbnail is the shared ProductImage, whose 8px corner is the catalogue-wide standard (grid, product page, mini-cart). On a 64px photo the 2px difference is not visible at 1x or 2x; checked on device.',
      by: REVIEWER, date: '2026-10-03T10:05:00Z', source: 'report-ui', priorRef: null,
    },
    claim: [['cart', 'with-data', 'style', is('thumb', 'border-radius')], ['cart', 'with-data', 'tokens', is('thumb', 'border-radius')]],
  });
  F({
    title: 'Order summary uses Acme DS Card, rows and Button (primary) as designed',
    ledger: 'component', screen: 'cart', state: 'with-data', severity: 'PASS', resolution: 'NONE', region: 'Order summary',
    element: el('aside[aria-label="Order summary"]', 'Cart / With data / Order summary', '2140:190'),
    property: 'component',
    expected: { value: 'Card · Button variant=primary (block)', token: 'Card, Button', source: 'figma' },
    actual: { value: 'Card · Button variant=primary (block)', token: 'Card, Button', source: src(SOURCE.summary, 18) },
    delta: 'background, radius, padding, shadow, button colour, height and type match', tolerance: 'Same DS component',
    evidence: [...pair('cart', 'with-data', 'primaryCta'), E.computed('cart', 'with-data')],
  });
  F({
    title: 'Empty cart matches the design: Acme DS EmptyState with Continue shopping',
    ledger: 'state', screen: 'cart', state: 'empty', severity: 'PASS', resolution: 'NONE', region: 'Empty state',
    element: el('[data-component=EmptyState]', 'Cart / Empty / EmptyState', '2140:291'),
    property: 'state',
    expected: { value: 'EmptyState: illustration, “Your cart is empty”, body copy, Button (primary) “Continue shopping”', token: 'EmptyState', source: 'figma' },
    actual: { value: 'EmptyState with the same copy and Button (primary)', token: 'EmptyState', source: src(SOURCE.cartItem, 12) },
    delta: 'Pixel diff 0%; copy and styles match', tolerance: 'Exact',
    evidence: [...pair('cart', 'empty', 'emptyState'), E.diff('cart', 'empty')],
    acRef: 'AC-2',
  });

  // Shipping --------------------------------------------------------------------------
  F({
    title: 'Country is a native <select>, not the Acme DS Select',
    ledger: 'component', screen: 'shipping', state: 'with-data', severity: 'BLOCKER', resolution: 'FIX_CODE', region: 'Contact and address',
    element: el('[data-testid=country]', 'Shipping / With data / Address / Country / Select', '2140:436'),
    property: 'component',
    expected: { value: 'Select (size md): 10px radius, 12px inset, DS chevron and listbox', token: 'Select', source: 'figma' },
    actual: { value: 'Native <select class="country-select">: 8px radius, 10px inset, OS chevron and menu', token: null, source: src(SOURCE.shippingForm, 64, '<select className="country-select" value={country} onChange={…}>') },
    delta: 'Raw element where a DS component exists; radius −2px, padding −2px', tolerance: 'Same DS component',
    fix: { summary: 'Use <Select> from @acme/ds with the country options; delete .country-select.', patchHint: '<Select label="Country" value={country} onChange={setCountry} options={countries} />', files: [SOURCE.shippingForm, SOURCE.shippingCss], effort: 2 },
    evidence: [...pair('shipping', 'with-data', 'countrySelect'), E.computed('shipping', 'with-data'), E.dom('shipping', 'with-data')],
    acRef: 'AC-3',
    claim: [['shipping', 'with-data', 'style', (r) => r.elementClass === 'countrySelect' && r.result === 'FAIL'], ['shipping', 'with-data', 'tokens', is('countrySelect')], ['shipping', 'with-data', 'components', (r) => r.elementClass === 'countrySelect' && r.result === 'FAIL']],
  });
  F({
    title: 'Continue to payment has no hover transition (design: 160ms ease-out, --ads-motion-base)',
    ledger: 'motion', screen: 'shipping', state: 'hover', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Actions',
    element: el('[data-testid=primary-cta]', 'Shipping / Actions / Button (Primary)', '2140:470'),
    property: 'transition',
    expected: { value: '160ms ease-out on background-color and border-color', token: '--ads-motion-base', source: 'figma' },
    actual: { value: 'none: the background switches instantly', token: null, source: src(SOURCE.shippingCss, 9, '.continue-btn { transition: none; }') },
    delta: 'Missing motion', tolerance: '±20ms',
    fix: { summary: 'Delete the .continue-btn override so the DS Button keeps its hover transition.', patchHint: '/* remove */ .continue-btn { transition: none; }', files: [SOURCE.shippingCss], effort: 1 },
    evidence: [...pair('shipping', 'hover', 'primaryCta'), E.motion('shipping', 'hover'), E.computed('shipping', 'hover')],
    claim: [['shipping', 'hover', 'motion', (r) => r.result === 'FAIL']],
  });
  const opt = one('shipping', 'with-data', 'style', (r) => r.elementClass === 'deliveryOption' && r.result === 'FAIL');
  F({
    title: 'Unselected delivery option border is a hardcoded #D1D5DB, not --ads-color-border',
    ledger: 'style', screen: 'shipping', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Delivery method',
    element: el('[data-testid=delivery-option][aria-checked=false]', 'Shipping / With data / Delivery / RadioCard (Unselected)', '2140:452'),
    property: 'border-color',
    expected: { value: hex(opt.design), token: '--ads-color-border', source: 'figma' },
    actual: { value: hex(opt.app), token: null, source: src(SOURCE.shippingCss, 8, '.ads-radio-card { border-color: #d1d5db; }') },
    delta: 'Darker border (ΔE 5.6)', tolerance: 'Exact token',
    fix: { summary: 'Remove the border-color override on .ads-radio-card.', patchHint: null, files: [SOURCE.shippingCss], effort: 1 },
    evidence: [...pair('shipping', 'with-data', 'deliveryOption', 1), E.computed('shipping', 'with-data')],
    claim: [['shipping', 'with-data', 'style', (r) => r.elementClass === 'deliveryOption' && r.result === 'FAIL'], ['shipping', 'with-data', 'tokens', is('deliveryOption')]],
  });
  F({
    title: 'Stepper, inputs and delivery RadioCards use Acme DS components as designed',
    ledger: 'component', screen: 'shipping', state: 'with-data', severity: 'PASS', resolution: 'NONE', region: 'Top bar',
    element: el('[data-component=Stepper]', 'Shipping / Top bar / Stepper', '2140:414'),
    property: 'component',
    expected: { value: 'Stepper (step 2 current) · Input ×5 · RadioCard ×2', token: 'Stepper, Input, RadioCard', source: 'figma' },
    actual: { value: 'Stepper (step 2 current) · Input ×5 · RadioCard ×2', token: 'Stepper, Input, RadioCard', source: src(SOURCE.shippingForm, 22) },
    delta: 'component, variant, current step, gap and type match', tolerance: 'Same DS component',
    evidence: [...pair('shipping', 'with-data', 'stepper'), E.computed('shipping', 'with-data')],
  });

  // Payment ---------------------------------------------------------------------------
  F({
    title: 'Card name field is labelled “Cardholder name”; the design says “Name on card”',
    ledger: 'structure', screen: 'payment', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Card details',
    element: el('label[for=f-cardname]', 'Payment / With data / Card details / Name on card / Label', '2140:702'),
    property: 'label',
    expected: { value: 'Name on card', token: null, source: 'figma' },
    actual: { value: 'Cardholder name', token: null, source: src('src/i18n/en/checkout.json', 57, '"payment.cardName": "Cardholder name"') },
    delta: 'Copy differs', tolerance: 'Exact copy',
    fix: { summary: 'Set payment.cardName to “Name on card”.', patchHint: '"payment.cardName": "Name on card"', files: ['src/i18n/en/checkout.json'], effort: 1 },
    evidence: [...pair('payment', 'with-data', 'fieldLabel', 0), E.dom('payment', 'with-data')],
    acRef: 'AC-4',
    claim: [['payment', 'with-data', 'structure', (r) => r.role === 'textbox']],
  });
  F({
    title: 'Security note copy differs from the design',
    ledger: 'structure', screen: 'payment', state: 'with-data', severity: 'WARNING', resolution: 'UNCLASSIFIED', region: 'Card details',
    element: el('[data-testid=secure-note]', 'Payment / With data / Card details / Security note', '2140:731'),
    property: 'text',
    expected: { value: 'Your payment is encrypted and secure.', token: null, source: 'figma' },
    actual: { value: 'Payments are processed by Stripe. We never store your card details.', token: null, source: src(SOURCE.paymentForm, 88, '<p className="opt-sub">{t(\'payment.processorNote\')}</p>') },
    delta: 'Copy differs; the app names the payment processor', tolerance: 'Exact copy',
    fix: { summary: 'Waiting on OD-1: restore the designed copy, or sign the processor disclosure off as intentional.', patchHint: null, files: ['src/i18n/en/checkout.json'], effort: 1 },
    evidence: [...pair('payment', 'with-data', 'secureNote'), E.dom('payment', 'with-data')],
  });
  F({
    title: 'App renders an extra “Try again” button inside the declined-card Alert, not in the design',
    ledger: 'structure', screen: 'payment', state: 'error', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Declined-card alert',
    element: el('[data-testid=alert-action]', 'Payment / Error / Alert (Danger)', '2140:815'),
    property: 'presence',
    expected: { value: 'absent: the Alert has a title and body only; the customer fixes the card fields and presses Pay again', token: null, source: 'figma' },
    actual: { value: 'Button (secondary, 32px) “Try again” under the Alert body', token: null, source: src(SOURCE.paymentError, 19, '<Button variant="secondary" size="sm" onClick={retry}>Try again</Button>') },
    delta: 'Extra element in a designed state', tolerance: 'Exact structure',
    fix: { summary: 'Remove the Try again button from PaymentError; keep the Alert title and body only.', patchHint: null, files: [SOURCE.paymentError], effort: 1 },
    evidence: [E.figma('payment', 'error', rect('payment', 'design', 'error', 'alert')), E.app('payment', 'error', rect('payment', 'app', 'error', 'alertAction')), E.dom('payment', 'error'), E.diff('payment', 'error')],
    acRef: 'AC-5',
    claim: [['payment', 'error', 'structure', () => true]],
  });
  F({
    title: 'Card number focus ring cannot be verified (no focus driver)',
    ledger: 'style', screen: 'payment', state: 'with-data', severity: 'CANNOT_VERIFY', resolution: 'NONE', region: 'Card details',
    element: el('#f-cardnumber:focus-visible', 'Components / Input / State=Focus', '311:2046'),
    property: 'outline',
    expected: { value: '2px --ads-color-brand ring, 2px offset (Input, State=Focus)', token: '--ads-color-brand', source: 'figma' },
    actual: { value: null, token: null, source: src(SOURCE.paymentForm, 41) },
    delta: 'Not captured: add surfaces.checkout.screens.payment.states.focus', tolerance: 'Exact token',
    evidence: [...pair('payment', 'with-data', 'fieldControl', 1)],
  });
  F({
    title: 'Declined-card banner uses Acme DS Alert (danger) as designed',
    ledger: 'component', screen: 'payment', state: 'error', severity: 'PASS', resolution: 'NONE', region: 'Declined-card alert',
    element: el('[data-component=Alert]', 'Payment / Error / Alert (Danger)', '2140:815'),
    property: 'component',
    expected: { value: 'Alert variant=danger', token: 'Alert', source: 'figma' },
    actual: { value: 'Alert variant=danger', token: 'Alert', source: src(SOURCE.paymentError, 12, '<Alert variant="danger" title={t(\'payment.declined.title\')}>') },
    delta: 'background, text colour, radius and padding match', tolerance: 'Same DS component',
    evidence: [...pair('payment', 'error', 'alertTitle'), E.computed('payment', 'error')],
  });

  // Review ----------------------------------------------------------------------------
  const lastBlock = rect('review', 'app', 'with-data', 'reviewBlock', 2);
  F({
    title: 'Review page does not render the “Items in this order” region',
    ledger: 'structure', screen: 'review', state: 'with-data', severity: 'BLOCKER', resolution: 'FIX_CODE', region: 'Items in this order',
    element: el('[data-testid=review-items]', 'Review / With data / Order details / Items in this order', '2140:982'),
    property: 'presence',
    expected: { value: 'Items in this order (3): thumbnail, name, variant and price per line, under the Payment block', token: null, source: 'figma' },
    actual: { value: 'absent: the card ends after the Payment block', token: null, source: src(SOURCE.review, 54, '{/* TODO(CHK-219): order items */}') },
    delta: 'Missing region', tolerance: 'Exact structure',
    fix: { summary: 'Render <ReviewItems items={cart.items} /> after the Payment block (Acme DS surface-muted panel, 40px thumbnails).', patchHint: '<ReviewItems items={cart.items} />', files: [SOURCE.review], effort: 3 },
    evidence: [
      E.figma('review', 'with-data', rect('review', 'design', 'with-data', 'reviewItems')),
      E.app('review', 'with-data', { x: lastBlock.x, y: lastBlock.y + lastBlock.h, w: lastBlock.w, h: 24 }),
      E.dom('review', 'with-data'), E.diff('review', 'with-data'),
    ],
    acRef: 'AC-6',
    claim: [['review', 'with-data', 'structure', () => true]],
  });
  F({
    title: 'Promo-applied state is not implemented: applying a code shows no discount line or new total',
    ledger: 'state', screen: 'review', state: 'promo-applied', severity: 'BLOCKER', resolution: 'FIX_CODE', region: 'Order summary',
    element: el('[data-testid=promo-row]', 'Review / Promo applied / Order summary / Promo row', '2140:1121'),
    property: 'state',
    expected: { value: 'Promo row “Promo SPRING10 −€22.90” with Badge (success), total €225.50, promo field hidden', token: null, source: 'figma' },
    actual: { value: 'Not implemented: Apply has no handler and the total stays €248.40', token: null, source: src(SOURCE.promo, 14, '<Button variant="secondary">Apply</Button>') },
    delta: 'Designed state missing in code', tolerance: 'State exists',
    fix: { summary: 'Wire Apply to POST /api/cart/promo and render the promo row (Badge success) and the discounted total; hide the field once applied.', patchHint: null, files: [SOURCE.promo, SOURCE.summary], effort: 3 },
    evidence: [E.figma('review', 'promo-applied', rect('review', 'design', 'promo-applied', 'promoRow'))],
    acRef: 'AC-7',
  });
  const btnR = one('review', 'with-data', 'style', is('primaryCta', 'border-radius'));
  F({
    title: `Place order button radius is a hardcoded ${btnR.app}, not --ads-radius-md (${btnR.design})`,
    ledger: 'style', screen: 'review', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Order summary',
    element: el('[data-testid=primary-cta]', 'Review / With data / Order summary / Button (Primary)', '2140:1010'),
    property: 'border-radius',
    expected: { value: btnR.design, token: '--ads-radius-md', source: 'figma' },
    actual: { value: btnR.app, token: null, source: src(SOURCE.reviewCss, 3, '.place-order { border-radius: 8px; }') },
    delta: '−2px', tolerance: '±1px',
    fix: { summary: 'Delete .place-order; the DS Button already uses --ads-radius-md.', patchHint: null, files: [SOURCE.reviewCss], effort: 1 },
    evidence: [...pair('review', 'with-data', 'primaryCta'), E.computed('review', 'with-data')],
    claim: [['review', 'with-data', 'style', is('primaryCta', 'border-radius')], ['review', 'with-data', 'tokens', is('primaryCta', 'border-radius')]],
  });
  F({
    title: 'Ship to, Delivery and Payment blocks match the design (order, labels, Edit links)',
    ledger: 'structure', screen: 'review', state: 'with-data', severity: 'PASS', resolution: 'NONE', region: 'Order details',
    element: el('[data-testid=review-block]', 'Review / With data / Order details', '2140:960'),
    property: 'structure',
    expected: { value: 'Ship to · Delivery · Payment, each with Edit', token: null, source: 'figma' },
    actual: { value: 'Ship to · Delivery · Payment, each with Edit', token: null, source: src(SOURCE.review, 31) },
    delta: 'order, labels, dividers and link styles match', tolerance: 'Exact structure',
    evidence: [
      E.figma('review', 'with-data', union([0, 1, 2].map((i) => rect('review', 'design', 'with-data', 'reviewBlock', i)))),
      E.app('review', 'with-data', union([0, 1, 2].map((i) => rect('review', 'app', 'with-data', 'reviewBlock', i)))),
    ],
  });

  // Confirmation ----------------------------------------------------------------------
  F({
    title: 'Confirmation check animates over 600ms linear instead of 320ms ease-out (--ads-motion-slow)',
    ledger: 'motion', screen: 'confirmation', state: 'with-data', severity: 'WARNING', resolution: 'FIX_CODE', region: 'Confirmation',
    element: el('[data-testid=confirm-icon]', 'Confirmation / With data / Success icon', '2140:1236'),
    property: 'animation',
    expected: { value: 'ads-pop-in 320ms ease-out (cubic-bezier(0, 0, 0.58, 1)) on load', token: '--ads-motion-slow', source: 'figma' },
    actual: { value: 'pop 600ms linear on load', token: null, source: src(SOURCE.confirmCss, 3, '.confirm-icon { animation: pop 600ms linear both; }') },
    delta: '+280ms, easing differs', tolerance: '±20ms',
    fix: { summary: 'Use the DS keyframes and motion tokens for the success icon.', patchHint: '.confirm-icon { animation: ads-pop-in var(--ads-motion-slow) var(--ads-ease-out) both; }', files: [SOURCE.confirmCss], effort: 1 },
    evidence: [...pair('confirmation', 'with-data', 'confirmIcon'), E.motion('confirmation', 'with-data')],
    acRef: 'AC-8',
    claim: [['confirmation', 'with-data', 'motion', (r) => r.result === 'FAIL']],
  });
  F({
    title: 'Confirmation heading drops the customer’s first name',
    ledger: 'structure', screen: 'confirmation', state: 'with-data', severity: 'WARNING', resolution: 'INTENTIONAL', region: 'Confirmation',
    element: el('h1', 'Confirmation / With data / Heading', '2140:1238'),
    property: 'text',
    expected: { value: 'Thanks, Dana! Your order is confirmed', token: null, source: 'figma' },
    actual: { value: 'Thank you, your order is confirmed', token: null, source: src(SOURCE.confirm, 27, "<h1>{t('confirmation.title')}</h1>") },
    delta: 'Copy differs (no first name)', tolerance: 'Exact copy',
    evidence: [...pair('confirmation', 'with-data', 'pageTitle'), E.dom('confirmation', 'with-data')],
    signoff: { by: 'Priya Raman (Product)', date: '2026-09-29', reason: 'Confirmation pages are often left open on shared and in-store screens; Legal asked to keep the customer’s name off the heading. Approved in the Checkout v3 design review.' },
    claim: [['confirmation', 'with-data', 'structure', (r) => r.role === 'heading']],
  });
  F({
    title: 'Order number differs (#AC-10517 in the app, #AC-10482 in the frame)',
    ledger: 'structure', screen: 'confirmation', state: 'with-data', severity: 'WARNING', resolution: 'DATA', region: 'Confirmation',
    element: el('[data-testid=order-number]', 'Confirmation / With data / Order number', '2140:1240'),
    property: 'text',
    expected: { value: '#AC-10482', token: null, source: 'figma' },
    actual: { value: '#AC-10517', token: null, source: src(SOURCE.confirm, 31, '<span className="order-number">#{order.number}</span>') },
    delta: 'Data value (order id from the API); masked in the pixel diff', tolerance: 'Data may differ',
    dataReason: 'The order number comes from the API for each order; its type, colour and position match the frame.',
    evidence: [...pair('confirmation', 'with-data', 'orderNumber'), E.dom('confirmation', 'with-data')],
  });
  F({
    title: 'Receipt toast slides in over 240ms ease-out as designed',
    ledger: 'motion', screen: 'confirmation', state: 'with-data', severity: 'PASS', resolution: 'NONE', region: 'Toast',
    element: el('[data-component=Toast]', 'Confirmation / With data / Toast', '2140:1252'),
    property: 'animation',
    expected: { value: 'ads-toast-in 240ms ease-out on load', token: null, source: 'figma' },
    actual: { value: 'ads-toast-in 240ms ease-out on load', token: null, source: src(SOURCE.confirm, 52, '<Toast tone="inverse">…</Toast>') },
    delta: 'type, duration, easing and delay match', tolerance: '±20ms',
    evidence: [...pair('confirmation', 'with-data', 'toast'), E.motion('confirmation', 'with-data')],
  });

  // Every compare FAIL row must be explained by a finding.
  const unclaimed = [];
  for (const s of SCREENS) {
    for (const [state, rows] of Object.entries(ev[s.id].compare.states)) {
      const fails = [
        ...rows.style.filter((r) => r.result === 'FAIL'), ...rows.tokens, ...rows.components.filter((r) => r.result === 'FAIL'),
        ...rows.motion.filter((r) => r.result === 'FAIL'), ...rows.structure,
      ];
      for (const r of fails) if (!claims.has(r)) unclaimed.push(`${s.id}/${state} ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
  if (unclaimed.length) throw new Error(`compare FAIL rows without a finding:\n${unclaimed.join('\n')}`);
  const ids = (r) => claims.get(r) ?? [];
  const byState = (sid) => findings.filter((f) => f.state === sid).map((f) => f.id);
  const fid = (title) => findings.find((f) => f.title.startsWith(title)).id;

  // ---- State matrix -------------------------------------------------------------------
  // What the app capture covered (stateMatrix[].captured.page), from capture.json: page, size, fullPage,
  // clipped. Captures written before capture.mjs recorded the page size fall back to the PNG's own size.
  const pageCovered = (screen, state) => {
    const capture = JSON.parse(readFileSync(path.join(EVIDENCE, 'screens', screen, 'capture.json'), 'utf8'));
    const c = capture.states?.[state] || {};
    const png = readFileSync(path.join(EVIDENCE, 'screens', screen, 'app', `${state}.png`));
    const size = c.size ?? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    const page = c.page ?? size;
    return { width: page.width, height: page.height, fullPage: c.fullPage ?? capture.fullPage ?? false, clipped: Array.isArray(c.clipped) ? c.clipped.length : 0, image: { width: size.width, height: size.height } };
  };
  const stateMatrix = STATES.map((st) => {
    const sid = `${st.screen}/${st.state}`;
    const screen = SCREENS.find((s) => s.id === st.screen);
    const hasApp = screen.app.includes(st.state);
    const fs = findings.filter((f) => f.state === sid);
    const open = fs.some((f) => ['FIX_CODE', 'UNCLASSIFIED'].includes(f.resolution));
    return {
      state: sid,
      screen: st.screen,
      label: st.state === 'with-data' ? 'With data' : st.state === 'promo-applied' ? 'Promo applied' : st.state[0].toUpperCase() + st.state.slice(1),
      designed: { nodeId: st.node, name: st.name },
      specified: st.ac ? { acRef: st.ac, text: AC[st.ac] } : null,
      implemented: st.driver,
      captured: {
        design: P(st.screen, 'figma', st.state), app: hasApp ? P(st.screen, 'app', st.state) : null, diff: hasApp ? P(st.screen, 'diff', st.state) : null,
        ...(hasApp ? { page: pageCovered(st.screen, st.state) } : {}),
      },
      result: !hasApp ? 'MISSING_IN_CODE' : open ? 'FAIL' : 'PASS',
      note: !hasApp
        ? 'Designed (Review / Promo applied) and specified (AC-7), not implemented: Apply has no handler, so no app capture or pixel diff.'
        : st.state === 'hover' ? 'Driven by hovering Continue to payment; the hover colour matches, the transition is missing (DQ-008).' : null,
      findings: fs.map((f) => f.id),
    };
  });

  // ---- Ledgers ------------------------------------------------------------------------
  const screenName = (id) => SCREENS.find((s) => s.id === id).name;
  const CATEGORY = [
    [/color/, /^--ads-color-/], [/radius/, /^--ads-radius-/], [/padding|gap|margin/, /^--ads-space-/], [/font-size/, /^--ads-font-size-/],
  ];
  const designToken = (screen, state, cls, index, prop) => {
    const vars = ev[screen].design[state]?.[cls]?.samples?.[index]?.__vars?.[prop] ?? [];
    const cat = CATEGORY.find(([p]) => p.test(prop));
    return (cat ? vars.find((v) => cat[1].test(v)) : vars[0]) ?? null;
  };
  const style = [];
  const seenStyle = new Set();
  for (const s of SCREENS) {
    for (const [state, rows] of Object.entries(ev[s.id].compare.states)) {
      for (const r of rows.style) {
        const key = `${s.id}|${r.elementClass}|${r.property}|${r.design}|${r.app}`;
        if (seenStyle.has(key)) continue;
        seenStyle.add(key);
        const tokenRow = rows.tokens.find((t) => t.elementClass === r.elementClass && t.index === r.index && t.property === r.property);
        const fIds = ids(r);
        style.push({
          elementClass: `${s.name} · ${r.elementClass}`,
          selector: r.selector,
          property: r.property,
          figma: r.design,
          token: designToken(s.id, state, r.elementClass, r.index, r.property) ?? tokenRow?.expectedToken ?? null,
          computed: r.app,
          sourceValue: r.result === 'FAIL' ? r.app : null,
          result: r.result === 'FAIL' && findings.find((f) => f.id === fIds[0])?.resolution === 'DATA' ? 'DATA' : r.result,
          findingIds: fIds,
          _state: `${s.id}/${state}`,
        });
      }
    }
  }
  const component = [];
  const seenComp = new Map();
  for (const s of SCREENS) {
    for (const [state, rows] of Object.entries(ev[s.id].compare.states)) {
      for (const r of rows.components) {
        if (r.design?.source !== 'data-component') continue;
        const variant = r.design.variant ? `Variant=${r.design.variant[0].toUpperCase()}${r.design.variant.slice(1)}` : null;
        const actual = !r.app ? null : r.app.source === 'data-component' ? r.app.component : `${r.selector} (hand-built)`;
        const fIds = ids(r);
        const key = r.result === 'PASS' ? `PASS|${r.design.component}|${variant}` : `${s.id}|${r.design.component}|${variant}`;
        if (seenComp.has(key)) {
          const prev = seenComp.get(key);
          if (!prev._screens.includes(s.id)) prev._screens.push(s.id);
          continue;
        }
        const entry = { figmaComponent: r.design.component, variant, expectedComponent: r.design.component, actualComponent: actual, result: r.result, findingIds: fIds, _screens: [s.id] };
        seenComp.set(key, entry);
        component.push(entry);
      }
    }
  }
  // Link the PASS findings that vouch for components.
  for (const c of component) {
    if (c.result !== 'PASS') continue;
    if (c.figmaComponent === 'Card' || (c.figmaComponent === 'Button' && c.variant === 'Variant=Primary')) c.findingIds = [fid('Order summary uses')];
    if (['Stepper', 'Input', 'RadioCard'].includes(c.figmaComponent)) c.findingIds = [fid('Stepper, inputs')];
    if (c.figmaComponent === 'Alert') c.findingIds = [fid('Declined-card banner')];
    if (c.figmaComponent === 'EmptyState') c.findingIds = [fid('Empty cart matches')];
  }
  const motion = [];
  for (const s of SCREENS) {
    for (const [state, rows] of Object.entries(ev[s.id].compare.states)) {
      for (const r of rows.motion) {
        const fIds = ids(r);
        if (r.result === 'PASS' && /ads-toast-in/.test(r.expected?.detail ?? '')) fIds.push(fid('Receipt toast'));
        // One row per transition declaration: properties that share the same timing are merged
        // ("background-color, border-color"), as a Figma reaction lists them once.
        const prev = motion[motion.length - 1];
        const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
        if (prev && prev.state === `${s.id}/${state}` && prev.selector === r.selector && prev.trigger === r.trigger && prev.result === r.result
          && same({ ...prev.expected, detail: null }, { ...r.expected, detail: null }) && same(prev.observed && { ...prev.observed, detail: null }, r.observed && { ...r.observed, detail: null })) {
          prev.property = `${prev.property}, ${r.property}`;
          for (const id of fIds) if (!prev.findingIds.includes(id)) prev.findingIds.push(id);
          continue;
        }
        motion.push({ ...r, state: `${s.id}/${state}`, figmaNodeId: r.figmaNodeId ?? null, findingIds: fIds });
      }
    }
  }
  const stateLedger = stateMatrix.map((r) => ({ state: r.state, result: r.result, findingIds: r.findings }));
  const P1 = (order, label) => ({ present: true, order, label });
  const ABSENT = { present: false, order: null, label: null };
  const structure = [
    { region: 'Cart · Page header', figma: P1(1, 'Your cart · 3 items · Ships in 2–3 business days'), app: P1(1, 'Your cart · 3 items · Ships in 2–3 business days'), result: 'PASS', findingIds: [] },
    { region: 'Cart · Line items', figma: P1(2, 'Thumbnail · Name · Variant · Badge · Quantity · Price · Remove'), app: P1(2, 'Thumbnail · Name · Variant · pill · Quantity · Price · Remove'), result: 'FAIL', findingIds: [fid('Stock status')] },
    { region: 'Cart · Order summary', figma: P1(3, 'Order summary · Subtotal · Shipping · Estimated tax · Total · Go to checkout'), app: P1(3, 'Order summary · Subtotal · Shipping · Estimated tax · Total · Go to checkout'), result: 'PASS', findingIds: [fid('Order summary uses')] },
    { region: 'Cart · Empty state', figma: P1(1, 'Your cart is empty · Continue shopping'), app: P1(1, 'Your cart is empty · Continue shopping'), result: 'PASS', findingIds: [fid('Empty cart matches')] },
    { region: 'Shipping · Contact and address', figma: P1(1, 'Full name · Email · Street address · City · Postcode · Country'), app: P1(1, 'Full name · Email · Street address · City · Postcode · Country'), result: 'PASS', findingIds: [] },
    { region: 'Shipping · Delivery method', figma: P1(2, 'Standard (Free) · Express (€9.90)'), app: P1(2, 'Standard (Free) · Express (€9.90)'), result: 'PASS', findingIds: [] },
    { region: 'Shipping · Actions', figma: P1(3, 'Back to cart · Continue to payment'), app: P1(3, 'Back to cart · Continue to payment'), result: 'PASS', findingIds: [] },
    { region: 'Payment · Card details', figma: P1(1, 'Name on card · Card number · Expiry · CVC · Your payment is encrypted and secure.'), app: P1(1, 'Cardholder name · Card number · Expiry · CVC · Payments are processed by Stripe…'), result: 'FAIL', findingIds: [fid('Card name field'), fid('Security note')] },
    { region: 'Payment · Declined-card alert', figma: P1(1, 'Your card was declined · Try another card…'), app: P1(1, 'Your card was declined · Try another card… · Try again'), result: 'FAIL', findingIds: [fid('App renders an extra')] },
    { region: 'Payment · Actions', figma: P1(3, 'Back to shipping · Pay €248.40'), app: P1(3, 'Back to shipping · Pay €248.40'), result: 'PASS', findingIds: [] },
    { region: 'Review · Order details', figma: P1(1, 'Ship to · Delivery · Payment'), app: P1(1, 'Ship to · Delivery · Payment'), result: 'PASS', findingIds: [fid('Ship to, Delivery')] },
    { region: 'Review · Items in this order', figma: P1(2, 'Items in this order · 3 lines'), app: ABSENT, result: 'FAIL', findingIds: [fid('Review page does not')] },
    { region: 'Review · Order summary', figma: P1(3, 'Promo code · Subtotal · Shipping · Estimated tax · Total · Place order'), app: P1(2, 'Promo code · Subtotal · Shipping · Estimated tax · Total · Place order'), result: 'PASS', findingIds: [] },
    { region: 'Confirmation · Heading', figma: P1(1, 'Thanks, Dana! Your order is confirmed'), app: P1(1, 'Thank you, your order is confirmed'), result: 'FAIL', findingIds: [fid('Confirmation heading')] },
    { region: 'Confirmation · Order line', figma: P1(2, 'Order #AC-10482 · A confirmation is on its way…'), app: P1(2, 'Order #AC-10517 · A confirmation is on its way…'), result: 'DATA', findingIds: [fid('Order number differs')] },
    { region: 'Confirmation · Actions and toast', figma: P1(3, 'Track order · Continue shopping · Receipt toast'), app: P1(3, 'Track order · Continue shopping · Receipt toast'), result: 'PASS', findingIds: [fid('Receipt toast')] },
  ];
  const behavior = [
    { state: 'cart/empty', trigger: 'Cart has no items (?empty=1)', expected: "EmptyState with a 'Continue shopping' button", observed: "EmptyState with 'Continue shopping'", acRef: 'AC-2', result: 'PASS', findingIds: [fid('Empty cart matches')] },
    { state: 'shipping/hover', trigger: 'Pointer over Continue to payment', expected: 'Background eases to --ads-color-brand-hover over 160ms', observed: 'Background switches to #4338CA instantly', acRef: null, result: 'FAIL', findingIds: [fid('Continue to payment has no')] },
    { state: 'payment/with-data', trigger: 'Tab to the card number field', expected: 'Input focus ring (2px --ads-color-brand)', observed: 'Not captured: no focus driver', acRef: 'AC-4', result: 'CANNOT_VERIFY', findingIds: [fid('Card number focus')] },
    { state: 'payment/error', trigger: 'Payment API returns card_declined (?error=1)', expected: 'Alert (danger) above the card fields; the customer corrects the card and presses Pay again', observed: 'Alert (danger) with an extra Try again button', acRef: 'AC-5', result: 'FAIL', findingIds: [fid('App renders an extra')] },
    { state: 'review/promo-applied', trigger: 'Enter SPRING10 and press Apply', expected: 'Promo row with the SPRING10 badge and total €225.50', observed: 'Nothing happens; the total stays €248.40', acRef: 'AC-7', result: 'FAIL', findingIds: [fid('Promo-applied state')] },
    { state: 'confirmation/with-data', trigger: 'Order placed', expected: 'Success icon pops in (320ms ease-out), receipt toast slides in (240ms ease-out)', observed: 'Icon pops in over 600ms linear; toast as designed', acRef: 'AC-8', result: 'FAIL', findingIds: [fid('Confirmation check'), fid('Receipt toast')] },
  ];

  // ---- Report -------------------------------------------------------------------------
  const pixelDiff = {};
  for (const s of SCREENS) {
    for (const [state, d] of Object.entries(ev[s.id].diff)) {
      pixelDiff[`${s.id}/${state}`] = { percent: d.percent, band: d.band, structuralPercent: d.structuralPercent, structuralBand: d.structuralBand, image: P(s.id, 'diff', state) };
      // The compared heights and any padding, when diff.mjs recorded them (validate.mjs checks a long frame was compared in full).
      for (const k of ['designHeight', 'appHeight', 'padded', 'designWidth', 'appWidth', 'paddedRight']) if (d[k] !== undefined) pixelDiff[`${s.id}/${state}`][k] = d[k];
    }
  }
  const evidenceStates = {};
  for (const st of stateMatrix) {
    const [screen, state] = st.state.split('/');
    const hasApp = !!st.captured.app;
    evidenceStates[st.state] = {
      design: st.captured.design,
      app: st.captured.app,
      diff: st.captured.diff,
      computed: hasApp ? P(screen, 'computed', state, 'json') : null,
      dom: hasApp ? P(screen, 'dom', state, 'json') : null,
      motion: hasApp ? P(screen, 'motion', state, 'json') : null,
    };
  }
  const ticket = {
    provider: 'jira', key: TICKET.key, url: TICKET.url, title: TICKET.title, status: 'In review',
    links: { figma: FIGMA_URL('2140:118'), pullRequest: 'https://github.com/acme/storefront/pull/2318' },
    acceptanceCriteria: Object.entries(AC).map(([id, text]) => ({ id, text })),
  };
  writeFileSync(path.join(EVIDENCE, 'ticket.json'), JSON.stringify(ticket, null, 2) + '\n');

  const report = {
    schemaVersion: '2.0',
    meta: {
      feature: 'Checkout v3',
      generatedAt: GENERATED_AT,
      skillVersion: '0.2.0',
      mode: 'audit',
      source: { kind: 'figma', url: FIGMA_URL('2140:118'), label: 'Checkout v3 (Figma)', tool: null, frame: { width: W, height: H } },
      screens: SCREENS.map((s) => ({ id: s.id, name: s.name, designRef: s.node, appRoute: `/checkout/${s.id}`, frame: { width: W, height: H } })),
      ticket: TICKET,
      figma: { fileKey: FIGMA_FILE, nodeId: '2140:118', url: FIGMA_URL('2140:118'), frame: { width: W, height: H } },
      app: { url: `${BASE}/checkout/cart`, kind: 'local', route: '/checkout/cart', commit: 'b7e41c9a20f3d58e6c1a4f07d92e3b18c5a6f2d4', branch: 'feat/checkout-v3', viewport: { width: W, height: H }, dpr: 1 },
      fixture: 'fixtures/checkout/three-items.json',
      tools: { figmaAccess: 'rest', capture: 'script', prototypeCapture: null, ticket: 'rest' },
      degradations: [
        { step: 'capture:payment/focus', reason: 'No focus driver for the card number field (surfaces.checkout.screens.payment.states.focus is not defined).', impact: 'The Input focus ring is reported as CANNOT_VERIFY (DQ-014).' },
        { step: 'pixel diff:review/promo-applied', reason: 'The promo-applied state is not implemented, so there is no app capture.', impact: 'No pixel diff for review/promo-applied; reported as MISSING_IN_CODE (DQ-017).' },
      ],
    },
    scorecard: { pixelDiff },
    stateMatrix,
    findings,
    ledgers: { structure, component, style, state: stateLedger, behavior, motion },
    openDecisions: [
      {
        id: 'OD-1',
        question: 'Payment security note: the app names the payment processor (“Payments are processed by Stripe. We never store your card details.”); the design says “Your payment is encrypted and secure.” Which ships?',
        options: [
          { label: 'Restore the designed copy (fix code)', consequence: 'Matches the frame; the processor disclosure added for CHK-198 disappears from the payment step.' },
          { label: 'Keep the processor disclosure (sign off as intentional)', consequence: 'The app keeps the Stripe sentence; DQ-012 is recorded as an accepted divergence with Legal as the approver.' },
        ],
        recommendation: 'Ask Legal whether CHK-198 requires the processor name on this step. If it does, sign DQ-012 off as intentional; otherwise restore the designed copy.',
        relatedFindings: [fid('Security note')],
      },
    ],
    fixLoop: [],
    evidence: {
      figmaSpec: null,
      ticket: 'evidence/ticket.json',
      capture: 'evidence/screens/cart/capture.json',
      prototypeCapture: null,
      compare: 'evidence/screens/cart/compare.json',
      states: evidenceStates,
    },
  };
  report.scorecard = computeScorecard(report);
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${path.relative(ROOT, REPORT)}: ${findings.length} findings, ${stateMatrix.length} states`);

  // ---- Step 2: design backfill, through backfill.mjs ---------------------------------
  const R = ['--report', REPORT, '--quiet'];
  await node('backfill.mjs', [...R, '--add', 'processing', '--screen', 'payment', '--label', 'Processing payment',
    '--detail', 'src/features/payment/PayButton.tsx:31 swaps the label for a spinner and “Processing payment…” and dims the card fields while confirmPayment() is pending',
    '--driver', JSON.stringify({ query: '?processing=1' })]);
  await node('backfill.mjs', [...R, '--add', 'item-removed', '--screen', 'cart', '--label', 'Item removed (undo toast)',
    '--detail', 'src/features/cart/useRemoveItem.ts:22 removes the line and shows <Toast> “… removed from your cart” with Undo for 6 s',
    '--driver', JSON.stringify({ query: '?removed=1' })]);
  await node('backfill.mjs', [...R, '--add', 'saving-address', '--screen', 'shipping', '--label', 'Saving address',
    '--detail', 'src/features/shipping/ShippingForm.tsx:88 puts Continue to payment in the Button loading variant while the address is validated']);
  await node('backfill.mjs', [...R, '--captured', path.join(EVIDENCE, 'backfill/payment/capture.json'), '--screen', 'payment']);
  await node('backfill.mjs', [...R, '--captured', path.join(EVIDENCE, 'backfill/cart/capture.json'), '--screen', 'cart']);
  await node('backfill.mjs', [...R, '--build', 'BF-001', '--by', REVIEWER]);
  await node('backfill.mjs', [...R, '--not-needed', 'BF-003', '--by', REVIEWER, '--reason', 'Transient (under 300 ms on the address API): the DS Button loading variant already specifies it, so a separate Shipping frame adds nothing.']);

  const withBackfill = load(REPORT);
  const extra = {
    'BF-001': {
      anchor: { nodeId: '2140:690', name: 'Payment / With data' },
      components: [
        { name: 'Button', variant: 'Primary, Loading', selector: '[data-testid=primary-cta]', inLibrary: true },
        { name: 'Input', variant: 'Disabled', selector: '[data-testid=field-control]', inLibrary: true },
      ],
      tokens: ['--ads-color-brand', '--ads-color-surface-muted', '--ads-color-text-muted', '--ads-radius-md'],
      decidedAt: '2026-10-03T10:12:00Z',
    },
    'BF-002': {
      anchor: { nodeId: '2140:120', name: 'Cart / With data' },
      components: [
        { name: 'Toast', variant: 'Inverse, With action', selector: '[data-component=Toast]', inLibrary: true },
        { name: 'Link', variant: 'On dark', selector: '[data-component=Toast] a', inLibrary: false },
      ],
      tokens: ['--ads-color-inverse-bg', '--ads-color-inverse-fg', '--ads-radius-md', '--ads-shadow-toast'],
      dsGaps: ['Link variant for inverse surfaces (the app hardcodes #A5B4FC)'],
    },
    'BF-003': {
      anchor: { nodeId: '2140:410', name: 'Shipping / With data' },
      components: [{ name: 'Button', variant: 'Primary, Loading', selector: '[data-testid=primary-cta]', inLibrary: true }],
      tokens: ['--ads-color-brand'],
      decidedAt: '2026-10-03T10:12:00Z',
    },
  };
  for (const item of withBackfill.backfill.items) Object.assign(item, extra[item.id] ?? {});
  writeFileSync(REPORT, JSON.stringify(withBackfill, null, 2) + '\n');

  // ---- Render and validate -----------------------------------------------------------
  const out = (f) => path.join(HERE, f);
  await node('render-report.mjs', ['--in', REPORT, '--out', out('report.html'), '--fixplan', out('report-fixplan.md'), '--backfill-plan', out('report-backfill.md'), '--embed-images', '--recompute', '--write-back']);
  // This mock assembles report.json here instead of through build-report.mjs (see the README), so it has no
  // meta.build and validate.mjs refuses it for that alone. Every other rule, evidence gates included, must hold.
  const v = await node('validate.mjs', [REPORT, '--json'], { allow: [0, 1] });
  const res = JSON.parse(v.stdout);
  const other = res.errors.filter((e) => e.path !== 'meta.build');
  for (const e of [...res.errors, ...res.warnings]) log(`${res.errors.includes(e) ? 'ERROR' : 'WARN '} ${e.path}: ${e.message}`);
  if (other.length || res.warnings.length || res.errors.length !== 1) throw new Error('validate.mjs reported errors or warnings beyond the missing build record');
  log('not built by build-report.mjs: validate.mjs refuses this mock for its missing meta.build only (every other rule holds)');
  const final = load(REPORT);
  const sc = final.scorecard;
  log(`${scorecardHeadline(sc)} · ${JSON.stringify(sc.bySeverity)} · ${JSON.stringify(sc.byResolution)} · designSystem ${JSON.stringify(sc.designSystem)} · backfill ${JSON.stringify(sc.backfill)}`);
}
