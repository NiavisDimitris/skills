import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeMotion,
  easingEqual,
  figmaEasingToCss,
  figmaMotionSpecs,
  motionMatches,
  normalizeEasing,
  parseDurationMs,
  propertyCompatible,
  splitCssList,
  springToCubicBezier,
} from '../skills/design-qa/scripts/lib/figma-motion.mjs';

test('durations normalise across s and ms', () => {
  assert.equal(parseDurationMs('0.2s'), 200);
  assert.equal(parseDurationMs('200ms'), 200);
  assert.equal(parseDurationMs(' .15s '), 150);
  assert.equal(parseDurationMs(120), 120);
  assert.equal(parseDurationMs('fast'), null);
  assert.equal(parseDurationMs(''), null);
  assert.deepEqual(splitCssList('opacity, transform'), ['opacity', 'transform']);
  assert.deepEqual(splitCssList('ease-out, cubic-bezier(0.2, 0, 0, 1)'), ['ease-out', 'cubic-bezier(0.2, 0, 0, 1)']);
});

test('easings normalise: keywords, cubic-bezier equivalents, Figma presets, steps', () => {
  assert.equal(normalizeEasing('ease-in'), 'cubic-bezier(0.42,0,1,1)');
  assert.equal(normalizeEasing('ease-out'), 'cubic-bezier(0,0,0.58,1)');
  assert.equal(normalizeEasing('cubic-bezier(0, 0, 0.58, 1)'), 'cubic-bezier(0,0,0.58,1)');
  assert.equal(normalizeEasing('ease'), 'cubic-bezier(0.25,0.1,0.25,1)');
  assert.equal(normalizeEasing('cubic-bezier(0,0,1,1)'), 'linear');
  assert.equal(normalizeEasing('LINEAR'), 'linear');
  assert.equal(normalizeEasing('EASE_IN_AND_OUT'), 'cubic-bezier(0.42,0,0.58,1)');
  assert.equal(normalizeEasing('step-end'), 'steps(1,end)');
  assert.equal(normalizeEasing('steps(4, jump-start)'), 'steps(4,start)');
  assert.equal(normalizeEasing(null), null);
  assert.ok(easingEqual('ease-out', 'cubic-bezier(0, 0, 0.58, 1)'));
  assert.ok(easingEqual('ease-in-out', 'cubic-bezier(0.42,0.01,0.58,1)'), 'within tolerance');
  assert.ok(!easingEqual('ease-in', 'ease-out'));
  assert.ok(easingEqual('linear', 'cubic-bezier(0,0,1,1)'));
});

test('figmaEasingToCss: presets, custom cubic-bezier and springs (approximate)', () => {
  assert.deepEqual(figmaEasingToCss({ type: 'EASE_OUT' }), { easing: 'cubic-bezier(0,0,0.58,1)', figmaEasing: 'EASE_OUT', approximate: false, detail: null });
  assert.equal(figmaEasingToCss({ type: 'EASE_OUT_BACK' }).easing, 'cubic-bezier(0.45,1.45,0.8,1)');
  const custom = figmaEasingToCss({ type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 } });
  assert.equal(custom.easing, 'cubic-bezier(0.2,0,0,1)');
  assert.equal(custom.approximate, false);
  const bouncy = figmaEasingToCss({ type: 'BOUNCY' });
  assert.equal(bouncy.approximate, true);
  assert.match(bouncy.easing, /^cubic-bezier\(0\.3,1\.\d+,0\.6,1\.\d+\)$/);
  assert.match(bouncy.detail, /spring bouncy .*approximated as cubic-bezier/);
  const gentle = figmaEasingToCss({ type: 'GENTLE' });
  const bouncyY = Number(bouncy.easing.split(',')[1]);
  const gentleY = Number(gentle.easing.split(',')[1]);
  assert.ok(bouncyY > gentleY, 'a bouncier spring overshoots more');
  const spring = figmaEasingToCss({ type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 1, stiffness: 100, damping: 30 } });
  assert.equal(spring.approximate, true);
  assert.equal(spring.easing, 'cubic-bezier(0.3,1,0.6,1)', 'over-damped: no overshoot');
  assert.ok(springToCubicBezier({ mass: 1, stiffness: 300, damping: 20 }).settleMs > 0);
});

test('figmaMotionSpecs: triggers, transitions, durations in seconds, instant changes', () => {
  const spec = {
    layers: [
      { id: '1:2', name: 'Screen', path: 'Screen', depth: 0 },
      {
        id: '1:10',
        name: 'Button',
        path: 'Screen/Button',
        depth: 1,
        reactions: [
          { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '5:2', navigation: 'CHANGE_TO', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.2 } }] },
          { trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: '5:3', navigation: 'CHANGE_TO', transition: { type: 'DISSOLVE', easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } }, duration: 0.15 } }] },
          { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '1:2', navigation: 'NAVIGATE', transition: null }] },
        ],
      },
      { id: '1:30', name: 'Toast', path: 'Screen/Toast', depth: 1, reactions: [{ trigger: { type: 'AFTER_TIMEOUT', timeout: 0.8 }, action: { type: 'NODE', destinationId: '1:31', navigation: 'NAVIGATE', transition: { type: 'MOVE_IN', direction: 'BOTTOM', easing: { type: 'GENTLE' }, duration: 0.4 } } }] },
      { id: '1:31', name: 'Toast shown', path: 'Screen/Toast shown', depth: 1 },
      { id: '1:40', name: 'Card', path: 'Screen/Card', depth: 1, reactions: [{ trigger: { type: 'MOUSE_ENTER' }, actions: [{ type: 'BACK' }] }] },
    ],
  };
  const motion = figmaMotionSpecs(spec);
  assert.equal(motion.length, 4, 'actions without a destination or transition are skipped');
  const [hover, press, click, timeout] = motion;
  assert.deepEqual(
    { trigger: hover.trigger, figmaTrigger: hover.figmaTrigger, type: hover.type, durationMs: hover.durationMs, easing: hover.easing, nodeId: hover.nodeId, destinationId: hover.destinationId, source: hover.source },
    { trigger: 'hover', figmaTrigger: 'ON_HOVER', type: 'smart-animate', durationMs: 200, easing: 'cubic-bezier(0,0,0.58,1)', nodeId: '1:10', destinationId: '5:2', source: 'figma-reaction' },
  );
  assert.equal(press.trigger, 'press');
  assert.equal(press.type, 'dissolve');
  assert.equal(press.property, 'opacity');
  assert.equal(press.easing, 'cubic-bezier(0.4,0,0.2,1)');
  assert.equal(click.trigger, 'click');
  assert.equal(click.type, 'instant');
  assert.equal(click.durationMs, 0);
  assert.equal(timeout.trigger, 'timeout');
  assert.equal(timeout.delayMs, 800);
  assert.equal(timeout.destinationName, 'Toast shown');
  assert.equal(timeout.direction, 'bottom');
  assert.equal(timeout.approximate, true);
  assert.match(timeout.detail, /spring gentle/);
  // Durations above 20 are read as milliseconds (legacy fields).
  const ms = figmaMotionSpecs({ layers: [{ id: '1', name: 'x', reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '2', transition: { type: 'DISSOLVE', duration: 300, easing: { type: 'LINEAR' } } }] }] }] });
  assert.equal(ms[0].durationMs, 300);
  assert.equal(ms[0].easing, 'linear');
  assert.deepEqual(figmaMotionSpecs(null), []);
});

test('motionMatches: missing motion, duration and easing differences, equivalent easings', () => {
  const expected = { type: 'transition', property: 'opacity', durationMs: 200, easing: 'ease-out', delayMs: 0 };
  const missing = motionMatches(expected, [{ type: 'transition', property: 'transform', durationMs: 200, easing: 'ease-out', delayMs: 0 }]);
  assert.equal(missing.result, 'FAIL');
  assert.equal(missing.observed, null);
  assert.match(missing.reasons[0], /missing motion: the app has no transition on opacity/);

  const same = motionMatches(expected, [{ type: 'transition', property: 'opacity', durationMs: 210, easing: 'cubic-bezier(0, 0, 0.58, 1)', delayMs: 0 }]);
  assert.equal(same.result, 'PASS', 'within 20 ms, equivalent easing');

  const slow = motionMatches(expected, [{ type: 'transition', property: 'all', durationMs: 400, easing: 'ease-in', delayMs: 0 }], { durationToleranceMs: 20 });
  assert.equal(slow.result, 'FAIL');
  assert.deepEqual(slow.reasons, ['duration 400ms, expected 200ms', 'easing cubic-bezier(0.42,0,1,1), expected cubic-bezier(0,0,0.58,1)']);

  const best = motionMatches(expected, [
    { type: 'transition', property: 'all', durationMs: 999, easing: 'linear', delayMs: 0 },
    { type: 'transition', property: 'opacity', durationMs: 200, easing: 'ease-out', delayMs: 0 },
  ]);
  assert.equal(best.result, 'PASS');
  assert.equal(best.observed.property, 'opacity', 'the closest candidate wins');

  const anim = { type: 'animation', property: 'animation', name: 'spin', durationMs: 800, easing: 'linear', delayMs: 0, iterations: 'infinite' };
  assert.equal(motionMatches(anim, [{ type: 'transition', property: 'all', durationMs: 800 }]).observed, null, 'a transition is not an animation');
  assert.match(motionMatches(anim, [{ ...anim, iterations: '1' }]).reasons[0], /iterations 1, expected infinite/);
  assert.equal(motionMatches({ type: 'smart-animate', property: null, durationMs: 300, easing: null }, [{ type: 'animation', property: 'animation', durationMs: 300 }]).result, 'PASS', 'Figma motion with no property accepts any motion');

  assert.ok(propertyCompatible({ property: 'background' }, { type: 'transition', property: 'background-color' }));
  assert.ok(propertyCompatible({ property: 'border-color' }, { type: 'transition', property: 'border-top-color' }));
  assert.ok(!propertyCompatible({ property: 'opacity' }, { type: 'transition', property: 'color' }));

  assert.equal(describeMotion({ type: 'transition', property: 'opacity', durationMs: 200, easing: 'ease-out', delayMs: 0 }), '200ms ease-out on opacity');
  assert.equal(describeMotion(null), 'none');
  assert.equal(describeMotion(anim), '800ms linear animation spin × infinite');
});
