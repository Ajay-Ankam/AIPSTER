// Built with Meta Muse.
// Landing diagrams: diagrams/diagrams.json -> inline SVG inside public/index.html,
// between <!-- diagram:<id>:start --> and <!-- diagram:<id>:end --> markers.
// Inline SVG picks up the page tokens and dark mode; every colour is a CSS
// class, never a literal. Each diagram is emitted twice (.dg-wide, .dg-narrow)
// and a container query on the figure shows one. No dependencies.
// It also writes a static, light-theme copy of each wide layout to the
// repository's assets/diagrams/<id>.svg for README.md: literal colours, no
// script, no motion, so GitHub renders it as a plain image.
//   node scripts/diagrams.mjs          rewrite public/index.html and assets/diagrams/
//   node scripts/diagrams.mjs --check  exit 1 when either is stale
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
export const SOURCE = resolve(ROOT, 'diagrams/diagrams.json');
export const PAGE = resolve(ROOT, 'public/index.html');
export const STANDALONE_DIR = resolve(ROOT, '..', 'assets', 'diagrams');

// Type sizes in SVG user units. Wide layouts only show at >= 0.92x scale and
// narrow ones at >= 0.95x, so every size here renders at 12px or more.
const TYPE = {
  wide: {label: 14.5, sub: 13, state: 13, edge: 13, group: 14},
  narrow: {label: 14, sub: 13, state: 13, edge: 13, group: 14},
};
const SEMIBOLD = 0.54, REGULAR = 0.5; // average glyph advance per px of font size
const PAD = 12, RAIL = 16, RADIUS = 8, OFFSET = 6, ARROW = [7, 4.5];
const KINDS = new Set(['request', 'heartbeat', 'result', 'optional', 'architectural']);
const FLOW_STATES = new Set(['none', 'built', 'planned', 'notlive', 'optional']);
const MESH_STATES = new Set(['online', 'stale', 'offline', 'unknown']);

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = value => String(Math.round(value * 10) / 10);
const fail = message => { throw new Error(`diagrams: ${message}`); };

export function wrap(text, width, size, factor) {
  const max = Math.max(1, Math.floor(width / (size * factor)));
  const lines = [];
  for (const word of String(text).split(/\s+/)) {
    const last = lines.at(-1);
    if (last !== undefined && (last + ' ' + word).length <= max) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  return lines;
}
const textWidth = (text, size, factor) => text.length * size * factor;

function text(x, y, cls, size, lines, lineHeight, anchor) {
  const a = anchor ? ` text-anchor="${anchor}"` : '';
  return lines.map((line, i) => `<text class="${cls}" x="${n(x)}" y="${n(y + i * lineHeight)}" font-size="${size}"${a}>${esc(line)}</text>`).join('');
}

function roundedPath(points) {
  let d = `M${n(points[0].x)} ${n(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, q] = [points[i - 1], points[i], points[i + 1]];
    const len1 = Math.hypot(c.x - p.x, c.y - p.y), len2 = Math.hypot(q.x - c.x, q.y - c.y);
    const r = Math.min(RADIUS, len1 / 2, len2 / 2);
    if (r < 0.5) { d += ` L${n(c.x)} ${n(c.y)}`; continue; }
    const a = {x: c.x - (c.x - p.x) / len1 * r, y: c.y - (c.y - p.y) / len1 * r};
    const b = {x: c.x + (q.x - c.x) / len2 * r, y: c.y + (q.y - c.y) / len2 * r};
    d += ` L${n(a.x)} ${n(a.y)} Q${n(c.x)} ${n(c.y)} ${n(b.x)} ${n(b.y)}`;
  }
  const end = points.at(-1);
  return d + ` L${n(end.x)} ${n(end.y)}`;
}

function arrowHead(from, tip) {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / len, uy = (tip.y - from.y) / len;
  const bx = tip.x - ux * ARROW[0], by = tip.y - uy * ARROW[0];
  return `M${n(tip.x)} ${n(tip.y)} L${n(bx - uy * ARROW[1])} ${n(by + ux * ARROW[1])} L${n(bx + uy * ARROW[1])} ${n(by - ux * ARROW[1])}Z`;
}

const overlaps = (a, b, margin = 0) => a.x < b.x + b.w + margin && b.x < a.x + a.w + margin
  && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

function validate(diagram) {
  if (!/^[a-z][a-z0-9-]*$/.test(diagram.id || '')) fail(`bad diagram id ${diagram.id}`);
  for (const key of ['title', 'desc']) if (!diagram[key]) fail(`${diagram.id} needs ${key}`);
  const lanes = new Set((diagram.lanes || []).map(lane => lane.id));
  const ids = new Set();
  for (const node of diagram.nodes) {
    if (ids.has(node.id)) fail(`${diagram.id}: duplicate node ${node.id}`);
    ids.add(node.id);
    if (!lanes.has(node.lane)) fail(`${diagram.id}/${node.id}: unknown lane ${node.lane}`);
    const states = diagram.type === 'mesh' ? MESH_STATES : FLOW_STATES;
    if (!states.has(node.state)) fail(`${diagram.id}/${node.id}: unknown state ${node.state}`);
  }
  for (const edge of diagram.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) fail(`${diagram.id}: edge ${edge.from}>${edge.to} names a missing node`);
    if (!KINDS.has(edge.kind)) fail(`${diagram.id}: edge ${edge.from}>${edge.to} has unknown kind ${edge.kind}`);
  }
  for (const name of ['wide', 'narrow']) {
    const layout = diagram.layouts?.[name];
    if (!layout) fail(`${diagram.id} needs a ${name} layout`);
    for (const id of ids) if (!layout.nodes[id]) fail(`${diagram.id}/${name}: no position for ${id}`);
    for (const id of Object.keys(layout.nodes)) if (!ids.has(id)) fail(`${diagram.id}/${name}: position for unknown node ${id}`);
  }
}

function frame(diagram, name, layout, body) {
  const [w, h] = layout.size.map(v => v * layout.grid);
  const base = `dg-${diagram.id}-${name}`;
  return `<svg class="dg-svg dg-${name}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${base}-title" aria-describedby="${base}-desc" focusable="false">`
    + `<title id="${base}-title">${esc(diagram.title)}</title><desc id="${base}-desc">${esc(diagram.desc)}</desc>${body}</svg>`;
}

function sideOf(a, b, prefer) {
  const sepX = b.x >= a.x + a.w || a.x >= b.x + b.w;
  const sepY = b.y >= a.y + a.h || a.y >= b.y + b.h;
  const horizontal = sepX && (!sepY || prefer === 'horizontal');
  if (horizontal) return b.x > a.x ? ['right', 'left'] : ['left', 'right'];
  return b.y > a.y ? ['bottom', 'top'] : ['top', 'bottom'];
}
const isHorizontal = side => side === 'left' || side === 'right';
function anchor(box, side, offset) {
  if (side === 'left') return {x: box.x, y: box.y + box.h / 2 + offset};
  if (side === 'right') return {x: box.x + box.w, y: box.y + box.h / 2 + offset};
  if (side === 'top') return {x: box.x + box.w / 2 + offset, y: box.y};
  return {x: box.x + box.w / 2 + offset, y: box.y + box.h};
}
function route(a, b, from, to, offset) {
  const p = anchor(a, from, offset), q = anchor(b, to, offset);
  if (isHorizontal(from) && isHorizontal(to)) {
    if (from === to) {
      const x = from === 'left' ? Math.min(a.x, b.x) - RAIL : Math.max(a.x + a.w, b.x + b.w) + RAIL;
      return [p, {x, y: p.y}, {x, y: q.y}, q];
    }
    if (Math.abs(p.y - q.y) < 0.5) return [p, q];
    const x = (p.x + q.x) / 2;
    return [p, {x, y: p.y}, {x, y: q.y}, q];
  }
  if (!isHorizontal(from) && !isHorizontal(to)) {
    if (from === to) {
      const y = from === 'top' ? Math.min(a.y, b.y) - RAIL : Math.max(a.y + a.h, b.y + b.h) + RAIL;
      return [p, {x: p.x, y}, {x: q.x, y}, q];
    }
    if (Math.abs(p.x - q.x) < 0.5) return [p, q];
    const y = (p.y + q.y) / 2;
    return [p, {x: p.x, y}, {x: q.x, y}, q];
  }
  return isHorizontal(from) ? [p, {x: q.x, y: p.y}, q] : [p, {x: p.x, y: q.y}, q];
}

function flowLayout(diagram, name) {
  const layout = diagram.layouts[name];
  const type = TYPE[name];
  const g = layout.grid;
  const [W, H] = layout.size.map(v => v * g);
  const boxes = new Map();
  for (const node of diagram.nodes) {
    const [x, y, w, h] = layout.nodes[node.id].map(v => v * g);
    const box = {x, y, w, h};
    if (x < 0 || y < 0 || x + w > W || y + h > H) fail(`${diagram.id}/${name}/${node.id} lies outside the canvas`);
    for (const [other, b] of boxes) if (overlaps(box, b, 4)) fail(`${diagram.id}/${name}: ${node.id} overlaps ${other}`);
    boxes.set(node.id, box);
  }
  const occupied = [...boxes.values()];
  const edges = [], beams = [], labels = [];
  // Edges that share an endpoint draw one port there, not a stack of copies.
  const ports = new Set();
  let pulse = 0;
  diagram.edges.forEach(edge => {
    const key = `${edge.from}>${edge.to}`;
    const override = layout.routes?.[key] || {};
    const a = boxes.get(edge.from), b = boxes.get(edge.to);
    const auto = sideOf(a, b, layout.prefer);
    const from = override.from || auto[0], to = override.to || auto[1];
    const reverse = diagram.edges.some(other => other.from === edge.to && other.to === edge.from);
    const offset = reverse ? (edge.from < edge.to ? -OFFSET : OFFSET) : 0;
    const points = route(a, b, from, to, offset);
    const d = roundedPath(points);
    const cls = `dg-edge dg-k-${edge.kind}`;
    edges.push(`<path class="${cls}" d="${d}"/>`);
    ports.add(`<circle class="dg-port" cx="${n(points[0].x)}" cy="${n(points[0].y)}" r="2.5"/>`);
    if (edge.kind === 'architectural') {
      ports.add(`<circle class="dg-port" cx="${n(points.at(-1).x)}" cy="${n(points.at(-1).y)}" r="2.5"/>`);
    } else {
      edges.push(`<path class="dg-arrow dg-k-${edge.kind}" d="${arrowHead(points.at(-2), points.at(-1))}"/>`);
    }
    if (edge.kind === 'request' || edge.kind === 'result') {
      beams.push(`<path class="dg-beam dg-k-${edge.kind} dg-b${(pulse++ % 4) + 1}" d="${d}" pathLength="1"/>`);
    }
    if (!edge.label || override.label === 'none') return;
    let best = 0, segment = [points[0], points[1]];
    for (let i = 1; i < points.length; i++) {
      const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      if (length > best) { best = length; segment = [points[i - 1], points[i]]; }
    }
    const horizontal = Math.abs(segment[0].y - segment[1].y) < 0.5;
    const side = override.label || (horizontal ? (offset > 0 ? 'below' : 'above') : (offset < 0 ? 'left' : 'right'));
    const mx = (segment[0].x + segment[1].x) / 2, my = (segment[0].y + segment[1].y) / 2;
    const width = textWidth(edge.label, type.edge, REGULAR);
    const size = type.edge;
    let x = mx, y = my, anchorAt = 'middle';
    if (side === 'above') y = my - 7;
    else if (side === 'below') y = my + size + 4;
    else if (side === 'left') { x = mx - 8; y = my + size * 0.35; anchorAt = 'end'; }
    else { x = mx + 8; y = my + size * 0.35; anchorAt = 'start'; }
    const left = anchorAt === 'middle' ? x - width / 2 : anchorAt === 'end' ? x - width : x;
    const bbox = {x: left, y: y - size * 0.8, w: width, h: size};
    if (bbox.x < 2 || bbox.y < 2 || bbox.x + bbox.w > W - 2 || bbox.y + bbox.h > H - 2) fail(`${diagram.id}/${name}: label "${edge.label}" leaves the canvas`);
    for (const box of occupied) if (overlaps(bbox, box, 2)) fail(`${diagram.id}/${name}: label "${edge.label}" collides with a node`);
    labels.push(text(x, y, 'dg-elabel', size, [edge.label], 0, anchorAt));
  });

  const nodes = diagram.nodes.map(node => {
    const box = boxes.get(node.id);
    const inner = box.w - PAD * 2;
    const parts = [`<rect class="dg-box" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="6"/>`];
    let y = box.y + PAD;
    if (node.stateLabel) {
      parts.push(mark(node.state, box.x + PAD + 5, y + 6, 4.5));
      parts.push(text(box.x + PAD + 15, y + 10.5, 'dg-statelabel', type.state, [node.stateLabel], 0));
      y += 20;
    } else if (node.state !== 'none') {
      parts.push(mark(node.state, box.x + box.w - PAD - 4, box.y + PAD + 4, 4.5));
    }
    const label = wrap(node.label, node.stateLabel || node.state === 'none' ? inner : inner - 14, type.label, SEMIBOLD);
    const lh = type.label * 1.22;
    parts.push(text(box.x + PAD, y + type.label * 0.95, 'dg-label', type.label, label, lh));
    y += type.label * 0.95 + (label.length - 1) * lh;
    if (node.sublabel) {
      const sub = wrap(node.sublabel, inner, type.sub, REGULAR);
      const sh = type.sub * 1.3;
      parts.push(text(box.x + PAD, y + 4 + type.sub * 1.05, 'dg-sublabel', type.sub, sub, sh));
      y += 4 + type.sub * 1.05 + (sub.length - 1) * sh;
    }
    if (y + PAD - 3 > box.y + box.h) fail(`${diagram.id}/${name}/${node.id}: text needs ${n(y + PAD - 3 - box.y)} of ${box.h}px`);
    return `<g class="dg-node dg-s-${node.state} dg-lane-${node.lane}${node.id === 'owner' ? ' dg-owner' : ''}">${parts.join('')}</g>`;
  });
  return frame(diagram, name, layout,
    `<g class="dg-edges">${edges.join('')}</g><g class="dg-beams">${beams.join('')}</g>`
    + `<g class="dg-ports">${[...ports].join('')}</g><g class="dg-nodes">${nodes.join('')}</g><g class="dg-elabels">${labels.join('')}</g>`);
}

function mark(state, cx, cy, r) {
  return `<circle class="dg-mark dg-m-${state}" cx="${n(cx)}" cy="${n(cy)}" r="${r}"/>`;
}

function shape(state, cx, cy, r) {
  const at = `cx="${n(cx)}" cy="${n(cy)}"`;
  if (state === 'online') return `<circle class="dg-shape dg-st-online" ${at} r="${r}"/>`;
  if (state === 'stale') return `<circle class="dg-shape dg-st-stale" ${at} r="${r}"/>`
    + `<path class="dg-fill dg-st-stale" d="M${n(cx)} ${n(cy - r)} A${r} ${r} 0 0 0 ${n(cx)} ${n(cy + r)}Z"/>`;
  if (state === 'offline') {
    const s = r + 1;
    return `<path class="dg-shape dg-st-offline" d="M${n(cx)} ${n(cy - s)} L${n(cx + s)} ${n(cy)} L${n(cx)} ${n(cy + s)} L${n(cx - s)} ${n(cy)}Z"/>`;
  }
  return `<circle class="dg-shape dg-st-unknown" ${at} r="${r}"/>`;
}

function meshLayout(diagram, name) {
  const layout = diagram.layouts[name];
  const type = TYPE[name];
  const g = layout.grid;
  const [W, H] = layout.size.map(v => v * g);
  const at = new Map(diagram.nodes.map(node => {
    const [x, y] = layout.nodes[node.id].map(v => v * g);
    if (x < 12 || y < 12 || x > W - 12 || y > H - 12) fail(`${diagram.id}/${name}/${node.id} lies outside the canvas`);
    return [node.id, {x, y}];
  }));
  const byId = new Map(diagram.nodes.map(node => [node.id, node]));
  const live = new Set((diagram.lanes || []).filter(lane => lane.live).map(lane => lane.id));
  const edges = diagram.edges.map((edge, i) => {
    const p = at.get(edge.from), q = at.get(edge.to);
    const source = byId.get(edge.from);
    const idle = edge.kind === 'heartbeat' && (source.state === 'offline' || source.state === 'unknown');
    return `<path class="dg-edge dg-k-${edge.kind}${idle ? ' dg-idle' : ''} dg-b${(i % 4) + 1}" d="M${n(p.x)} ${n(p.y)} L${n(q.x)} ${n(q.y)}"/>`;
  });
  const nodes = diagram.nodes.map(node => {
    const {x, y} = at.get(node.id);
    const parts = [];
    if (node.shared) parts.push(`<circle class="dg-share" cx="${n(x)}" cy="${n(y)}" r="11"/>`);
    if (node.kind === 'hub') parts.push(`<circle class="dg-hub" cx="${n(x)}" cy="${n(y)}" r="7.5"/>`);
    else {
      if (live.has(node.lane) && node.state === 'online') parts.push(`<circle class="dg-halo" cx="${n(x)}" cy="${n(y)}" r="5"/>`);
      parts.push(shape(node.state, x, y, 5));
    }
    return `<g class="dg-node dg-lane-${node.lane}${node.shared ? ' dg-shared' : ''}">${parts.join('')}</g>`;
  });
  const groups = (diagram.lanes || []).map(lane => {
    const pos = layout.groups?.[lane.id];
    if (!pos) fail(`${diagram.id}/${name}: no group label position for ${lane.id}`);
    const [x, y] = pos.map(v => v * g);
    const width = textWidth(lane.label, type.group, REGULAR);
    if (x - width / 2 < 2 || x + width / 2 > W - 2 || y > H - 2 || y < type.group) fail(`${diagram.id}/${name}: group label ${lane.id} leaves the canvas`);
    return text(x, y, 'dg-group', type.group, [lane.label], 0, 'middle');
  });
  return frame(diagram, name, layout,
    `<g class="dg-edges">${edges.join('')}</g><g class="dg-nodes">${nodes.join('')}</g><g class="dg-groups">${groups.join('')}</g>`);
}

export function renderDiagram(diagram) {
  validate(diagram);
  const draw = diagram.type === 'mesh' ? meshLayout : flowLayout;
  return ['wide', 'narrow'].map(name => draw(diagram, name));
}

// The light tokens from public/styles.css, as literals: an SVG loaded as an
// image cannot read the page's custom properties.
const STANDALONE_CSS = [
  'text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif;fill:#0f1f1a}',
  '.dg-bg{fill:#f8faf7;stroke:#d5ddd6}.dg-dot{fill:#c3cec5}.dg-dots{fill:url(#dg-dots)}',
  '.dg-label{font-weight:600}.dg-sublabel,.dg-statelabel{fill:#4a5d55}',
  '.dg-elabel{fill:#4a5d55;paint-order:stroke;stroke:#f8faf7;stroke-width:5px;stroke-linejoin:round}',
  '.dg-group{fill:#4a5d55;font-weight:500}',
  '.dg-box{fill:#ffffff;stroke:#c3cec5;stroke-width:1}.dg-owner .dg-box{fill:#f6e8dc;stroke:#a24e16}',
  '.dg-s-optional .dg-box{stroke:#75897f;stroke-dasharray:4 3}',
  '.dg-mark{fill:none;stroke:#0f1f1a;stroke-width:1.5}.dg-m-built{fill:#0f1f1a;stroke:none}',
  '.dg-m-notlive,.dg-m-optional{stroke:#4a5d55;stroke-dasharray:2.2 2}',
  '.dg-edge{fill:none;stroke:#75897f;stroke-width:1.5;stroke-linecap:round}',
  '.dg-k-heartbeat{stroke-dasharray:1.5 4}.dg-k-optional{stroke-dasharray:6 5}.dg-k-architectural{stroke-dasharray:5 6}',
  '.dg-arrow{fill:#75897f}.dg-port{fill:#ffffff;stroke:#75897f;stroke-width:1.5}',
  '.dg-mesh .dg-edge{stroke-width:1.25}.dg-mesh .dg-k-architectural{stroke-width:1.5}.dg-idle{opacity:.45}',
  '.dg-hub{fill:#0f1f1a}.dg-share{fill:#f6e8dc;stroke:#a24e16;stroke-width:1.5}',
  '.dg-shape{stroke-width:1.5;fill:#ffffff}.dg-shape.dg-st-online{fill:#1d7048;stroke:#1d7048}',
  '.dg-st-stale{stroke:#85590a}.dg-fill.dg-st-stale{fill:#85590a;stroke:none}',
  '.dg-st-offline{stroke:#b42b1f}.dg-st-unknown{stroke:#4651b5;stroke-dasharray:2 2}',
].join('');

// The wide layout as a standalone file. Beams and halos exist only to be
// animated on the site, so they are left out.
export function renderStandalone(diagram) {
  const [wide] = renderDiagram(diagram);
  const [w, h] = diagram.layouts.wide.size.map(v => v * diagram.layouts.wide.grid);
  const tagEnd = wide.indexOf('>') + 1, descEnd = wide.indexOf('</desc>') + '</desc>'.length;
  const open = wide.slice(0, tagEnd)
    .replace('<svg class="dg-svg dg-wide"', `<svg xmlns="http://www.w3.org/2000/svg" class="dg-svg dg-${diagram.type}"`)
    .replace(' focusable="false"', '');
  const body = wide.slice(descEnd, -'</svg>'.length)
    .replace(/<g class="dg-beams">[^]*?<\/g>/, '')
    .replace(/<circle class="dg-halo"[^>]*\/>/g, '');
  return `${open}${wide.slice(tagEnd, descEnd)}<style>${STANDALONE_CSS}</style>`
    + '<defs><pattern id="dg-dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle class="dg-dot" cx="8" cy="8" r="1"/></pattern></defs>'
    + `<rect class="dg-bg" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8"/><rect class="dg-dots" width="${w}" height="${h}" rx="8"/>`
    + `${body}</svg>\n`;
}

export const standalonePath = diagram => resolve(STANDALONE_DIR, `${diagram.id}.svg`);
async function readOrNull(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }

export function apply(html, source) {
  let out = html;
  for (const diagram of source.diagrams) {
    const start = `<!-- diagram:${diagram.id}:start -->`, end = `<!-- diagram:${diagram.id}:end -->`;
    const i = out.indexOf(start), j = out.indexOf(end);
    if (i < 0 || j < i || out.indexOf(start, i + 1) >= 0 || out.indexOf(end, j + 1) >= 0) fail(`public/index.html needs exactly one ${start} ... ${end} pair`);
    const indent = out.slice(out.lastIndexOf('\n', i) + 1, i);
    const body = renderDiagram(diagram).map(svg => `\n${indent}${svg}`).join('');
    out = out.slice(0, i + start.length) + body + `\n${indent}` + out.slice(j);
  }
  return out;
}

export async function load() {
  return {source: JSON.parse(await readFile(SOURCE, 'utf8')), html: await readFile(PAGE, 'utf8')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {source, html} = await load();
  const next = apply(html, source);
  const files = await Promise.all(source.diagrams.map(async diagram => ({
    path: standalonePath(diagram), next: renderStandalone(diagram), current: await readOrNull(standalonePath(diagram))})));
  const stale = files.filter(file => file.next !== file.current);
  if (process.argv.includes('--check')) {
    if (next !== html || stale.length) {
      console.error('Diagrams are out of date (public/index.html or assets/diagrams/): run `npm run diagrams`.');
      process.exit(1);
    }
    console.log(JSON.stringify({diagrams: source.diagrams.length, current: true}));
  } else {
    if (next !== html) await writeFile(PAGE, next);
    if (stale.length) await mkdir(STANDALONE_DIR, {recursive: true});
    for (const file of stale) await writeFile(file.path, file.next);
    console.log(JSON.stringify({diagrams: source.diagrams.length, written: next !== html || stale.length > 0}));
  }
}
