// Landing motion (public/motion.js) run in a vm with a stub DOM: the
// one-shot diagram effects start only once the requested share of the
// figure is visible, not on the first isIntersecting entry.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import vm from 'node:vm';

const SOURCE = await readFile(resolve(import.meta.dirname, '..', 'public', 'motion.js'), 'utf8');

function element() {
  const classes = new Set();
  return {classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c)}};
}

function run({figures = [element()]} = {}) {
  const observers = [];
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.observed = new Set(); this.disconnected = false; observers.push(this); }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  const byselector = {'.dg-figure': figures};
  const document = {documentElement: element(), querySelectorAll: selector => byselector[selector] || [], querySelector: () => null, addEventListener() {}};
  const window = {document, IntersectionObserver, requestAnimationFrame: () => 0, matchMedia: () => ({matches: false})};
  window.window = window;
  vm.runInNewContext(SOURCE, window);
  return {observers, figures};
}

test('diagram effects wait for the 0.35 visibility ratio', () => {
  const {observers, figures: [figure]} = run();
  const io = observers.find(o => o.options.threshold === 0.35);
  assert.ok(io, 'the diagram observer asks for a 0.35 threshold');
  assert.ok(io.observed.has(figure));

  io.callback([{isIntersecting: true, intersectionRatio: 0.1, target: figure}]);
  assert.equal(figure.classList.contains('is-in'), false, 'a sub-threshold entry does not start the beams');
  assert.ok(io.observed.has(figure), 'and the figure stays observed');

  io.callback([{isIntersecting: false, intersectionRatio: 0.5, target: figure}]);
  assert.equal(figure.classList.contains('is-in'), false, 'a non-intersecting entry never fires');

  io.callback([{isIntersecting: true, intersectionRatio: 0.35, target: figure}]);
  assert.equal(figure.classList.contains('is-in'), true, 'an at-threshold entry starts them');
  assert.equal(io.observed.has(figure), false, 'once');
  assert.equal(io.disconnected, true, 'the observer disconnects after its last figure');
});

test('each figure fires once, at or above the threshold', () => {
  const {observers, figures: [a, b]} = run({figures: [element(), element()]});
  const io = observers.find(o => o.options.threshold === 0.35);
  io.callback([{isIntersecting: true, intersectionRatio: 0.2, target: a}, {isIntersecting: true, intersectionRatio: 0.6, target: b}]);
  assert.deepEqual([a, b].map(f => f.classList.contains('is-in')), [false, true]);
  assert.equal(io.disconnected, false, 'still waiting for the first figure');
  io.callback([{isIntersecting: true, intersectionRatio: 0.9, target: a}]);
  assert.equal(a.classList.contains('is-in'), true);
  assert.equal(io.disconnected, true);
});

test('nothing is observed under reduced motion', () => {
  const observers = [];
  const window = {document: {documentElement: element()}, IntersectionObserver: class { constructor() { observers.push(this); } },
    requestAnimationFrame: () => 0, matchMedia: q => ({matches: q.includes('reduce')})};
  window.window = window;
  vm.runInNewContext(SOURCE, window);
  assert.equal(observers.length, 0);
  assert.equal(window.document.documentElement.classList.contains('js'), false);
});
