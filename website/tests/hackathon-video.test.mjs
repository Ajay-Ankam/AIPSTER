// Focused regression for the published hackathon intro cut: exact source
// bytes, a poster frame from the cut, captions/transcript, a user-click
// player with no autoplay, and the README watch link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLIC = resolve(ROOT, 'website', 'public');
const EXPECTED_SHA256 = '4dd3947e66cb6e70946f910d15388ba2fa6ba188b95579539a7066118b237109';

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}
function tags(html, name) {
  const found = [];
  walk(parse(html), node => { if (node.tagName === name) found.push(node); });
  return found;
}
const attr = (node, name) => node.attrs.find(a => a.name === name)?.value;

function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

test('published intro video is the exact requested 38-second cut', async () => {
  const bytes = await readFile(resolve(PUBLIC, 'assets/aipster-intro-mix.mp4'));
  assert.equal(bytes.length, 8686991);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EXPECTED_SHA256);
});

test('poster is a JPEG frame extracted from the cut', async () => {
  const bytes = await readFile(resolve(PUBLIC, 'assets/aipster-intro-mix-poster.jpg'));
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes.at(-2), 0xff);
  assert.equal(bytes.at(-1), 0xd9);
  assert.deepEqual(jpegSize(bytes), { width: 1280, height: 720 });
  assert.ok(bytes.length < 10 * 1024 * 1024);
});

test('captions cover the actual voiceover in order', async () => {
  const vtt = await readFile(resolve(PUBLIC, 'assets/aipster-intro-mix.vtt'), 'utf8');
  assert.ok(vtt.startsWith('WEBVTT\n'));
  const blocks = vtt.replace(/^WEBVTT\n+/, '').trim().split(/\n{2,}/);
  const cues = blocks.map(block => {
    const [timing, ...lines] = block.split('\n');
    return { timing, text: lines.join(' ') };
  });
  assert.equal(cues.length, 9);
  let previousEnd = -1;
  for (const cue of cues) {
    const match = /^(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)$/.exec(cue.timing);
    assert.ok(match, `bad cue timing: ${cue.timing}`);
    const start = (+match[1]) * 3600 + (+match[2]) * 60 + (+match[3]) + (+match[4]) / 1000;
    const endt = (+match[5]) * 3600 + (+match[6]) * 60 + (+match[7]) + (+match[8]) / 1000;
    assert.ok(start > previousEnd && endt > start && endt <= 38, `cue order: ${cue.timing}`);
    previousEnd = endt;
  }
  const transcript = cues.map(cue => cue.text).join(' ').replace(/\s+/g, ' ');
  assert.equal(transcript, "They could take your AI away. What if more of that power belonged to us? Our vision for AIPSTER is simple. Your computers in a personal mesh, connected to other people's meshes, sharing compute and GPUs. More control over the intelligence we depend on. Don't let the data centers be the only ones that have the power to compute. AI is for everyone.");
  assert.ok(vtt.includes("Don't let the data centers be the only\nones that have the power to compute."));
});

test('homepage player is user-click, metadata-only and captioned', async () => {
  const html = await readFile(resolve(PUBLIC, 'index.html'), 'utf8');
  const videos = tags(html, 'video');
  assert.equal(videos.length, 1);
  const video = videos[0];
  assert.notEqual(attr(video, 'controls'), undefined);
  assert.equal(attr(video, 'preload'), 'metadata');
  assert.equal(attr(video, 'poster'), '/assets/aipster-intro-mix-poster.jpg');
  assert.equal(attr(video, 'autoplay'), undefined);
  assert.equal(attr(video, 'muted'), undefined);
  assert.notEqual(attr(video, 'playsinline'), undefined);

  const sources = tags(html, 'source').filter(node => attr(node, 'src') === '/assets/aipster-intro-mix.mp4');
  assert.equal(sources.length, 1);
  assert.equal(attr(sources[0], 'type'), 'video/mp4');

  const tracks = tags(html, 'track').filter(node => attr(node, 'src') === '/assets/aipster-intro-mix.vtt');
  assert.equal(tracks.length, 1);
  assert.equal(attr(tracks[0], 'kind'), 'captions');
  assert.equal(attr(tracks[0], 'srclang'), 'en');
  // The cut already has burned-in captions. Keep the accessible track
  // available but off by default so both sets of text do not overlap.
  assert.equal(attr(tracks[0], 'default'), undefined);

  const vtt = await readFile(resolve(PUBLIC, 'assets/aipster-intro-mix.vtt'), 'utf8');
  const transcript = vtt.replace(/^WEBVTT\n+/, '').trim().split(/\n{2,}/)
    .map(block => block.split('\n').slice(1).join(' ')).join(' ').replace(/\s+/g, ' ');
  assert.ok(html.replace(/\s+/g, ' ').includes(transcript), 'visible transcript matches the captions');
});

test('README thumbnail links to the public watch location', async () => {
  const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('website/public/assets/aipster-intro-mix-poster.jpg'));
  assert.ok(readme.includes('https://aipster.net/#hackathon-video'));
  assert.ok(readme.includes('https://aipster.net/assets/aipster-intro-mix.mp4'));
  assert.match(readme.replace(/\s+/g, ' '), /not proof of working live inference/);
});

test('player focus ring is drawn inside the clipping figure', async () => {
  const css = await readFile(resolve(PUBLIC, 'styles.css'), 'utf8');
  assert.match(css, /\.video-feature\{[^}]*overflow:hidden/);
  // Chromium focuses the video's UA controls, so the host matches
  // :focus-within rather than :focus-visible; both selectors are kept.
  assert.match(css, /\.video-feature video:focus-visible,\.video-feature video:focus-within\{outline:3px solid #bd8d30;outline-offset:-3px\}/);
});

test('served media headers declare video, caption and poster types', async () => {
  const headers = await readFile(resolve(PUBLIC, '_headers'), 'utf8');
  assert.match(headers, /\/assets\/aipster-intro-mix\.mp4\s+Content-Type: video\/mp4/);
  assert.match(headers, /\/assets\/aipster-intro-mix\.vtt\s+Content-Type: text\/vtt/);
  assert.match(headers, /\/assets\/aipster-intro-mix-poster\.jpg\s+Content-Type: image\/jpeg/);
  assert.ok(headers.includes('no-transform'));
});
