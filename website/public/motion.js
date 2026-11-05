/* Built with Meta Muse. */
// Landing motion: presentation only, one classic same-origin script loaded
// last. It adds classes, CSS custom properties and aria-hidden overlays; the
// final text is already in the HTML and stays in the DOM for assistive
// technology. Nothing runs under prefers-reduced-motion: reduce.
// Each effect is written from scratch. Inspired by React Bits (reactbits.dev):
// DecryptedText, SpotlightCard, Magnet and DotGrid. ShinyText and the diagram
// beams are CSS only (styles.css).
(function () {
  'use strict';
  var w = window, d = document;
  if (!w.matchMedia || !w.requestAnimationFrame || !('IntersectionObserver' in w)) return;
  if (w.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  d.documentElement.classList.add('js');
  function all(selector) { return Array.prototype.slice.call(d.querySelectorAll(selector)); }

  // Calls paint(progress) once per frame for ms milliseconds, then done().
  function tween(ms, paint, done) {
    var start = 0;
    w.requestAnimationFrame(function frame(now) {
      if (!start) start = now;
      var t = Math.min(1, (now - start) / ms);
      paint(t);
      if (t < 1) w.requestAnimationFrame(frame); else done();
    });
  }

  // Draws an aria-hidden copy over el while the real text is only hidden
  // visually, then removes it, leaving the original node untouched.
  function overlay(el, ms, text) {
    var final = el.textContent, layer = d.createElement('span');
    layer.className = 'fx-overlay';
    layer.setAttribute('aria-hidden', 'true');
    el.classList.add('fx-host');
    el.appendChild(layer);
    tween(ms, function (t) { layer.textContent = text(final, t); }, function () {
      el.removeChild(layer);
      el.classList.remove('fx-host');
    });
  }

  // Runs fn once per element when at least `threshold` of it is visible.
  // An entry can report isIntersecting below the threshold, so the ratio is
  // checked too and the element stays observed until it gets there.
  function onceVisible(els, fn, threshold) {
    var left = els.length, min = threshold || 0;
    if (!left) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < min) return;
        io.unobserve(entry.target);
        fn(entry.target);
        if (!--left) io.disconnect();
      });
    }, {threshold: min});
    els.forEach(function (el) { io.observe(el); });
  }

  // DecryptedText: ids resolve left to right from scrambled glyphs.
  var GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  onceVisible(all('.fx-decrypt'), function (el) {
    overlay(el, 600, function (final, t) {
      var settled = Math.floor(final.length * t), out = '';
      for (var i = 0; i < final.length; i++) {
        var c = final.charAt(i);
        out += i < settled || c === ' ' ? c : GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
      }
      return out;
    });
  });

  // Diagram beams start when a figure is first well inside the viewport.
  onceVisible(all('.dg-figure'), function (el) { el.classList.add('is-in'); }, 0.35);

  // Pointer effects: SpotlightCard, DotGrid and Magnet share one passive,
  // frame-throttled handler. Reads every rect first, then writes.
  if (!w.matchMedia('(pointer: fine)').matches) return;
  var dots = d.querySelector('.app-grid'), magnet = d.querySelector('.fx-magnet');
  var x = 0, y = 0, target = null, lit = null, queued = false;
  function px(value) { return Math.round(value) + 'px'; }
  function frame() {
    queued = false;
    var spot = target && target.closest ? target.closest('.fx-spot') : null;
    var inDots = !!(dots && target && dots.contains(target));
    var s = spot && spot.getBoundingClientRect();
    var g = inDots && dots.getBoundingClientRect();
    var m = magnet && magnet.getBoundingClientRect();
    if (lit !== spot) {
      if (lit) lit.classList.remove('is-lit');
      if (spot) spot.classList.add('is-lit');
      lit = spot;
    }
    if (s) { spot.style.setProperty('--mx', px(x - s.left)); spot.style.setProperty('--my', px(y - s.top)); }
    if (dots) dots.classList.toggle('is-lit', inDots);
    if (g) { dots.style.setProperty('--mx', px(x - g.left)); dots.style.setProperty('--my', px(y - g.top)); }
    if (m) {
      var dx = x - (m.left + m.width / 2), dy = y - (m.top + m.height / 2);
      var near = target && Math.abs(dx) < m.width / 2 + 80 && Math.abs(dy) < m.height / 2 + 80;
      magnet.style.setProperty('--tx', near ? px(Math.max(-6, Math.min(6, dx * 0.12))) : '0px');
      magnet.style.setProperty('--ty', near ? px(Math.max(-6, Math.min(6, dy * 0.12))) : '0px');
    }
  }
  function schedule() { if (!queued) { queued = true; w.requestAnimationFrame(frame); } }
  d.addEventListener('pointermove', function (event) {
    if (event.pointerType === 'touch') return;
    x = event.clientX; y = event.clientY; target = event.target;
    schedule();
  }, {passive: true});
  d.documentElement.addEventListener('pointerleave', function () { target = null; schedule(); }, {passive: true});
}());
