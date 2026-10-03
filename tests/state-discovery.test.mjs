import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildFigmaSpec, siblingFrames } from '../skills/design-qa/scripts/lib/figma-spec.mjs';
import { validateStateMatrix } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { deriveVerdict } from '../skills/design-qa/scripts/lib/ranking.mjs';
import {
  SYNONYMS,
  buildStateMatrix,
  describeDriver,
  designedStates,
  discoverConfigStates,
  discoverFigmaStates,
  discoverTicketStates,
  discoverUndesigned,
  matchStateSynonym,
  normalizeStateName,
  stateFromName,
} from '../skills/design-qa/scripts/lib/state-discovery.mjs';
import { loadFixture, run, script, tmpDir, fixture } from './_helpers.mjs';

const spec = () =>
  buildFigmaSpec({
    fileKey: 'AbCdEf123456',
    nodeId: '1:2',
    url: 'https://www.figma.com/design/AbCdEf123456/Items?node-id=1-2',
    response: loadFixture('figma-nodes.json'),
    siblings: siblingFrames(loadFixture('figma-file-depth2.json'), '1:2'),
    now: new Date('2026-09-23T00:00:00Z'),
  });

test('SYNONYMS map the documented phrases', () => {
  const expected = {
    'no results': 'empty', 'nothing here': 'empty', 'zero state': 'empty', blank: 'empty',
    skeleton: 'loading', spinner: 'loading', fetching: 'loading', pending: 'loading',
    failure: 'error', failed: 'error', offline: 'error', unavailable: 'error',
    pressed: 'active', focused: 'focus', 'focus-visible': 'focus', 'keyboard focus': 'focus',
    default: 'with-data', filled: 'with-data', populated: 'with-data', data: 'with-data', 'with data': 'with-data', loaded: 'with-data',
    disabled: 'disabled', inactive: 'disabled', selected: 'selected', checked: 'selected', current: 'selected', 'active tab': 'selected',
    hover: 'hover', hovered: 'hover', mouseover: 'hover', expanded: 'expanded', open: 'expanded', collapsed: 'collapsed', closed: 'collapsed',
    success: 'success', done: 'success', complete: 'success',
  };
  for (const [phrase, state] of Object.entries(expected)) assert.equal(SYNONYMS[phrase], state, phrase);
});

test('normalizeStateName and stateFromName', () => {
  const cases = {
    Empty: 'empty', 'Empty state': 'empty', 'Items / Empty': 'empty', 'Items – Loading': 'loading', 'Items (error)': 'error',
    'State=Hover': 'hover', 'Focus Visible': 'focus', 'Active tab': 'selected', Pressed: 'active', 'No results': 'empty',
    with_data: 'with-data', 'with-data': 'with-data', 'Something custom': 'something-custom',
  };
  for (const [name, state] of Object.entries(cases)) assert.equal(normalizeStateName(name), state, name);
  assert.equal(stateFromName('Open orders section'), null, 'names only count when a segment is a state label');
  assert.equal(stateFromName('Data table'), null);
  assert.equal(normalizeStateName(''), null);
});

test('matchStateSynonym scans prose, ignoring words too common to trust', () => {
  assert.equal(matchStateSynonym('When the request fails, show an error'), 'error');
  assert.equal(matchStateSynonym('Show a skeleton while loading'), 'loading');
  assert.equal(matchStateSynonym('Show the current user items'), null);
  assert.equal(matchStateSynonym('The list shows data'), null);
  assert.equal(matchStateSynonym('If there are no results, show an empty state'), 'empty');
  assert.equal(matchStateSynonym('The active tab is underlined'), 'selected');
});

test('buildFigmaSpec flattens layers with paths, styles, components and variants', () => {
  const s = spec();
  assert.equal(s.name, 'Items');
  assert.deepEqual(s.frame, { width: 800, height: 600 });
  assert.equal(s.fileName, 'Items (Design)');
  const byId = Object.fromEntries(s.layers.map((l) => [l.id, l]));
  assert.equal(byId['1:2'].depth, 0);
  assert.equal(byId['1:4'].path, 'Items/Header/Title');
  assert.equal(byId['1:4'].depth, 2);
  assert.deepEqual(byId['1:4'].style, { fontFamily: 'Inter', fontSize: 24, fontWeight: 700, lineHeightPx: 32, letterSpacing: 0, textAlignHorizontal: 'LEFT' });
  assert.equal(byId['1:4'].characters, 'Items');
  assert.ok(byId['1:4'].boundVariables);
  assert.equal(byId['1:10'].componentName, 'Row');
  assert.deepEqual(byId['1:10'].variantProperties, { State: 'Default' });
  assert.equal(byId['1:20'].visible, false);
  assert.equal(byId['1:3'].paddingLeft, 24);
  assert.equal(s.styles['S:1'].name, 'Heading/XL');
  assert.deepEqual(s.siblings.map((x) => x.name), ['Items – Error', 'Settings – Empty']);
});

test('discoverFigmaStates: frame names, variants, reactions, annotations, siblings', () => {
  const states = spec().states;
  assert.deepEqual(states, [
    { state: 'with-data', nodeId: '1:2', name: 'Items', source: 'frame-name' },
    { state: 'empty', nodeId: '1:20', name: 'Empty state', source: 'frame-name' },
    { state: 'loading', nodeId: '1:31', name: 'Loading skeleton', source: 'reaction' },
    { state: 'error', nodeId: '1:50', name: 'Items – Error', source: 'frame-name' },
    { state: 'hover', nodeId: '1:10', name: 'Row', source: 'reaction' },
  ]);
  // Without the sibling frame, the annotation provides the error state; a navigating
  // click is not a "selected" state; "Settings – Empty" is another family.
  const noSiblings = discoverFigmaStates({ ...spec(), siblings: [] });
  assert.deepEqual(noSiblings.find((x) => x.state === 'error'), { state: 'error', nodeId: '1:40', name: 'Error banner', source: 'annotation' });
  assert.equal(noSiblings.some((x) => x.state === 'selected'), false);
});

test('discoverFigmaStates: a component set contributes its variants, not itself', () => {
  const set = {
    layers: [
      { id: '5:0', name: 'Button', type: 'COMPONENT_SET', depth: 0 },
      { id: '5:1', name: 'State=Default, Size=M', type: 'COMPONENT', depth: 1, variantProperties: { State: 'Default', Size: 'M' } },
      { id: '5:2', name: 'State=Hover, Size=M', type: 'COMPONENT', depth: 1, variantProperties: { State: 'Hover', Size: 'M' } },
      { id: '5:3', name: 'State=Disabled, Size=M', type: 'COMPONENT', depth: 1, variantProperties: { State: 'Disabled', Size: 'M' } },
      { id: '5:4', name: 'Status=Focus visible', type: 'COMPONENT', depth: 1, variantProperties: { Status: 'Focus visible' } },
    ],
  };
  assert.deepEqual(
    discoverFigmaStates(set).map((s) => [s.state, s.nodeId, s.source]),
    [['with-data', '5:1', 'variant'], ['hover', '5:2', 'variant'], ['focus', '5:4', 'variant'], ['disabled', '5:3', 'variant']],
  );
});

test('discoverTicketStates maps criteria to states; the first plain criterion is with-data', () => {
  const ticket = {
    acceptanceCriteria: ['Shows one row per item', 'When there are no items, show an empty state', 'Show a skeleton while loading'],
  };
  assert.deepEqual(discoverTicketStates(ticket), [
    { state: 'with-data', acRef: 'AC-1', text: 'Shows one row per item' },
    { state: 'empty', acRef: 'AC-2', text: 'When there are no items, show an empty state' },
    { state: 'loading', acRef: 'AC-3', text: 'Show a skeleton while loading' },
  ]);
  const withBehaviors = { expectedBehaviors: [{ acRef: 'AC-4', text: 'On hover highlight', state: 'hover', trigger: 'hover' }] };
  assert.deepEqual(discoverTicketStates(withBehaviors), [{ state: 'hover', acRef: 'AC-4', text: 'On hover highlight' }]);
  assert.deepEqual(discoverTicketStates(null), []);
});

test('discoverConfigStates: driver kinds, implicit with-data, empty drivers are "source"', () => {
  const states = discoverConfigStates(loadFixture('config.json'), 'items');
  const byState = Object.fromEntries(states.map((s) => [s.state, s]));
  assert.deepEqual(states.map((s) => s.state), ['with-data', 'empty', 'loading', 'error', 'hover', 'disabled']);
  assert.equal(byState['with-data'].driver, 'fixture');
  assert.equal(byState.empty.driver, 'mock');
  assert.equal(byState.empty.detail, 'mock **/api/items* → 200 []; fixture none');
  assert.equal(byState.loading.detail, 'mock **/api/items* (delay 30000 ms); fixture three-items');
  assert.equal(byState.hover.driver, 'action');
  assert.equal(byState.disabled.driver, 'query');
  assert.equal(byState.error.driver, 'source');
  const bare = discoverConfigStates({ surfaces: { x: { route: '/x', states: {} } } }, 'x');
  assert.deepEqual(bare, [{ state: 'with-data', key: null, driver: 'fixture', detail: 'default render of /x' }]);
  assert.equal(describeDriver({ action: 'keyboard', keys: 'Tab Tab' }), 'keyboard [Tab Tab]');
  assert.equal(describeDriver({}), 'default render');
});

test('buildStateMatrix: one row per designed state; provisional results follow the rule table', () => {
  const figmaSpec = {
    states: [
      { state: 'with-data', nodeId: '1:2', name: 'Items', source: 'frame-name' },
      { state: 'empty', nodeId: '1:20', name: 'Empty', source: 'frame-name' },
      { state: 'error', nodeId: '1:40', name: 'Error', source: 'frame-name' },
      { state: 'hover', nodeId: '1:10', name: 'Row', source: 'reaction' },
      { state: 'selected', nodeId: '1:11', name: 'Row selected', source: 'variant' },
    ],
  };
  const ticket = {
    acceptanceCriteria: [
      'Shows one row per item',
      'When there are no items, show an empty state',
      'Rows show a focus ring on keyboard focus',
      'Show a skeleton while the list is loading',
      'Show a success toast after saving',
      'Selected rows are highlighted',
    ],
  };
  const config = {
    surfaces: {
      items: {
        route: '/items',
        states: {
          empty: { mock: { urlPattern: '**/api/items', body: [] } },
          error: { source: 'src/Items.tsx:88' },
          hover: { action: 'hover', selector: '.row' },
          disabled: { query: 'readonly=1' },
          loading: { mock: { urlPattern: '**/api/items', delayMs: 30000 } },
          'toast-success': { source: 'src/Toast.tsx:12' },
        },
      },
    },
  };
  const rows = buildStateMatrix({ figmaSpec, ticket, config, surface: 'items' });
  const byState = Object.fromEntries(rows.map((r) => [r.state, r]));
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.state, r.result])),
    {
      'with-data': 'CANNOT_VERIFY', // designed + runtime driver (+ AC-1): pending capture
      empty: 'CANNOT_VERIFY', // designed + mock + AC-2: pending capture
      error: 'CANNOT_VERIFY', // designed, "source" only
      hover: 'CANNOT_VERIFY', // designed + action, not in the ticket: still pending capture
      selected: 'MISSING_IN_CODE', // designed (and AC-6) but not implemented
    },
    'loading (ticket + mock), focus (ticket only), success (ticket + source) and disabled (code only) have no design: not rows',
  );
  assert.equal(byState['with-data'].note, 'Pending capture; compare replaces this with PASS/FAIL.');
  assert.equal(byState.hover.note, 'Pending capture; compare replaces this with PASS/FAIL. Not in the ticket.');
  assert.equal(byState.hover.specified, null);
  assert.match(byState.error.note, /nothing can drive it at runtime: add a fixture, query, mock, storage or action driver at surfaces\.items\.states\.error\.$/);
  assert.match(byState.selected.note, /^Designed \(Row selected\) and specified in AC-6 but not implemented: if the code has it, add a driver at surfaces\.items\.states\.selected/);
  assert.ok(rows.every((r) => r.designed), 'every row is designed');
  assert.ok(!rows.some((r) => /decision for design|design does not/.test(r.note)), 'notes never point back at the design');
  assert.deepEqual(byState.selected.designed, { nodeId: '1:11', name: 'Row selected' });
  assert.deepEqual(byState.empty.specified, { acRef: 'AC-2', text: 'When there are no items, show an empty state' });
  assert.ok(!rows.some((r) => r.result === 'NOT_SPECIFIED'), 'NOT_SPECIFIED is never a provisional result');
  for (const r of rows) {
    assert.equal(r.captured, null);
    assert.deepEqual(r.findings, []);
  }
  assert.deepEqual(validateStateMatrix(rows).errors, []);
});

test('buildStateMatrix: states only in the ticket or only in code are not rows', () => {
  const ticket = { expectedBehaviors: [{ acRef: 'AC-2', text: 'Show an empty state', state: 'empty' }] };
  const config = { surfaces: { items: { route: '/items', states: { disabled: { query: 'readonly=1' }, loading: { source: 'src/Items.tsx:12' } } } } };
  assert.deepEqual(buildStateMatrix({ ticket }), [], 'no design: no rows');
  assert.deepEqual(buildStateMatrix({ ticket, config, surface: 'items' }), []);
  const rows = buildStateMatrix({ figmaSpec: { nodeId: '1:2', name: 'Items', states: [] }, ticket, config, surface: 'items' });
  assert.deepEqual(rows.map((r) => [r.state, r.result]), [['with-data', 'CANNOT_VERIFY']]);
  assert.equal(deriveVerdict({ findings: [], stateMatrix: rows, openDecisions: [], scorecard: { pixelDiff: {} } }), 'REVIEW', 'pending capture only');
  assert.ok(!JSON.stringify(rows).includes('MISSING_IN_DESIGN'));
});

test('buildStateMatrix: a designed state missing in code fails the verdict', () => {
  const rows = buildStateMatrix({ figmaSpec: { nodeId: '1:2', name: 'Items', states: [{ state: 'empty', nodeId: '1:40', name: 'Items / Empty' }] } });
  assert.equal(rows.find((r) => r.state === 'empty').result, 'MISSING_IN_CODE');
  assert.equal(deriveVerdict({ findings: [], stateMatrix: rows, openDecisions: [], scorecard: { pixelDiff: {} } }), 'FAIL');
});

test('buildStateMatrix: screen prefixes state ids for multi-screen passes', () => {
  const figmaSpec = { nodeId: '1:2', name: 'Cart', states: [{ state: 'empty', nodeId: '1:40', name: 'Cart / Empty' }] };
  const rows = buildStateMatrix({ figmaSpec, screen: 'cart' });
  assert.deepEqual(rows.map((r) => [r.state, r.screen, r.label]), [['cart/with-data', 'cart', 'With data'], ['cart/empty', 'cart', 'Empty']]);
  assert.deepEqual(Object.keys(rows[0]).slice(0, 3), ['state', 'screen', 'label']);
  assert.match(rows[1].note, /add a driver at surfaces\.<surface>\.states\.empty/, 'config hooks keep the plain state name');
  assert.deepEqual(validateStateMatrix(rows).errors, []);
  assert.equal('screen' in buildStateMatrix({ figmaSpec })[0], false, 'single-screen rows carry no screen');
});

test('buildStateMatrix: the main frame is the with-data design when figmaSpec.states does not cover it', () => {
  // Repro: a hand-written (MCP mode) spec with an empty states list.
  const figmaSpec = {
    nodeId: '1:2',
    name: 'Orders / With data',
    frame: { width: 1440, height: 900 },
    layers: [{ id: '1:2', name: 'Orders / With data', type: 'FRAME', path: 'Orders', depth: 0 }],
    states: [],
  };
  const rows = buildStateMatrix({ figmaSpec, ticket: { expectedBehaviors: [] }, config: null, surface: null });
  const withData = rows.find((r) => r.state === 'with-data');
  assert.deepEqual(withData.designed, { nodeId: '1:2', name: 'Orders / With data' });
  assert.equal(withData.result, 'CANNOT_VERIFY');
  assert.match(withData.note, /^Pending capture/);

  // Same without layers: nodeId/name alone identify the main frame.
  const bare = buildStateMatrix({ figmaSpec: { nodeId: '7:1', name: 'Orders', frame: { width: 1440, height: 900 }, states: [] } });
  assert.deepEqual(bare.find((r) => r.state === 'with-data').designed, { nodeId: '7:1', name: 'Orders' });

  // Listed states without with-data: the main frame still designs with-data.
  const partial = buildStateMatrix({
    figmaSpec: { nodeId: '1:2', name: 'Orders', states: [{ state: 'empty', nodeId: '1:40', name: 'Orders / Empty', source: 'frame-name' }] },
  });
  assert.deepEqual(partial.find((r) => r.state === 'with-data').designed, { nodeId: '1:2', name: 'Orders' });
  assert.deepEqual(partial.find((r) => r.state === 'empty').designed, { nodeId: '1:40', name: 'Orders / Empty' });
});

test('buildStateMatrix: the main frame designs the state its own name maps to, and never overrides listed states', () => {
  // "Orders / Empty" maps to empty: the main frame designs empty, not with-data.
  const emptyMain = buildStateMatrix({ figmaSpec: { nodeId: '1:2', name: 'Orders / Empty', states: [] } });
  assert.deepEqual(emptyMain.find((r) => r.state === 'empty').designed, { nodeId: '1:2', name: 'Orders / Empty' });
  assert.equal(emptyMain.find((r) => r.state === 'with-data'), undefined, 'with-data has no design, so it is not a row');

  // An explicit with-data entry wins over the main frame.
  const explicit = buildStateMatrix({ figmaSpec: { nodeId: '1:2', name: 'Orders', states: [{ state: 'Default', nodeId: '1:9', name: 'Row / Default' }] } });
  assert.deepEqual(explicit.find((r) => r.state === 'with-data').designed, { nodeId: '1:9', name: 'Row / Default' });

  // A main frame already assigned to another state is not reused for with-data.
  const assigned = buildStateMatrix({ figmaSpec: { nodeId: '1:2', name: 'Orders', states: [{ state: 'empty', nodeId: '1:2', name: 'Orders' }] } });
  assert.equal(assigned.find((r) => r.state === 'with-data'), undefined);
  assert.deepEqual(assigned.find((r) => r.state === 'empty').designed, { nodeId: '1:2', name: 'Orders' });

  // A component set is a library of variants, not a with-data design.
  const set = buildStateMatrix({ figmaSpec: { nodeId: '5:0', name: 'Button', type: 'COMPONENT_SET', states: [] } });
  assert.equal(set.find((r) => r.state === 'with-data'), undefined);

  assert.deepEqual(designedStates(null), []);
});

test('CLI: builds and writes a valid state matrix', async () => {
  const dir = tmpDir();
  const specFile = path.join(dir, 'figma-spec.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(specFile, JSON.stringify(spec()));
  const out = path.join(dir, 'state-matrix.json');
  const res = await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--config', fixture('config.json'), '--surface', 'items', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /with-data\s+–\s+fixture\s+CANNOT_VERIFY/);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(rows[0].state, 'with-data');
  assert.equal(rows.find((r) => r.state === 'loading').result, 'CANNOT_VERIFY');
  assert.equal(rows.find((r) => r.state === 'loading').note, 'Pending capture; compare replaces this with PASS/FAIL. Not in the ticket.');
  const v = await run(script('validate.mjs'), [out]);
  assert.equal(v.code, 0, v.stderr);
  assert.equal((await run(script('lib/state-discovery.mjs'), ['--out', out])).code, 2);
  const ticketOnly = await run(script('lib/state-discovery.mjs'), ['--ticket', fixture('config.json'), '--out', out]);
  assert.equal(ticketOnly.code, 2);
  assert.match(ticketOnly.stderr, /--figma-spec is required: the rows are the states the design defines/);
  const screened = path.join(dir, 'screen.json');
  const res2 = await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--screen', 'items', '--out', screened, '--quiet']);
  assert.equal(res2.code, 0, res2.stderr);
  assert.ok(JSON.parse(readFileSync(screened, 'utf8')).every((r) => r.state.startsWith('items/') && r.screen === 'items'));
  assert.equal((await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--screen', 'Items Page', '--out', screened])).code, 2);
  assert.equal((await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--config', fixture('config.json'), '--surface', 'nope', '--out', out])).code, 2);
});

test('discoverUndesigned: config and ticket states the design does not define; never matrix rows', () => {
  const ticket = {
    expectedBehaviors: [
      { acRef: 'AC-1', text: 'List the items', state: null },
      { acRef: 'AC-2', text: 'Show an empty state', state: 'empty' },
      { acRef: 'AC-7', text: 'Show a toast after saving', state: 'success' },
      { acRef: 'AC-8', text: 'Read-only users see a disabled list', state: 'disabled' },
    ],
  };
  const config = loadFixture('config.json');
  config.surfaces.items.states.selected = { source: 'src/Items.tsx:40' };
  const figmaSpec = spec();
  const candidates = discoverUndesigned({ figmaSpec, ticket, config, surface: 'items' });
  assert.deepEqual(candidates, [
    {
      state: 'selected',
      screen: null,
      label: 'Selected',
      discoveredBy: 'config',
      detail: 'config surfaces.items.states.selected: source src/Items.tsx:40 (no runtime driver)',
      driver: null,
    },
    {
      state: 'disabled',
      screen: null,
      label: 'Disabled',
      discoveredBy: 'config',
      detail: 'config surfaces.items.states.disabled: fixture three-items; query ?readonly=1; ticket AC-8: Read-only users see a disabled list',
      driver: { fixture: 'three-items', query: 'readonly=1' },
    },
    { state: 'success', screen: null, label: 'Success', discoveredBy: 'ticket', detail: 'ticket AC-7: Show a toast after saving', driver: null },
  ], 'canonical state order');
  const rows = buildStateMatrix({ figmaSpec, ticket, config, surface: 'items' });
  const rowStates = new Set(rows.map((r) => r.state));
  assert.ok(candidates.every((c) => !rowStates.has(c.state)), 'candidates and matrix rows never overlap');
  assert.ok(!rows.some((r) => ['disabled', 'success', 'selected'].includes(r.state)), 'the matrix stays designed-only');
  assert.equal(candidates.find((c) => c.state === 'disabled').driver === config.surfaces.items.states.disabled, false, 'drivers are copies');

  const screened = discoverUndesigned({ figmaSpec, ticket, config, surface: 'items', screen: 'items' });
  assert.ok(screened.every((c) => c.state.startsWith('items/') && c.screen === 'items'));
  assert.deepEqual(discoverUndesigned({ figmaSpec }), [], 'nothing beyond the design: no candidates');
  // An undrivable empty config entry is listed without a driver; with-data with an empty driver is the default render.
  const empty = discoverUndesigned({ figmaSpec: { nodeId: '1:2', name: 'Items / Empty', states: [] }, config: { surfaces: { a: { states: { 'with-data': {}, toast: {} } } } } });
  assert.deepEqual(empty.map((c) => [c.state, c.detail, c.driver]), [['toast', 'config surfaces.a.states.toast: listed without a runtime driver', null]]);
});

test('CLI --backfill-out writes backfill-candidates.json beside (or instead of) the matrix', async () => {
  const dir = tmpDir();
  const { writeFileSync } = await import('node:fs');
  const specFile = path.join(dir, 'figma-spec.json');
  writeFileSync(specFile, JSON.stringify(spec()));
  const ticketFile = path.join(dir, 'ticket.json');
  writeFileSync(ticketFile, JSON.stringify({ expectedBehaviors: [{ acRef: 'AC-7', text: 'Show a toast after saving', state: 'success' }] }));
  const out = path.join(dir, 'state-matrix.json');
  const bf = path.join(dir, 'backfill-candidates.json');
  const res = await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--ticket', ticketFile, '--config', fixture('config.json'), '--surface', 'items', '--out', out, '--backfill-out', bf]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Wrote .*backfill-candidates\.json \(2 undesigned state\(s\) — design backfill, step 2, after parity; not in the matrix\)/);
  const data = JSON.parse(readFileSync(bf, 'utf8'));
  assert.deepEqual(Object.keys(data), ['generatedAt', 'surface', 'candidates']);
  assert.equal(data.surface, 'items');
  assert.deepEqual(data.candidates.map((c) => [c.state, c.discoveredBy]), [['disabled', 'config'], ['success', 'ticket']]);
  const rows = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(!rows.some((r) => ['disabled', 'success'].includes(r.state)));

  const only = path.join(dir, 'only.json');
  const res2 = await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile, '--backfill-out', only, '--quiet']);
  assert.equal(res2.code, 0, res2.stderr);
  assert.deepEqual(JSON.parse(readFileSync(only, 'utf8')).candidates, []);
  const none = await run(script('lib/state-discovery.mjs'), ['--figma-spec', specFile]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--out <state-matrix\.json> is required \(and\/or --backfill-out/);
});
