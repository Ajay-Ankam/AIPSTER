/* AIPSTER control-panel decorative background (BACKGROUND166).
 * Original implementation in the style of the public reference studied for
 * this task: a restrained star field with a sparse drifting graph, proximity
 * edges and small travelling dots. Decoration only: it never represents
 * workers, grants or live inference. No dependencies, no network, no
 * measurement of any kind. Classic script; exposes window.AipsterBackground166.
 */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__aipsterBg166 && window.__aipsterBg166.active) return;

  var CANVAS_ID = 'aipster-bg166';
  var STATIC_PARAM = 'bg166';
  var MAX_DPR = 1.5;
  var MAX_STARS = 120;
  var MAX_NODES = 30;
  var MAX_STREAMS = 8;
  var FRAME_DT_CLAMP = 50;

  var state = {
    active: false,
    running: false,
    reduced: false,
    raf: 0,
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    dpr: 1,
    stars: [],
    nodes: [],
    streams: [],
    edgeDist: 170,
    palette: null,
    dark: false,
    frames: 0,
    totalMs: 0,
    lastTs: 0,
    nextPulseMs: 3000,
    mediaReduced: null,
    mediaDark: null,
    onResize: null,
    onVisibility: null,
    onReducedChange: null,
    onDarkChange: null
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function forcedStatic() {
    try {
      return new URLSearchParams(window.location.search).get(STATIC_PARAM) === 'static';
    } catch (e) { return false; }
  }

  function queryReduced() {
    try {
      if (window.matchMedia) return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}
    return false;
  }

  function queryDark() {
    try {
      if (window.matchMedia) return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {}
    return false;
  }

  /* AIPSTER-driven accents. Light values pair with the Switchboard light
   * surface; dark values with the dark surface. Copper is reserved for the
   * rare pulse-ring accent so operational status colors keep their meaning. */
  function buildPalette(dark) {
    if (dark) {
      return {
        nodeCols: [[45, 212, 191], [110, 168, 255], [34, 211, 238], [95, 203, 151]],
        starCols: ['220,235,230', '190,225,255', '210,245,255', '235,225,205'],
        edgeAlpha: 0.20,
        pulse: [227, 154, 92]
      };
    }
    return {
      nodeCols: [[20, 110, 95], [70, 110, 190], [8, 145, 178], [29, 112, 72]],
      starCols: ['205,228,238', '190,220,235', '176,200,196', '222,214,196'],
      edgeAlpha: 0.16,
      pulse: [162, 78, 22]
    };
  }

  function rgba(col, a) {
    return 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + a.toFixed(3) + ')';
  }

  function planDensity(w, h) {
    var area = Math.max(w, 1) * Math.max(h, 1);
    return {
      stars: clamp(Math.round(area / 14000), 24, MAX_STARS),
      nodes: clamp(Math.round(area / 60000), 8, MAX_NODES)
    };
  }

  function makeStar(w, h, initial) {
    var layer = Math.floor(Math.random() * 3);
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : -3,
      r: 0.3 + layer * 0.35 + Math.random() * 0.5,
      speed: 0.008 + layer * 0.028 + Math.random() * 0.02,
      baseOp: 0.12 + Math.random() * 0.6,
      tw: Math.random() * Math.PI * 2,
      twSpd: 0.006 + Math.random() * 0.018,
      col: state.palette.starCols[Math.floor(Math.random() * state.palette.starCols.length)]
    };
  }

  function makeNode(w, h, initial) {
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : h + 24,
      vx: (Math.random() - 0.5) * 0.20,
      vy: -0.03 - Math.random() * 0.12,
      r: 1.6 + Math.random() * 2.8,
      col: state.palette.nodeCols[Math.floor(Math.random() * state.palette.nodeCols.length)],
      op: 0.40 + Math.random() * 0.40,
      glowPh: Math.random() * Math.PI * 2,
      glowSpd: 0.006 + Math.random() * 0.016,
      pulse: 0,
      pulseRad: 0
    };
  }

  function makeStream(count) {
    if (count < 2) return null;
    var ai = Math.floor(Math.random() * count);
    var bi = Math.floor(Math.random() * count);
    if (bi === ai) bi = (bi + 1) % count;
    return {
      ai: ai, bi: bi, t: Math.random(),
      speed: 0.0025 + Math.random() * 0.0045,
      r: 0.7 + Math.random() * 1.1,
      op: 0.45 + Math.random() * 0.35
    };
  }

  function rebuildField() {
    var w = state.width;
    var h = state.height;
    var plan = planDensity(w, h);
    var i;
    state.stars = [];
    for (i = 0; i < plan.stars; i++) state.stars.push(makeStar(w, h, true));
    state.nodes = [];
    for (i = 0; i < plan.nodes; i++) state.nodes.push(makeNode(w, h, true));
    var streamCount = clamp(Math.floor(plan.nodes / 4), 0, MAX_STREAMS);
    state.streams = [];
    for (i = 0; i < streamCount; i++) {
      var s = makeStream(plan.nodes);
      if (s) state.streams.push(s);
    }
    state.edgeDist = w < 640 ? 130 : 170;
  }

  function sizeCanvas() {
    var w = window.innerWidth || document.documentElement.clientWidth || 1024;
    var h = window.innerHeight || document.documentElement.clientHeight || 768;
    var dpr = 1;
    try { dpr = window.devicePixelRatio || 1; } catch (e) { dpr = 1; }
    state.dpr = clamp(dpr, 1, MAX_DPR);
    state.width = w;
    state.height = h;
    state.canvas.width = Math.round(w * state.dpr);
    state.canvas.height = Math.round(h * state.dpr);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function drawStatic() {
    var ctx = state.ctx;
    if (!ctx) return;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    drawField(0, true);
  }

  function drawField(dt, staticFrame) {
    var ctx = state.ctx;
    var i, j;
    var W = state.width;
    var H = state.height;
    for (i = 0; i < state.stars.length; i++) {
      var st = state.stars[i];
      if (!staticFrame) {
        st.y += st.speed * dt * 0.06;
        if (st.y > H + 3) { st.x = Math.random() * W; st.y = -3; }
        st.tw += st.twSpd * dt * 0.06;
      }
      var sop = st.baseOp * (0.55 + 0.45 * Math.sin(st.tw));
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + st.col + ',' + sop.toFixed(3) + ')';
      ctx.fill();
    }
    var edge = state.edgeDist;
    ctx.lineWidth = 0.7;
    for (i = 0; i < state.nodes.length; i++) {
      for (j = i + 1; j < state.nodes.length; j++) {
        var a = state.nodes[i];
        var b = state.nodes[j];
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= edge) continue;
        var alpha = (1 - d / edge) * state.palette.edgeAlpha;
        ctx.strokeStyle = rgba(a.col, alpha);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    for (i = 0; i < state.streams.length; i++) {
      var s = state.streams[i];
      if (!staticFrame) {
        s.t += s.speed * dt * 0.06;
        if (s.t >= 1) {
          var fresh = makeStream(state.nodes.length);
          if (fresh) { s.ai = fresh.ai; s.bi = fresh.bi; s.speed = fresh.speed; s.r = fresh.r; s.op = fresh.op; }
          s.t = 0;
        }
      }
      var na = state.nodes[s.ai];
      var nb = state.nodes[s.bi];
      if (!na || !nb) continue;
      var ex = nb.x - na.x;
      var ey = nb.y - na.y;
      var el = Math.sqrt(ex * ex + ey * ey);
      if (el >= edge || el < 1) continue;
      var px = na.x + ex * s.t;
      var py = na.y + ey * s.t;
      ctx.beginPath();
      ctx.arc(px, py, s.r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(na.col, s.op * (0.35 + 0.65 * Math.sin(Math.PI * s.t)));
      ctx.fill();
    }
    for (i = 0; i < state.nodes.length; i++) {
      var n = state.nodes[i];
      if (!staticFrame) {
        n.x += n.vx * dt * 0.06;
        n.y += n.vy * dt * 0.06;
        n.vx *= 0.999;
        n.vy *= 0.999;
        if (n.x < -24) n.x = W + 24; else if (n.x > W + 24) n.x = -24;
        if (n.y < -24) n.y = H + 24; else if (n.y > H + 24) n.y = -24;
        if (n.pulse > 0) { n.pulse -= 0.008 * (dt / 16); n.pulseRad = Math.min(n.pulseRad + 1.0 * (dt / 16), 54); }
        n.glowPh += n.glowSpd * dt * 0.06;
      }
      var glow = 0.7 + 0.3 * Math.sin(n.glowPh);
      var r = n.r * (1 + 0.15 * glow);
      var haloR = r * (4 + n.pulse * 6);
      var coreA = n.op + n.pulse * 0.4;
      var grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, haloR);
      grad.addColorStop(0, rgba(n.col, Math.min(coreA * 0.8, 0.9)));
      grad.addColorStop(0.4, rgba(n.col, coreA * 0.22));
      grad.addColorStop(1, rgba(n.col, 0));
      ctx.beginPath();
      ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(n.col, Math.min(coreA, 1));
      ctx.fill();
      if (n.pulse > 0) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.pulseRad, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(state.palette.pulse, n.pulse * 0.55);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    if (!staticFrame) {
      state.nextPulseMs -= dt;
      if (state.nextPulseMs <= 0) {
        var pick = state.nodes[Math.floor(Math.random() * state.nodes.length)];
        if (pick) { pick.pulse = 1; pick.pulseRad = 2; }
        state.nextPulseMs = 3500 + Math.random() * 3500;
      }
    }
  }

  function frame(ts) {
    if (!state.active) return;
    if (document.hidden || state.reduced) { state.running = false; state.raf = 0; return; }
    state.running = true;
    var dt = state.lastTs ? Math.min(ts - state.lastTs, FRAME_DT_CLAMP) : 16;
    state.lastTs = ts;
    var t0 = 0;
    try { t0 = performance.now(); } catch (e) {}
    state.ctx.clearRect(0, 0, state.width, state.height);
    drawField(dt, false);
    try { state.totalMs += performance.now() - t0; } catch (e) {}
    state.frames++;
    state.raf = window.requestAnimationFrame(frame);
  }

  function schedule() {
    if (!state.active || state.running || state.reduced || document.hidden) return;
    state.lastTs = 0;
    state.raf = window.requestAnimationFrame(frame);
  }

  function unschedule() {
    if (state.raf) {
      try {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(state.raf);
        else if (window.clearTimeout) window.clearTimeout(state.raf);
      } catch (e) {}
      state.raf = 0;
    }
    state.running = false;
  }

  function applyMode() {
    state.reduced = forcedStatic() || queryReduced();
    state.dark = queryDark();
    state.palette = buildPalette(state.dark);
    if (!state.active) return;
    if (state.reduced) {
      unschedule();
      drawStatic();
    } else {
      schedule();
    }
  }

  function init() {
    if (state.active) return api;
    var canvas = document.getElementById(CANVAS_ID);
    var own = false;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = CANVAS_ID;
      canvas.setAttribute('aria-hidden', 'true');
      own = true;
    } else {
      canvas.setAttribute('aria-hidden', 'true');
    }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    state.canvas = canvas;
    state.ctx = ctx;
    state.dark = queryDark();
    state.palette = buildPalette(state.dark);
    state.reduced = forcedStatic() || queryReduced();
    if (!ctx) {
      try { document.body.classList.add('aipster-bg166-static'); } catch (e) {}
      state.active = true;
      return api;
    }
    if (own) {
      var body = document.body || document.getElementsByTagName('body')[0];
      if (body) body.insertBefore(canvas, body.firstChild);
      else if (document.documentElement) document.documentElement.appendChild(canvas);
    }
    sizeCanvas();
    rebuildField();
    state.onResize = function () {
      sizeCanvas();
      rebuildField();
      if (state.reduced) drawStatic();
    };
    state.onVisibility = function () {
      if (document.hidden) unschedule();
      else {
        state.palette = buildPalette(queryDark());
        schedule();
      }
    };
    state.onReducedChange = function () { applyMode(); };
    state.onDarkChange = function () {
      state.dark = queryDark();
      state.palette = buildPalette(state.dark);
      if (state.reduced) drawStatic();
    };
    try { window.addEventListener('resize', state.onResize); } catch (e) {}
    try { document.addEventListener('visibilitychange', state.onVisibility); } catch (e) {}
    try {
      state.mediaReduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (state.mediaReduced) {
        if (state.mediaReduced.addEventListener) state.mediaReduced.addEventListener('change', state.onReducedChange);
        else if (state.mediaReduced.addListener) state.mediaReduced.addListener(state.onReducedChange);
      }
      state.mediaDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      if (state.mediaDark) {
        if (state.mediaDark.addEventListener) state.mediaDark.addEventListener('change', state.onDarkChange);
        else if (state.mediaDark.addListener) state.mediaDark.addListener(state.onDarkChange);
      }
    } catch (e) {}
    state.active = true;
    if (state.reduced) drawStatic();
    else schedule();
    return api;
  }

  function destroy() {
    unschedule();
    try { if (state.onResize) window.removeEventListener('resize', state.onResize); } catch (e) {}
    try { if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility); } catch (e) {}
    try {
      if (state.mediaReduced) {
        if (state.mediaReduced.removeEventListener) state.mediaReduced.removeEventListener('change', state.onReducedChange);
        else if (state.mediaReduced.removeListener) state.mediaReduced.removeListener(state.onReducedChange);
      }
      if (state.mediaDark) {
        if (state.mediaDark.removeEventListener) state.mediaDark.removeEventListener('change', state.onDarkChange);
        else if (state.mediaDark.removeListener) state.mediaDark.removeListener(state.onDarkChange);
      }
    } catch (e) {}
    try {
      if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    } catch (e) {}
    try { document.body.classList.remove('aipster-bg166-static'); } catch (e) {}
    state.canvas = null;
    state.ctx = null;
    state.stars = [];
    state.nodes = [];
    state.streams = [];
    state.frames = 0;
    state.totalMs = 0;
    state.active = false;
    state.onResize = null;
    state.onVisibility = null;
    state.onReducedChange = null;
    state.onDarkChange = null;
    state.mediaReduced = null;
    state.mediaDark = null;
    return api;
  }

  function getState() {
    return {
      active: state.active,
      running: state.running,
      reduced: state.reduced,
      dark: state.dark,
      width: state.width,
      height: state.height,
      dpr: state.dpr,
      stars: state.stars.length,
      nodes: state.nodes.length,
      streams: state.streams.length,
      edgeDist: state.edgeDist,
      canvasInDom: !!(state.canvas && state.canvas.parentNode)
    };
  }

  function getStats() {
    return {
      frames: state.frames,
      avgFrameMs: state.frames ? state.totalMs / state.frames : 0,
      stars: state.stars.length,
      nodes: state.nodes.length,
      streams: state.streams.length,
      dpr: state.dpr,
      running: state.running
    };
  }

  var api = { init: init, destroy: destroy, state: getState, stats: getStats, active: false };
  Object.defineProperty(api, 'active', { get: function () { return state.active; } });

  window.AipsterBackground166 = api;
  window.__aipsterBg166 = api;

  function autoStart() {
    try { init(); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart);
  } else {
    autoStart();
  }
})();
