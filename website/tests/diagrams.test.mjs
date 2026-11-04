// Landing diagrams: the inline SVG in public/index.html is generated from
// diagrams/diagrams.json and must stay current, accessible, static-safe
// (no SMIL) and token-coloured.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {parse} from 'parse5';
import {load, apply, renderDiagram} from '../scripts/diagrams.mjs';

const GENERATOR = resolve(import.meta.dirname, '..', 'scripts', 'diagrams.mjs');
const {source, html} = await load();

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textOf).join('');
function block(id) {
  const start = `<!-- diagram:${id}:start -->`, end = `<!-- diagram:${id}:end -->`;
  const i = html.indexOf(start), j = html.indexOf(end);
  assert.ok(i >= 0 && j > i, `markers for ${id}`);
  return html.slice(i + start.length, j);
}
function svgs(fragment) {
  const found = [];
  walk(parse(`<!doctype html><body>${fragment}`), node => { if (node.tagName === 'svg') found.push(node); });
  return found;
}

test('generator --check passes on the committed page', async () => {
  const {stdout} = await promisify(execFile)(process.execPath, [GENERATOR, '--check']);
  assert.deepEqual(JSON.parse(stdout), {diagrams: source.diagrams.length, current: true});
  assert.equal(apply(html, source), html);
});

test('generator --check fails when the page drifts from the JSON', () => {
  const edited = structuredClone(source);
  edited.diagrams[0].nodes[0].label += ' (edited)';
  assert.notEqual(apply(html, edited), html);
});

test('every diagram is in the page exactly once with both layouts', () => {
  assert.deepEqual(source.diagrams.map(d => d.id), ['how', 'research', 'mesh']);
  for (const diagram of source.diagrams) {
    assert.equal(html.split(`<!-- diagram:${diagram.id}:start -->`).length, 2, `${diagram.id} start marker once`);
    const found = svgs(block(diagram.id));
    assert.deepEqual(found.map(svg => attr(svg, 'class')), ['dg-svg dg-wide', 'dg-svg dg-narrow'], diagram.id);
  }
});

test('each SVG is a labelled image with a title and description', () => {
  const ids = new Set();
  walk(parse(html), node => { const id = attr(node, 'id'); if (id) { assert.ok(!ids.has(id), `duplicate id ${id}`); ids.add(id); } });
  for (const diagram of source.diagrams) {
    for (const svg of svgs(block(diagram.id))) {
      assert.equal(attr(svg, 'role'), 'img');
      const children = svg.childNodes.filter(c => c.tagName);
      const title = children.find(c => c.tagName === 'title'), desc = children.find(c => c.tagName === 'desc');
      assert.ok(title && desc, `${diagram.id} has title and desc`);
      assert.equal(attr(svg, 'aria-labelledby'), attr(title, 'id'));
      assert.equal(attr(svg, 'aria-describedby'), attr(desc, 'id'));
      assert.equal(textOf(title), diagram.title);
      assert.equal(textOf(desc), diagram.desc);
      assert.match(attr(svg, 'viewBox'), /^0 0 \d+ \d+$/);
    }
  }
  assert.match(source.diagrams.find(d => d.id === 'research').title, /^Proposed design/);
  assert.match(source.diagrams.find(d => d.id === 'mesh').desc, /architectural lanes[^.]*not live/);
});

test('no SMIL, scripts, external references or literal colours inside the diagrams', () => {
  for (const diagram of source.diagrams) {
    walk(parse(`<!doctype html><body>${block(diagram.id)}`), node => {
      if (!node.tagName) return;
      assert.ok(!['animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'script', 'foreignobject', 'image', 'use', 'style'].includes(node.tagName.toLowerCase()), `${diagram.id}: <${node.tagName}>`);
      for (const a of node.attrs) {
        assert.ok(!['fill', 'stroke', 'style', 'color', 'stop-color', 'href', 'xlink:href'].includes(a.name) && !/^on/i.test(a.name), `${diagram.id}: ${a.name}`);
        assert.ok(!/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|url\(/i.test(a.value) || a.name === 'id' || a.name.startsWith('aria-'), `${diagram.id}: literal colour or URL in ${a.name}`);
      }
    });
  }
});

test('visible text comes from the JSON and stays at 12px or more', () => {
  for (const diagram of source.diagrams) {
    const words = new Set([...diagram.nodes.flatMap(n => [n.label, n.sublabel, n.stateLabel]), ...diagram.edges.map(e => e.label), ...diagram.lanes.map(l => l.label)]
      .filter(Boolean).flatMap(s => s.split(/\s+/)));
    for (const svg of svgs(block(diagram.id))) {
      const texts = [];
      walk(svg, node => { if (node.tagName === 'text') texts.push(node); });
      assert.ok(texts.length > 0, `${diagram.id} renders real <text>`);
      for (const t of texts) {
        for (const word of textOf(t).split(/\s+/)) assert.ok(words.has(word), `${diagram.id}: "${word}" is not in the JSON`);
        assert.ok(Number(attr(t, 'font-size')) >= 13, `${diagram.id}: font-size ${attr(t, 'font-size')}`);
      }
    }
    if (diagram.type === 'flow') {
      for (const svg of svgs(block(diagram.id))) {
        const drawn = [];
        walk(svg, node => { if (node.tagName === 'text' && attr(node, 'class') === 'dg-label') drawn.push(textOf(node)); });
        assert.equal(drawn.join(' '), diagram.nodes.map(n => n.label).join(' '), `${diagram.id}: every node label drawn in order`);
      }
    }
  }
});

test('the renderer rejects layouts whose text would not fit', () => {
  const broken = structuredClone(source.diagrams[1]);
  broken.nodes[0].sublabel = 'Selective reuse only, with far more words than this node has room to hold';
  assert.throws(() => renderDiagram(broken), /text needs/);
  const overlap = structuredClone(source.diagrams[1]);
  overlap.layouts.narrow.nodes.loop = overlap.layouts.narrow.nodes.dgm.slice();
  assert.throws(() => renderDiagram(overlap), /overlaps/);
});

test('the landing places each diagram where the brief puts it', () => {
  const at = needle => { const i = html.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const overviewEnd = html.indexOf('</section>', at('<section id="overview"'));
  assert.ok(at('<!-- diagram:how:start -->') > at('<section id="overview"') && at('<!-- diagram:how:end -->') < overviewEnd);
  assert.ok(at('<!-- diagram:mesh:start -->') > at('<section id="story"') && at('<!-- diagram:mesh:start -->') < at('<section id="build"'));
  assert.ok(at('<!-- diagram:research:start -->') > at('<section id="architecture"') && at('<!-- diagram:research:start -->') < at('<div class="figs">'));
  assert.ok(at('<!-- diagram:research:end -->') < at('/assets/AIPSTER-model-LoRA-drilldown.png'), 'the model figure stays below');
});

test('each diagram replaces, not repeats, the content it draws', () => {
  // The how diagram is the only telling of the four steps, and the research
  // diagram replaces the published IRB / DGM figure.
  const overview = html.slice(html.indexOf('<section id="overview"'), html.indexOf('</section>', html.indexOf('<section id="overview"')));
  const outside = overview.replace(/<!-- diagram:how:start -->[\s\S]*<!-- diagram:how:end -->/, '');
  for (const node of source.diagrams[0].nodes.filter(n => n.id !== 'owner')) assert.ok(!outside.includes(node.label), `"${node.label}" appears outside the diagram`);
  assert.ok(!html.includes('<ol class="sequence">'));
  assert.ok(!html.includes('IRB-DGM-JEV-component-flow'));
});

test('edges that meet draw one port, not a stack', () => {
  for (const diagram of source.diagrams) {
    for (const svg of svgs(block(diagram.id))) {
      const ports = [];
      walk(svg, node => { if (node.tagName === 'circle' && attr(node, 'class') === 'dg-port') ports.push(`${attr(node, 'cx')},${attr(node, 'cy')}`); });
      assert.equal(new Set(ports).size, ports.length, `${diagram.id}/${attr(svg, 'class')}: duplicate port`);
    }
  }
});
