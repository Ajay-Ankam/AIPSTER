/* Built with Meta Muse. */
// Admin scaffold shell: same-origin reads only. The shell renders whatever
// availability state the server reports and invents no data — an unknown or
// missing field is shown as unknown, never as zero or healthy.
'use strict';

// Presentation only: a status line keeps its exact text and gains a data-tone
// the stylesheet uses to draw it (busy, read, gap, denied or failed).
function stateTone(text) {
  if (/…$/.test(text)) return 'busy';
  if (/(AUTH_REQUIRED|ADMIN_FORBIDDEN)/.test(text)) return 'denied';
  if (/HTTP \d|request failed|^(Refused|Quarantined|Outcome unknown|Cancelled)/.test(text)) return 'error';
  if (/^(Unavailable|state: (?!available\b))/.test(text)) return 'gap';
  if (/^(Authorized|Loaded|Created|Delivered|Attached|Reconciled|Replayed|Ready|state: available)/.test(text)) return 'ok';
  return 'idle';
}

function paintState(el, text) {
  el.textContent = text;
  if (el.setAttribute) el.setAttribute('data-tone', stateTone(text));
}

function paintAuthButtons(authorized) {
  const signin = document.getElementById('signin-github');
  const signout = document.getElementById('signout');
  if (!signin || !signout) return;
  signin.hidden = !!authorized;
  signout.hidden = !authorized;
}

async function loadStatus() {
  const grant = document.getElementById('grant');
  try {
    const res = await fetch('/api/admin/v1/status', { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.grant) {
      paintState(grant, 'Authorized as ' + body.grant.role + ' (scope ' + body.grant.scope + '). '
        + 'Elevation: ' + (body.elevation || 'unknown') + '. Mutations: ' + (body.mutations || 'unknown') + '.');
      paintAuthButtons(true);
    } else if (body && body.code) {
      paintState(grant, 'Not authorized (' + body.code + '). Sign in with an administration grant.');
      paintAuthButtons(false);
    } else {
      paintState(grant, 'Authorization unknown (HTTP ' + res.status + ').');
      paintAuthButtons(false);
    }
  } catch {
    paintState(grant, 'Authorization unknown (request failed).');
    paintAuthButtons(false);
  }
}

async function signInWithGitHub() {
  const grant = document.getElementById('grant');
  try {
    // Same GitHub OAuth entry as the user panel: the server still decides
    // every admin route via its own admin_grants check. OAuth alone grants
    // no administration privilege.
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', callbackURL: origin + '/admin/', errorCallbackURL: origin + '/admin/' }),
    });
    const body = await res.json().catch(() => null);
    const url = body && (body.url || body.redirect);
    if (!res.ok || !url) throw new Error('Sign-in did not return a redirect.');
    if (typeof location !== 'undefined') location.assign(url);
  } catch {
    paintState(grant, 'Sign-in failed (request failed).');
  }
}

async function signOut() {
  const grant = document.getElementById('grant');
  try {
    await fetch('/api/auth/sign-out', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch {
    paintState(grant, 'Sign-out failed (request failed).');
    return;
  }
  loadStatus();
}

// ---- Synthetic demo (fixture rows only; never touches the network) ----
//
// The demo renders hard-coded fixtures into #demo-result and performs no
// fetch: it cannot read real users, hold a grant, mint a credential, or
// bypass backend authorization. Fixture tenants are demo-only and carry no
// exercisable roles.

const DEMO_USERS = [
  { id: 'demo_user_1', name: 'Demo Operator', email: 'demo-1@example.invalid', provider: 'github', status: 'active', tenant: 'demo', admin_roles: [], keys_active: 0 },
  { id: 'demo_user_2', name: 'Demo Support', email: 'demo-2@example.invalid', provider: 'credential', status: 'suspended', tenant: 'demo', admin_roles: [], keys_active: 0 },
];

function enterDemo() {
  const box = document.getElementById('demo-result');
  const exit = document.getElementById('demo-exit');
  const rows = DEMO_USERS.map((it) =>
    '<tr><td class="id">' + esc(it.id) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.email)
    + '</td><td>' + esc(it.provider) + '</td><td>' + statusPill(it.status) + '</td><td>' + esc(it.tenant)
    + '</td><td class="nr">not applicable (demo)</td><td class="num">' + unknown(it.keys_active) + '</td></tr>').join('');
  box.innerHTML = '<p class="banner banner-demo">Synthetic demo — fixture data only. No real users, no privileges, no live requests.</p>'
    + '<table class="tbl"><thead><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr></thead><tbody>' + rows + '</tbody></table>';
  if (exit) exit.hidden = false;
}

function exitDemo() {
  const box = document.getElementById('demo-result');
  const exit = document.getElementById('demo-exit');
  box.innerHTML = '';
  if (exit) exit.hidden = true;
}

async function loadSection(section, endpoint) {
  const state = section.querySelector('.state');
  paintState(state, 'Loading…');
  try {
    const res = await fetch(endpoint, { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      const parts = ['state: ' + (body.state === null || body.state === undefined ? 'unknown' : body.state)];
      if (body.reason_code) parts.push('reason: ' + body.reason_code);
      if (body.metric) parts.push('metric: ' + body.metric);
      if (Array.isArray(body.items)) parts.push('items: ' + body.items.length + ' (total ' + (body.total === null ? 'unknown' : body.total) + ')');
      paintState(state, parts.join(', ') + '.');
    } else if (body && body.code) {
      paintState(state, 'Unavailable: ' + body.code + ' (HTTP ' + res.status + ').');
    } else {
      paintState(state, 'Unavailable: HTTP ' + res.status + '.');
    }
  } catch {
    paintState(state, 'Unavailable: request failed.');
  }
}

document.querySelectorAll('button[data-endpoint]').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.closest('section');
    if (!section) return;
    if (section.id === 'overview') { loadOverview(); return; }
    if (section.id === 'resources') { loadResources(0); return; }
    if (section.id === 'audit') { loadAudit(0); return; }
    if (section.id === 'coverage') { loadCoverage(); return; }
    if (section.id === 'operations') { loadHealth(); return; }
    if (section.id === 'access') { loadUsers(0); loadSessions(0); return; }
    loadSection(section, button.getAttribute('data-endpoint'));
  });
});
document.getElementById('resources-prev').addEventListener('click', () => loadResources(Math.max(0, resourcesOffset - RESOURCES_LIMIT)));
document.getElementById('resources-next').addEventListener('click', () => loadResources(resourcesOffset + RESOURCES_LIMIT));
document.getElementById('audit-prev').addEventListener('click', () => loadAudit(Math.max(0, auditOffset - AUDIT_LIMIT)));
document.getElementById('audit-next').addEventListener('click', () => loadAudit(auditOffset + AUDIT_LIMIT));
document.getElementById('users-prev').addEventListener('click', () => loadUsers(Math.max(0, usersOffset - USERS_LIMIT)));
document.getElementById('users-next').addEventListener('click', () => loadUsers(usersOffset + USERS_LIMIT));
document.getElementById('sessions-prev').addEventListener('click', () => loadSessions(Math.max(0, sessionsOffset - SESSIONS_LIMIT)));
document.getElementById('sessions-next').addEventListener('click', () => loadSessions(sessionsOffset + SESSIONS_LIMIT));
document.getElementById('signin-github').addEventListener('click', () => signInWithGitHub());
document.getElementById('signout').addEventListener('click', () => signOut());
document.getElementById('demo-enter').addEventListener('click', () => enterDemo());
document.getElementById('demo-exit').addEventListener('click', () => exitDemo());

loadStatus();

// ---- Overview / Resources (Milestone 1: real authorized data) ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unknown = (v) => (v === null || v === undefined ? 'unknown' : String(v));
// Presentation helpers: a decorative state shape (the text beside it stays the
// source of truth) and hatched unknown counts, never drawn as zero.
const MARKS = { online: 'online', stale: 'stale', offline: 'offline', unknown: 'unknown' };
const mark = (state) => '<span class="mark mark-' + (MARKS[state] || 'unknown') + '" aria-hidden="true"></span>';
const count = (v) => (v === null || v === undefined ? '<span class="hatch-inline"><span>unknown</span></span>' : esc(v));
const PILLS = { active: 'ok', suspended: 'bad', expired: 'muted', pass: 'ok', fail: 'bad' };
const statusPill = (s) => '<span class="pill pill-' + (PILLS[s] || 'muted') + '">' + esc(s) + '</span>';

function requestFailure(body, status) {
  if (body && body.code) return body.code + ' (HTTP ' + status + ')';
  return 'HTTP ' + status;
}

let overviewSeq = 0;

async function loadOverview() {
  const mySeq = ++overviewSeq;
  const section = document.getElementById('overview');
  const state = section.querySelector('.state');
  const box = document.getElementById('overview-result');
  paintState(state, 'Loading…');
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/overview', { credentials: 'same-origin' });
    if (mySeq !== overviewSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== overviewSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !body.resources) {
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    const r = body.resources;
    box.innerHTML = '<table class="kpi-table"><caption class="sr">Resource counts</caption>'
      + '<tr><th>resources total</th><td>' + count(r.total) + '</td></tr>'
      + '<tr><th>' + mark('online') + 'online</th><td>' + count(r.online) + '</td></tr>'
      + '<tr><th>' + mark('stale') + 'stale</th><td>' + count(r.stale) + '</td></tr>'
      + '<tr><th>' + mark('offline') + 'offline</th><td>' + count(r.offline) + '</td></tr>'
      + '<tr><th>' + mark('unknown') + 'unknown</th><td>' + count(r.unknown) + '</td></tr>'
      + '</table><table class="kv"><caption class="sr">Measurement gaps</caption>'
      + '<tr><th>fabrics</th><td>' + esc(body.fabrics_state || 'unknown')
      + (body.fabrics_reason_code ? ' (' + esc(body.fabrics_reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>usable capacity</th><td>' + esc(body.usable_capacity_state || 'unknown') + '</td></tr>'
      + '<tr><th>coverage</th><td>' + esc(body.coverage_state || 'unknown')
      + (body.coverage_reason_code ? ' (' + esc(body.coverage_reason_code) + ')' : '') + '</td></tr>'
      + '</table>';
  } catch {
    if (mySeq !== overviewSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

let resourcesOffset = 0;
let resourcesSeq = 0;
const RESOURCES_LIMIT = 20;

async function loadResources(offset) {
  const section = document.getElementById('resources');
  const state = section.querySelector('.state');
  const box = document.getElementById('resources-result');
  const pages = document.getElementById('resources-pages');
  const label = document.getElementById('resources-page-label');
  const prev = document.getElementById('resources-prev');
  const next = document.getElementById('resources-next');
  const myOffset = Math.max(0, offset || 0);
  resourcesOffset = myOffset;
  const mySeq = ++resourcesSeq;
  paintState(state, 'Loading…');
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/resources?limit=' + RESOURCES_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== resourcesSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== resourcesSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No resources registered (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td class="id">' + esc(it.id) + '</td><td class="name">' + mark(it.liveness) + esc(it.name) + '</td><td>' + esc(it.kind)
        + '</td><td>' + esc(it.liveness) + '</td><td>' + esc(it.lastSeenAt || 'unknown')
        + '</td><td>' + unknown(it.usable) + '</td><td>' + unknown(it.configured)
        + '</td><td>' + unknown(it.authenticated) + '</td></tr>').join('');
      box.innerHTML = '<table class="tbl"><thead><tr><th>id</th><th>name</th><th>kind</th><th>liveness</th>'
        + '<th>last seen</th><th>usable</th><th>configured</th><th>authenticated</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    // Window bounds and Next come from offset plus limit (echoed when sane,
    // else requested): items.length shrinks when malformed rows skip, so it
    // must never size the window. The displayed count rides along separately.
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : RESOURCES_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== resourcesSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- Audit (read-only projection over stored events) ----
//
// The server owns the projection: it sends only id, a validated action (or
// null), a category and a validated timestamp. This pane renders exactly that
// and never asks for actor, target or detail — it has no field to put them in.

let auditOffset = 0;
let auditSeq = 0;
const AUDIT_LIMIT = 20;

async function loadAudit(offset) {
  const section = document.getElementById('audit');
  const state = section.querySelector('.state');
  const box = document.getElementById('audit-result');
  const pages = document.getElementById('audit-pages');
  const label = document.getElementById('audit-page-label');
  const prev = document.getElementById('audit-prev');
  const next = document.getElementById('audit-next');
  const myOffset = Math.max(0, offset || 0);
  auditOffset = myOffset;
  const mySeq = ++auditSeq;
  paintState(state, 'Loading…');
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/audit?limit=' + AUDIT_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== auditSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== auditSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      // Unavailable is a measurement failure, never an empty feed.
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No audit events recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) => {
        const action = it.action_known && typeof it.action === 'string' ? esc(it.action) : 'unknown';
        const at = it.at_known && typeof it.at === 'string' ? esc(it.at) : 'unknown';
        return '<tr><td class="id">' + esc(it.id) + '</td><td>' + action + '</td><td>'
          + esc(it.category || 'unknown') + '</td><td class="num">' + at + '</td></tr>';
      }).join('');
      box.innerHTML = '<table class="tbl"><thead><tr><th>event</th><th>action</th><th>category</th><th>at</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    // Window bounds come from offset plus limit, never from items.length:
    // rows the server declined to project still occupy a slot in total, and
    // the shortfall is disclosed as "(N shown)".
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : AUDIT_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '–' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== auditSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- Coverage (static truthful release states; no collectors yet) ----

let coverageSeq = 0;

async function loadCoverage() {
  const mySeq = ++coverageSeq;
  const section = document.getElementById('coverage');
  const state = section.querySelector('.state');
  const box = document.getElementById('coverage-result');
  paintState(state, 'Loading…');
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/coverage', { credentials: 'same-origin' });
    if (mySeq !== coverageSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== coverageSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    if (!body.items.length) {
      box.textContent = 'No coverage rows recorded.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td class="id">' + esc(it.metric) + '</td><td><span class="chip">' + esc(it.release_state)
        + '</span></td><td class="id">' + esc(it.reason_code || 'unknown') + '</td><td>' + unknown(it.supported_runtime) + '</td></tr>').join('');
      box.innerHTML = '<table class="tbl"><thead><tr><th>metric</th><th>release state</th><th>reason</th><th>runtime</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
  } catch {
    if (mySeq !== coverageSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- Operations health (read-only probes; nothing here changes infra) ----

let healthSeq = 0;

async function loadHealth() {
  const mySeq = ++healthSeq;
  const section = document.getElementById('operations');
  const state = section.querySelector('.state');
  const box = document.getElementById('operations-result');
  paintState(state, 'Loading…');
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/operations/health', { credentials: 'same-origin' });
    if (mySeq !== healthSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== healthSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !body.control_plane || !body.compatibility) {
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    const c = body.collectors || {};
    box.innerHTML = '<table class="kv">'
      + '<tr><th>control plane (d1)</th><td>' + esc(body.control_plane.d1 || 'unknown') + '</td></tr>'
      + '<tr><th>admin grants table</th><td>' + esc(body.control_plane.admin_grants || 'unknown') + '</td></tr>'
      + '<tr><th>collectors</th><td>' + esc(c.state || 'unknown')
      + (c.reason_code ? ' (' + esc(c.reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>inference</th><td>' + esc(body.compatibility.inference || 'unknown')
      + (body.compatibility.inference_reason_code ? ' (' + esc(body.compatibility.inference_reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>fabric model</th><td>' + esc(body.compatibility.fabric_model || 'unknown') + '</td></tr>'
      + '<tr><th>worker versions</th><td>' + unknown(body.compatibility.worker_versions)
      + ' (' + esc(body.compatibility.worker_versions_state || 'unknown') + ')</td></tr>'
      + '<tr><th>runtime readiness</th><td>' + unknown(body.compatibility.runtime_readiness)
      + ' (' + esc(body.compatibility.runtime_readiness_state || 'unknown') + ')</td></tr>'
      + '<tr><th>dgm preview</th><td>' + esc(body.compatibility.dgm_preview || 'unknown') + '</td></tr>'
      + '</table>';
  } catch {
    if (mySeq !== healthSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- Access directory (minimal identity projection, escaped) ----

let usersOffset = 0;
let usersSeq = 0;
const USERS_LIMIT = 20;

async function loadUsers(offset) {
  const section = document.getElementById('access');
  const state = section.querySelector('.state');
  const box = document.getElementById('users-result');
  const pages = document.getElementById('users-pages');
  const label = document.getElementById('users-page-label');
  const prev = document.getElementById('users-prev');
  const next = document.getElementById('users-next');
  const myOffset = Math.max(0, offset || 0);
  usersOffset = myOffset;
  const mySeq = ++usersSeq;
  paintState(state, 'Loading…');
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/users?limit=' + USERS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== usersSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== usersSeq) return;
    if (!res.ok || !body) {
      paintState(state, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      paintState(state, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    paintState(state, 'Loaded ' + unknown(body.observed_at) + '.');
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No users recorded (empty).' : 'No rows on this page.';
    } else {
      const roleCell = (it) => {
        // null is unknown: a failed read is not "none", and a demo tenant
        // holds no exercisable role even when a row was stored.
        if (!Array.isArray(it.admin_roles)) {
          return it.tenant === 'demo' ? 'not applicable (demo)' : 'unknown';
        }
        return esc(it.admin_roles.join(', ') || 'none');
      };
      const rows = body.items.map((it) =>
        '<tr><td class="id">' + esc(it.id) + '</td><td class="name">' + esc(it.name || 'unknown') + '</td><td>' + esc(it.email || 'unknown')
        + '</td><td>' + esc(it.provider || 'unknown') + '</td><td>' + statusPill(it.status) + '</td><td>' + esc(it.tenant)
        + '</td><td>' + roleCell(it) + '</td><td class="num">' + unknown(it.keys_active) + '</td></tr>').join('');
      box.innerHTML = '<table class="tbl"><thead><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : USERS_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== usersSeq) return;
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- Access sessions (safe refs only; presence honestly unknown) ----

let sessionsOffset = 0;
let sessionsSeq = 0;
const SESSIONS_LIMIT = 20;

async function loadSessions(offset) {
  const state2 = document.getElementById('sessions-state');
  const box = document.getElementById('sessions-result');
  const pages = document.getElementById('sessions-pages');
  const label = document.getElementById('sessions-page-label');
  const prev = document.getElementById('sessions-prev');
  const next = document.getElementById('sessions-next');
  const myOffset = Math.max(0, offset || 0);
  sessionsOffset = myOffset;
  const mySeq = ++sessionsSeq;
  paintState(state2, 'Loading…');
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/sessions?limit=' + SESSIONS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== sessionsSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== sessionsSeq) return;
    if (!res.ok || !body) {
      paintState(state2, 'Unavailable: ' + requestFailure(body, res.status) + '.');
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      paintState(state2, 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').');
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    paintState(state2, 'Loaded ' + unknown(body.observed_at) + '.');
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No sessions recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td class="id">' + esc(it.id) + '</td><td class="id">' + esc(it.user_id || 'unknown') + '</td><td class="num">' + esc(it.issued_at || 'unknown')
        + '</td><td class="num">' + esc(it.expires_at || 'unknown') + '</td><td>' + statusPill(it.active ? 'active' : 'expired')
        + '</td><td>' + esc(it.authentication_method || 'unknown') + '</td><td>' + esc(it.presence) + '</td></tr>').join('');
      box.innerHTML = '<table class="tbl"><thead><tr><th>session</th><th>user</th><th>issued</th><th>expires</th><th>state</th><th>auth method</th><th>presence</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    const effOffset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : myOffset;
    const effLimit = Number.isSafeInteger(body.limit) && body.limit > 0 ? body.limit : SESSIONS_LIMIT;
    if (total !== null && total > 0) {
      const winStart = effOffset + 1;
      const winEnd = Math.min(effOffset + effLimit, total);
      if (winStart > winEnd) {
        label.textContent = 'Rows 0 of ' + total + ' (' + body.items.length + ' shown).';
      } else if (body.items.length < winEnd - winStart + 1) {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + ' (' + body.items.length + ' shown).';
      } else {
        label.textContent = 'Rows ' + winStart + '\u2013' + winEnd + ' of ' + total + '.';
      }
      prev.disabled = effOffset === 0;
      next.disabled = (effOffset + effLimit) >= total;
      pages.hidden = false;
    }
  } catch {
    if (mySeq !== sessionsSeq) return;
    paintState(state2, 'Unavailable: request failed.');
  }
}

// ---- DGM fixture preview (flag-gated; the server authorizes every call) ----

const dgmEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dgmUnknown = (v) => (v === null || v === undefined ? 'unknown' : String(v));

let dgmCurrentRun = null;

async function dgmFetch(path, opts) {
  const init = { credentials: 'same-origin', ...(opts || {}) };
  if (init.method && init.method !== 'GET') {
    init.headers = { 'X-Aipster-CSRF': '1', ...((init.body ? { 'Content-Type': 'application/json' } : {})), ...(init.headers || {}) };
  }
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  return { res, body };
}

function dgmFailure(body, status) {
  if (body && body.code) return body.code + ' (HTTP ' + status + ')';
  return 'HTTP ' + status;
}

async function loadDgmRuns() {
  const box = document.getElementById('dgm-runs');
  box.textContent = 'Loading…';
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs');
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!res.ok || !body || !Array.isArray(body.items)) {
      box.textContent = 'Unavailable: ' + dgmFailure(body, res.status) + '.';
      return;
    }
    if (!body.items.length) {
      box.textContent = 'No preview runs yet (empty).';
      return;
    }
    const list = document.createElement('ul');
    for (const run of body.items) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.setAttribute('href', '#dgm-run-' + run.runId);
      link.textContent = run.runId + ' — ' + run.fixture + ' — ' + run.status + ' / ' + run.envelopeLabel;
      link.addEventListener('click', (event) => {
        if (event && event.preventDefault) event.preventDefault();
        return loadDgmRun(run.runId);
      });
      item.appendChild(link);
      list.appendChild(item);
    }
    box.appendChild(list);
  } catch {
    box.textContent = 'Unavailable: request failed.';
  }
}

async function createDgmRun() {
  const state = document.getElementById('dgm-create-state');
  paintState(state, 'Creating…');
  const fixture = document.getElementById('dgm-fixture').value;
  const held = !!document.getElementById('dgm-held').checked;
  const label = document.getElementById('dgm-label').value || '';
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs', {
      method: 'POST', body: JSON.stringify(label ? { fixture, held, label } : { fixture, held })
    });
    if (res.ok && body) {
      paintState(state, 'Created ' + body.runId + ' (' + body.status + ' / ' + body.envelopeLabel + ').');
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      paintState(state, 'Refused: ' + dgmFailure(body, res.status) + '.');
    }
  } catch {
    paintState(state, 'Refused: request failed.');
  }
}

function dgmDetailHtml(run) {
  const row = (label, value) => '<tr><th>' + dgmEsc(label) + '</th><td>' + value + '</td></tr>';
  const gates = (Array.isArray(run.gates) ? run.gates : []).map((g) =>
    '<tr><td class="id">' + dgmEsc(g.name) + '</td><td>' + statusPill(g.passed ? 'pass' : 'fail') +
    '</td><td>' + dgmEsc(g.evidence) + '</td></tr>').join('');
  const events = (Array.isArray(run.events) ? run.events : []).map((e) =>
    '<tr><td class="num">' + dgmEsc(e.sequence) + '</td><td class="id">' + dgmEsc(e.event) +
    '</td><td>' + dgmEsc(e.detail) + '</td></tr>').join('');
  const telem = run.telemetry || {};
  const latency = telem.latencySummary || {};
  const tokens = telem.tokensSummary || {};
  const prov = run.provenance || {};
  const archive = (Array.isArray(prov.archive) ? prov.archive : []).map((a) =>
    '<tr><td>' + dgmEsc(a.scorePpm) + '</td><td>' + (a.baseline ? 'baseline' : 'candidate (fixture)') + '</td></tr>').join('');
  return '<span id="dgm-run-' + dgmEsc(run.runId) + '"></span>'
    + '<table class="kv">' + row('run', dgmEsc(run.runId)) + row('fixture', dgmEsc(run.fixture) + ' (fixture)')
    + row('evaluation', dgmEsc(run.evaluation)) + row('status', dgmEsc(run.status))
    + row('envelope', dgmEsc(run.envelopeLabel)) + row('label', dgmEsc(run.label || ''))
    + row('advice reason', dgmEsc(run.adviceReason)) + row('settlement', dgmEsc(run.settlement)) + '</table>'
    + '<h3>Readiness gates</h3><table class="tbl"><thead><tr><th>gate</th><th>verdict</th><th>evidence</th></tr></thead><tbody>' + gates + '</tbody></table>'
    + '<h3>Archived candidates (fixture)</h3><table class="tbl"><thead><tr><th>score ppm</th><th>kind</th></tr></thead><tbody>'
    + (archive || '<tr><td colspan="2" class="empty-row">no archived entries (run never settled)</td></tr>') + '</tbody></table>'
    + '<h3>Budget/event trace</h3><table class="tbl"><thead><tr><th>#</th><th>event</th><th>detail</th></tr></thead><tbody>' + events + '</tbody></table>'
    + '<h3>Telemetry (fixture rows, real persistence)</h3><table class="kv">'
    + row('read status', dgmEsc(telem.readStatus) + ' (' + dgmEsc(telem.freshnessNote) + ')')
    + row('outcome counts', dgmEsc(JSON.stringify(telem.outcomeCounts || {})))
    + row('latency', dgmEsc('count=' + dgmUnknown(latency.count)
      + ' p50=' + dgmUnknown(latency.p50_ms) + ' p95=' + dgmUnknown(latency.p95_ms)))
    + row('tokens (estimate)', dgmEsc('prompt=' + dgmUnknown(tokens.prompt_tokens_est)
      + ' completion=' + dgmUnknown(tokens.completion_tokens_est)))
    + '</table>';
}

function dgmControlState(status) {
  document.getElementById('dgm-pause').disabled = status !== 'completed-preview';
  document.getElementById('dgm-resume').disabled = status !== 'paused';
  document.getElementById('dgm-cancel').disabled = status !== 'paused';
}

async function loadDgmRun(runId) {
  const state = document.getElementById('dgm-run-state');
  const detail = document.getElementById('dgm-run-detail');
  paintState(state, 'Loading…');
  detail.innerHTML = '';
  dgmCurrentRun = null;
  dgmControlState(null);
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(runId));
    if (res.ok && body) {
      dgmCurrentRun = body.runId;
      paintState(state, body.runId + ' — ' + body.status + ' / ' + body.envelopeLabel + '.');
      detail.innerHTML = dgmDetailHtml(body);
      dgmControlState(body.status);
    } else {
      paintState(state, 'Unavailable: ' + dgmFailure(body, res.status) + '.');
    }
  } catch {
    paintState(state, 'Unavailable: request failed.');
  }
}

async function dgmControl(action) {
  if (!dgmCurrentRun) return;
  const state = document.getElementById('dgm-run-state');
  paintState(state, 'Loading…');
  try {
    const { res, body } = await dgmFetch(
      '/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(dgmCurrentRun) + '/' + action, { method: 'POST' });
    if (res.ok && body) {
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      paintState(state, 'Refused: ' + dgmFailure(body, res.status) + '.');
    }
  } catch {
    paintState(state, 'Refused: request failed.');
  }
}

document.getElementById('dgm-activity-load').addEventListener('click', loadDgmActivity);
document.getElementById('dgm-self-test-load').addEventListener('click', loadDgmSelfTest);
document.getElementById('dgm-runs-load').addEventListener('click', loadDgmRuns);
document.getElementById('dgm-create').addEventListener('click', createDgmRun);
document.getElementById('dgm-pause').addEventListener('click', () => dgmControl('pause'));
document.getElementById('dgm-resume').addEventListener('click', () => dgmControl('resume'));
document.getElementById('dgm-cancel').addEventListener('click', () => dgmControl('cancel'));

// ---- DGM routing activity (read-only coherent view; no generation, no promotion) ----
//
// Reads the existing authorized endpoints only (preview status/runs/details,
// Muse status) and renders objective, current state, run history with
// before/after metrics, blockers, and budget facts. Fixture ppm scores are
// labeled hardcoded, never measured. Local dry-run reports are not served by
// this API and appear through the local harness, never invented here.
// Promotion history: the website promote/execute routes answer 501, so the
// view states that no promotion history exists instead of showing one.
function dgmActivityState(status) {
  // Nothing here executes: paused is held inspection, never running.
  // Unknown statuses are shown unclassified, never asserted terminal.
  if (status === 'paused') return ['paused', 'held for inspection; no execution in flight'];
  if (status === 'failed') return ['awaiting-review', 'evaluation failed; retained for operator review'];
  if (status === 'completed-preview' || status === 'cancelled' || status === 'validation-rejected') {
    return ['inactive', 'terminal state ' + status];
  }
  return ['unknown', 'unrecognized status; not classified'];
}

function dgmActivityHtml(data) {
  const row = (label, value) => '<tr><th>' + dgmEsc(label) + '</th><td>' + value + '</td></tr>';
  const binding = (data.status && data.status.binding) || {};
  const muse = data.muse || null;
  // Actual muse status shape: {evaluation, provider: {model, configured,
  // endpoint, bounds}, spendCapUsd, spend: {capUsd, reservedUsd, usedUsd,
  // remainingUsd, updatedAt, status}, observedAt}. Never top-level
  // configured/model.
  const museProvider = (muse && muse.provider) || {};
  const museLive = museProvider.configured === true;
  const museSpend = (muse && muse.spend) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const details = new Map();
  for (const d of (Array.isArray(data.details) ? data.details : [])) {
    if (d && d.runId) details.set(d.runId, d);
  }
  let history = '<tr><td colspan="5" class="empty-row">No preview runs yet (empty — nothing is running).</td></tr>';
  if (items.length) {
    history = items.map((it) => {
      const d = details.get(it.runId) || {};
      const prov = d.provenance || {};
      const base = typeof prov.baselineScorePpm === 'number' ? String(prov.baselineScorePpm) : 'unknown';
      const cand = typeof prov.candidateScorePpm === 'number' ? String(prov.candidateScorePpm) : 'unknown (rejected before runner activity)';
      const failed = (Array.isArray(d.gates) ? d.gates : []).filter((g) => g && g.passed === false).map((g) => g.name).join(', ');
      const st = dgmActivityState(it.status);
      return '<tr><td class="id">' + dgmEsc(it.runId) + '</td><td>' + dgmEsc(it.fixture) + '</td><td>'
        + statusPill(st[0]) + ' (' + dgmEsc(it.status + ': ' + st[1]) + ')</td>'
        + '<td class="num">' + dgmEsc(base) + ' → ' + dgmEsc(cand) + ' ppm (fixture, NOT MEASURED)</td>'
        + '<td>' + (failed ? dgmEsc('failed gates: ' + failed) : dgmEsc(dgmUnknown(d.settlement))) + '</td></tr>';
    }).join('');
  }
  const failedRuns = items.filter((it) => it && it.status === 'failed').length;
  const local = data.local || null;
  const localReports = local && Array.isArray(local.reports) ? local.reports.slice(0, 10) : [];
  const localFailures = local && Array.isArray(local.failures) ? local.failures : [];
  let localSection = '<h3>Local dry-run reports</h3><p>Not connected: local reports are not served by this API (pending a read-only harness hook).</p>';
  if (local) {
    const rows = localReports.length ? localReports.map((r) => {
      const held = (side) => (r && r[side] && r[side].heldout) || {};
      const base = held('baseline');
      const cand = held('candidate');
      // Actual report fields: heldout {n, top1Hits}, guardrails [{passed}].
      // Each side renders its own n — never one ambiguous fraction.
      const hits = (h) => (Number.isSafeInteger(h.top1Hits) && Number.isSafeInteger(h.n) ? h.top1Hits + '/' + h.n : 'unknown');
      const guards = Array.isArray(r.guardrails) ? r.guardrails : [];
      const passCount = guards.filter((g) => g && g.passed === true).length;
      const promo = r.promotionEligible === true ? 'eligible-unapproved' : 'ineligible';
      return '<tr><td class="id">' + dgmEsc(String(r.generatedAt || 'undated') + ' / ' + String((r.baseline && r.baseline.policyVersion) || 'unknown')) + '</td><td>'
        + dgmEsc(hits(base) + ' → ' + hits(cand) + ' top-1 (measured-synthetic, NOT fabric quality)') + '</td><td>'
        + dgmEsc(String(r.outcome) + '; guardrails ' + passCount + '/' + guards.length) + '</td><td>'
        + dgmEsc(promo + '; human approval required') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty-row">No local reports on this host (empty).</td></tr>';
    const dropped = localFailures.length
      ? '<p>Dropped unreadable reports: ' + dgmEsc(localFailures.map((f) => (f && f.code) || 'unknown').join(', ')) + ' (never rendered).</p>'
      : '';
    localSection = '<h3>Local dry-run reports (this host only)</h3><table class="tbl"><thead><tr><th>report</th><th>baseline → candidate</th><th>outcome</th><th>promotion</th></tr></thead><tbody>'
      + rows + '</tbody></table>' + dropped + dgmCeilingHtml(local.ceiling);
  }
  const blockers = [];
  if (binding.state && binding.state !== 'active') blockers.push('preview binding is not active; runs cannot start');
  if (muse && !museLive) blockers.push('Meta provider not configured: proposals answer fixture-only, never live');
  if (failedRuns > 0) blockers.push(failedRuns + ' failed preview run(s) retained above');
  const spendRows = !muse ? row('spend ledger', 'unknown (status unavailable)')
    : museSpend.status === 'store-not-migrated' ? row('spend ledger', 'unavailable: store not migrated')
    : museSpend.status === 'uninitialised' ? row('spend ledger', 'no admission recorded yet (cap ' + dgmEsc(museUsd(museSpend.capUsd)) + ')')
    : row('spend cap', dgmEsc(museUsd(museSpend.capUsd)))
      + row('reserved (admission bound, not a bill)', dgmEsc(museUsd(museSpend.reservedUsd)))
      + row('used (delivered usage only, lower bound)', dgmEsc(museUsd(museSpend.usedUsd)))
      + row('remaining', dgmEsc(museUsd(museSpend.remainingUsd)))
      + row('ledger updated', dgmEsc(dgmUnknown(museSpend.updatedAt)));
  return '<h3>Objective</h3><p>Bounded routing-improvement experiments: one frozen baseline versus one restricted candidate over synthetic routing decisions, human promotion only. No production execution, no autonomous loop.</p>'
    + '<h3>Current state</h3><table class="kv">'
    + row('preview binding', dgmEsc(dgmUnknown(binding.state)))
    + row('provider', muse ? dgmEsc((museLive ? 'configured live' : 'fixture-only') + ' — ' + dgmUnknown(museProvider.model)) : 'unknown (status unavailable)')
    + row('reported evaluation', dgmEsc(dgmUnknown(muse && muse.evaluation)))
    + row('observed at', dgmEsc(dgmUnknown((data.status && data.status.observedAt) || (muse && muse.observedAt))))
    + row('runs on record', Number.isSafeInteger(data.total) && data.total >= 0
      ? dgmEsc(data.total + ' total (showing first ' + items.length + ')')
      : dgmEsc('unknown total (showing ' + items.length + ' first-page rows)'))
    + row('promotion', 'disabled: website promote/execute answer 501; no promotion history exists')
    + '</table>'
    + '<h3>Budget (persisted aggregate ledger)</h3><table class="kv">' + spendRows + '</table>'
    + '<h3>History (before → after, source-labeled)</h3><table class="tbl"><thead><tr><th>run</th><th>fixture</th><th>state</th><th>baseline → candidate</th><th>retained failure</th></tr></thead><tbody>'
    + history + '</tbody></table>'
    + localSection
    // "No blockers" is never bare: proposal operations are not read by this
    // view (no ops-list route exists), so the caveat always travels with it.
    + '<h3>Blockers</h3>' + (blockers.length
      ? '<ul>' + blockers.map((b) => '<li>' + dgmEsc(b) + '</li>').join('') + '</ul>'
        + '<p>Proposal operations: not listed by this API; inspect keys individually in the Muse panel.</p>'
      : local
        ? '<p>No blockers in the sources read here. Proposal operations: not listed by this API; inspect keys individually in the Muse panel.</p>'
        : '<p>No blockers in the sources read here. Proposal operations: not listed by this API; inspect keys individually in the Muse panel. Local dry-run reports are not connected: they are not served by this API (pending a read-only harness hook).</p>');
}

// ---- DGM self-test and routing-weights rendering (statistics only; nothing to set) ----
//
// Operator vocabulary: "current weights" are the live route/v1 scoring
// weights; "best alternative" is the best of every allowlisted weight setting
// the self-test tried; a "score" is correct first choices on the fixed
// synthetic routing cases (never fabric quality). Internal outcome labels
// (tie-archived, regression) never reach the page. Every string is escaped.
const DGM_WEIGHT_KEYS = ['EXACT_TOKEN', 'ONLINE', 'FRESHNESS_MAX', 'OWNED', 'HEADROOM'];
const dgmPill = (tone, text) => '<span class="pill pill-' + (tone === 'ok' || tone === 'bad' ? tone : 'muted') + '">' + dgmEsc(text) + '</span>';
const dgmInt = (v) => (Number.isSafeInteger(v) ? String(v) : 'unknown');
// 'YYYY-MM-DD HH:MM UTC' from an ISO instant; never a locale guess, never wraps.
function dgmWhen(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return 'unknown time';
  const s = new Date(ms).toISOString();
  return s.slice(0, 10) + ' ' + s.slice(11, 16) + ' UTC';
}
function dgmAgo(ms, nowMs) {
  const d = nowMs - ms;
  if (!Number.isFinite(d) || d < 60000) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60000) + ' min ago';
  if (d < 48 * 3600e3) return Math.floor(d / 3600e3) + ' h ago';
  return Math.floor(d / 86400e3) + ' days ago';
}
// Panels grouped under a collapsed <details> still open from a rail link.
function dgmRevealHash() {
  if (typeof location === 'undefined' || !location || typeof document.getElementById !== 'function') return;
  const id = String(location.hash || '').slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (!target || typeof target.closest !== 'function') return;
  let group = target.closest('details');
  while (group) {
    group.open = true;
    group = group.parentElement && typeof group.parentElement.closest === 'function' ? group.parentElement.closest('details') : null;
  }
}
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', dgmRevealHash);
  dgmRevealHash();
}

// Current weights against the best alternative the self-test tried. Input is
// the ceiling-summary shape (local hook) or dgmSnapshotCeiling(snapshot).
// Only an explicit boolean says whether a better setting exists.
function dgmCeilingHtml(c) {
  const head = '<h3>Routing weights: current vs best alternative tried</h3>';
  if (!c || typeof c !== 'object') return '';
  if (c.state !== 'computed') {
    return head + '<p>Not available' + (c.code ? ' (' + dgmEsc(c.code) + ')' : '') + '.</p>';
  }
  const counts = c.counts || {};
  const best = c.best && typeof c.best === 'object' ? c.best : null;
  const score = (v) => dgmInt(v) + '/' + dgmInt(c.heldoutN);
  const cur = c.baselineHeldoutTop1;
  const top = best ? best.heldoutTop1 : null;
  let verdict;
  if (c.proposalCanImprove === true) {
    verdict = dgmInt(counts.improvement) + ' of ' + dgmInt(c.evaluated) + ' alternative settings would beat the current weights (best scores '
      + score(top) + ' against ' + score(cur) + '). Review in the DGM lane before any change; nothing is applied automatically.';
  } else if (c.proposalCanImprove === false) {
    const rel = Number.isSafeInteger(top) && Number.isSafeInteger(cur) && top < cur ? 'scores ' + score(top) + ' against ' + score(cur) + ', lower' : 'ties at ' + score(top) + ' against ' + score(cur);
    verdict = 'None of the ' + dgmInt(c.evaluated) + ' alternative settings beats the current weights: the best alternative ' + rel + '. Nothing to change.';
  } else {
    verdict = 'Whether any alternative setting would do better is unknown.';
  }
  const breakdown = 'Of the alternatives tried: ' + dgmInt(counts.improvement) + ' better, ' + dgmInt(counts['tie-archived']) + ' tie, '
    + dgmInt(counts.regression) + ' worse. A score is correct first choices on ' + dgmInt(c.heldoutN) + ' synthetic routing cases; not a fabric-quality measurement.';
  const vars = best && Array.isArray(best.variables) ? best.variables.slice(0, 10) : [];
  const diff = (v) => {
    if (!Number.isSafeInteger(v.baseline) || !Number.isSafeInteger(v.best)) return 'unknown';
    const d = v.best - v.baseline;
    return d === 0 ? 'no change' : (d > 0 ? '+' : '-') + Math.abs(d);
  };
  const rows = vars.length ? vars.map((v) => '<tr><td class="name">' + dgmEsc(v && v.name) + '</td><td class="num">' + dgmEsc(dgmInt(v && v.baseline))
    + '</td><td class="num">' + dgmEsc(dgmInt(v && v.best)) + '</td><td>' + dgmEsc(diff(v || {})) + '</td></tr>').join('')
    : '<tr><td colspan="4" class="empty-row">No alternative evaluated.</td></tr>';
  return head + '<p>' + dgmEsc(verdict) + '</p><p class="note">' + dgmEsc(breakdown) + '</p>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>weight</th><th>current</th><th>best alternative</th><th>difference</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<p class="note">The live weights are not changed by this test.</p>';
}

// What the best alternative's weights did between two completed runs.
function dgmWeightChanges(snap, prevSnap) {
  const w = snap && snap.best && snap.best.weights && typeof snap.best.weights === 'object' ? snap.best.weights : null;
  const p = prevSnap && prevSnap.best && prevSnap.best.weights && typeof prevSnap.best.weights === 'object' ? prevSnap.best.weights : null;
  if (!w || !p) return 'unknown';
  const moved = DGM_WEIGHT_KEYS.filter((k) => Number.isSafeInteger(w[k]) && Number.isSafeInteger(p[k]) && w[k] !== p[k])
    .map((k) => k + ' ' + p[k] + '→' + w[k]);
  return moved.length ? moved.join('; ') : 'none';
}

// One run's result for operators. prevSnap is the previous COMPLETED run's
// snapshot (failed rows are skipped), so a regression is a real drop in the
// current weights' score between two valid evaluations.
function dgmRunResult(e, snap, prevSnap) {
  if (e && e.state === 'failed') return { tone: 'bad', label: 'failed: ' + String(e.code || 'unknown') };
  if (!snap) return { tone: 'muted', label: 'no result' };
  const guards = Array.isArray(snap.guardrails) ? snap.guardrails : [];
  if (!guards.length || !guards.every((g) => g && g.passed === true)) return { tone: 'bad', label: 'checks failed' };
  const cur = snap.baseline && Number.isSafeInteger(snap.baseline.heldoutTop1) ? snap.baseline.heldoutTop1 : null;
  const prev = prevSnap && prevSnap.baseline && Number.isSafeInteger(prevSnap.baseline.heldoutTop1) ? prevSnap.baseline.heldoutTop1 : null;
  if (cur !== null && prev !== null && cur < prev) return { tone: 'bad', label: 'policy regressed' };
  if (snap.proposalCanImprove === true) return { tone: 'muted', label: 'better weights available' };
  if (cur !== null && prev !== null && cur > prev) return { tone: 'ok', label: 'policy improved' };
  return { tone: 'ok', label: 'healthy' };
}

// Run history (newest first): one row per run with the live-routing columns
// that can move day to day beside the deterministic policy score.
function dgmSelfTestHtml(api) {
  const head = '<h3>Run history (newest first)</h3>';
  if (!api || typeof api !== 'object') return head + '<p>Unavailable: self-test history could not be read.</p>';
  const entries = Array.isArray(api.runs) ? api.runs.slice(0, 30) : [];
  if (!entries.length) return head + '<p>No self-test runs yet.</p>';
  const nowMs = Number.isFinite(Date.parse(api.observedAt)) ? Date.parse(api.observedAt) : Date.now();
  const snapOf = (e) => (e && e.state === 'completed' && e.snapshot && typeof e.snapshot === 'object' ? e.snapshot : null);
  const pc = (v) => (typeof v === 'number' && Number.isFinite(v) ? v + '%' : '–');
  const rows = entries.map((e, i) => {
    const snap = snapOf(e);
    let prevSnap = null;
    for (let j = i + 1; j < entries.length; j++) { prevSnap = snapOf(entries[j]); if (prevSnap) break; }
    const hn = snap && snap.workload ? snap.workload.heldoutN : null;
    const score = (v) => (Number.isSafeInteger(v) && Number.isSafeInteger(hn) ? v + '/' + hn : 'unknown');
    const res = dgmRunResult(e, snap, prevSnap);
    const changed = !snap ? 'unknown' : !prevSnap ? 'no earlier completed run' : dgmWeightChanges(snap, prevSnap);
    const r = e && e.routing && typeof e.routing === 'object' ? e.routing : null;
    const decisions = r && Number.isSafeInteger(r.decisions) ? String(r.decisions) + (r.truncated ? '+' : '') : (r && r.state === 'failed' ? 'failed' : 'none');
    const agree = r && r.agreement ? pc(r.agreement.top1AgreeRate) : '–';
    const fallback = r && r.rates ? pc(r.rates.fallbackPct) : '–';
    return '<tr><td class="id">' + dgmEsc(dgmWhen(e && e.ranAt)) + '</td><td>' + dgmEsc(String((e && e.trigger) || 'unknown')) + '</td><td>' + dgmPill(res.tone, res.label)
      + '</td><td class="num">' + dgmEsc(snap ? score(snap.baseline && snap.baseline.heldoutTop1) : 'unknown')
      + '</td><td class="num">' + dgmEsc(snap ? score(snap.best && snap.best.heldoutTop1) : 'unknown')
      + '</td><td>' + dgmEsc(changed) + '</td><td class="num">' + dgmEsc(decisions) + '</td><td class="num">' + dgmEsc(agree) + '</td><td class="num">' + dgmEsc(fallback) + '</td></tr>';
  }).join('');
  let fresh = 'Last run: unknown.';
  const newest = entries[0] && entries[0].ranAt ? Date.parse(entries[0].ranAt) : NaN;
  if (Number.isFinite(newest)) {
    const stale = nowMs - newest > 26 * 3600e3;
    fresh = 'Last run: ' + dgmAgo(newest, nowMs) + (stale ? ' — stale (>26 h): a daily run is overdue.' : '.');
  }
  return head + '<p>' + dgmEsc(fresh) + '</p>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>run (UTC)</th><th>trigger</th><th>result</th><th>current weights score</th><th>best alternative score</th>'
    + '<th>best alternative changed since previous run</th><th>decisions, prior 24 h</th><th>agree with deterministic choice</th><th>fallback share</th></tr></thead><tbody>'
    + rows + '</tbody></table></div>';
}

// Latest snapshot rendered through the same weights block the local hook
// uses (eval-core snapshot -> ceiling-summary shape).
function dgmSnapshotCeiling(snap) {
  if (!snap || typeof snap !== 'object') return { state: 'unavailable' };
  const base = snap.baseline && typeof snap.baseline === 'object' ? snap.baseline : {};
  const wl = snap.workload && typeof snap.workload === 'object' ? snap.workload : {};
  const best = snap.best && typeof snap.best === 'object' ? snap.best : null;
  return {
    state: 'computed', ceiling: snap.ceiling, proposalCanImprove: snap.proposalCanImprove,
    evaluated: snap.evaluated, counts: snap.counts, baselineHeldoutTop1: base.heldoutTop1, heldoutN: wl.heldoutN,
    best: best ? { outcome: best.outcome, heldoutTop1: best.heldoutTop1, variables: Array.isArray(snap.variables) ? snap.variables : [] } : null,
  };
}

// Live routing aggregate stored with the run: the figures that move with
// real traffic. Zero traffic is said plainly, never shown as zeros.
function dgmRoutingHtml(r, hours) {
  const head = '<h3>Live routing in the ' + dgmEsc(dgmInt(hours)) + ' hours before the latest run</h3>';
  if (!r || typeof r !== 'object') return head + '<p>No routing statistics were recorded with this run.</p>';
  if (r.state === 'failed') return head + '<p>Not available: reading routing telemetry failed (' + dgmEsc(String(r.code || 'unknown')) + ').</p>';
  if (r.store === 'not-migrated') return head + '<p>Not available: the routing ledger is not migrated on this deployment.</p>';
  if (!Number.isSafeInteger(r.decisions) || r.decisions === 0) {
    return head + '<p>No routing decisions were made in that window, so there are no live statistics yet. These figures start moving once the site routes real requests.</p>';
  }
  const tile = (label, value, sub) => '<div class="tile"><span class="tile-label">' + dgmEsc(label) + '</span><b>' + dgmEsc(value) + '</b><span class="tile-sub">' + dgmEsc(sub) + '</span></div>';
  const rates = r.rates || {}; const a = r.advice || {}; const ag = r.agreement || {}; const c = r.cache || {}; const d = r.decisionMs || {}; const fc = r.failureCodes || {};
  const pc = (v) => (typeof v === 'number' && Number.isFinite(v) ? v + '%' : 'n/a');
  const lat = a.latencyMs && typeof a.latencyMs === 'object' ? a.latencyMs : {};
  const served = 'served by model advice ' + pc(rates.advicePct) + ', cache ' + pc(rates.cachedPct) + ', deterministic fallback ' + pc(rates.fallbackPct);
  const tiles = [
    tile('routing decisions', dgmInt(r.decisions) + (r.truncated ? '+' : ''), r.truncated ? 'newest ' + dgmInt(r.rowCap) + ' of more; the figures are a sample' : served),
    tile('agree with deterministic choice', pc(ag.top1AgreeRate), dgmInt(ag.top1Agree) + ' of ' + dgmInt(ag.known) + ' served first choices matched route/v1'),
    tile('advice calls', dgmInt(a.attempted), dgmInt(a.completed) + ' completed, ' + dgmInt(a.failed) + ' failed; median ' + (Number.isFinite(lat.p50) ? lat.p50 + ' ms' : 'n/a')),
    tile('advice spend (estimated)', typeof a.spendUsdEst === 'number' && Number.isFinite(a.spendUsdEst) ? '$' + a.spendUsdEst.toFixed(4) : 'n/a', dgmInt(a.inputTokens) + ' in / ' + dgmInt(a.outputTokens) + ' out tokens'),
    tile('cache hit rate', pc(c.hitRate), dgmInt(c.hit) + ' fresh, ' + dgmInt(c.staleHit) + ' stale, ' + dgmInt(c.miss) + ' miss'),
    tile('decision time', Number.isFinite(d.p50) ? d.p50 + ' ms median' : 'n/a', Number.isFinite(d.p95) ? 'p95 ' + d.p95 + ' ms over ' + dgmInt(d.n) + ' live-clock decisions' : 'no live-clock decisions'),
  ];
  const codes = Object.keys(fc).slice(0, 10).map((k) => k + ' ' + dgmInt(fc[k])).join(', ');
  const failures = codes ? '<p class="note">' + dgmEsc('Decision failure codes: ' + codes + '.') + '</p>' : '<p class="note">No decision failures recorded.</p>';
  const win = r.window && typeof r.window.from === 'string' ? '<p class="note">' + dgmEsc('Window: ' + dgmWhen(r.window.from) + ' to ' + dgmWhen(r.window.to) + '.') + '</p>' : '';
  return head + '<div class="tiles">' + tiles.join('') + '</div>' + failures + win;
}

function dgmSelfTestPanelHtml(api) {
  if (!api || typeof api !== 'object' || !Array.isArray(api.runs)) return '<p>Unavailable: self-test history could not be read.</p>';
  if (api.store === 'not-migrated') return '<p>Unavailable: the self-test store is not migrated on this deployment (migration 0031).</p>';
  const runs = api.runs;
  const snapOf = (e) => (e && e.state === 'completed' && e.snapshot && typeof e.snapshot === 'object' ? e.snapshot : null);
  const nowMs = Number.isFinite(Date.parse(api.observedAt)) ? Date.parse(api.observedAt) : Date.now();
  const newest = runs[0] || null;
  const latestIdx = runs.findIndex((e) => snapOf(e));
  const latestEntry = latestIdx >= 0 ? runs[latestIdx] : null;
  const latest = latestEntry ? latestEntry.snapshot : null;
  let prev = null;
  for (let j = latestIdx + 1; latestIdx >= 0 && j < runs.length; j++) { prev = snapOf(runs[j]); if (prev) break; }
  let headline;
  if (!newest) {
    headline = '<p class="headline">' + dgmPill('muted', 'no runs yet') + ' ' + dgmEsc('The daily self-test has not recorded a run on this deployment.') + '</p>';
  } else {
    const res = dgmRunResult(latestEntry || newest, latest, prev);
    const hn = latest && latest.workload ? latest.workload.heldoutN : null;
    const score = (v) => (Number.isSafeInteger(v) && Number.isSafeInteger(hn) ? v + '/' + hn : 'unknown');
    let sentence;
    if (!latest) {
      sentence = 'No completed run yet; the newest run failed (' + String(newest.code || 'unknown') + ').';
    } else {
      const cur = latest.baseline ? latest.baseline.heldoutTop1 : null;
      const bestScore = latest.best ? latest.best.heldoutTop1 : null;
      const prevScore = prev && prev.baseline ? prev.baseline.heldoutTop1 : null;
      sentence = 'Checked ' + dgmWhen(latestEntry.ranAt) + ': the current routing weights scored ' + score(cur) + ' on the synthetic routing test';
      if (res.label === 'policy regressed') sentence += ', down from ' + score(prevScore) + ' at the previous run. The routing policy regressed; review the last policy change.';
      else if (res.label === 'policy improved') sentence += ', up from ' + score(prevScore) + ' at the previous run.';
      else if (res.label === 'better weights available') sentence += '; ' + dgmInt(latest.counts && latest.counts.improvement) + ' of ' + dgmInt(latest.evaluated) + ' alternative settings scored higher (best ' + score(bestScore) + '). Review before any change; nothing is applied automatically.';
      else if (res.label === 'healthy') sentence += '; the best of ' + dgmInt(latest.evaluated) + ' alternative settings also scored ' + score(bestScore) + ', so there is nothing to change.';
      else sentence += '.';
    }
    headline = '<p class="headline">' + dgmPill(res.tone, res.label) + ' ' + dgmEsc(sentence) + '</p>';
    if (latestEntry && newest !== latestEntry) {
      headline += '<p class="banner">' + dgmEsc('The newest run (' + dgmWhen(newest.ranAt) + ') failed (' + String(newest.code || 'unknown') + '); the figures below are from the last completed run (' + dgmWhen(latestEntry.ranAt) + ').') + '</p>';
    }
  }
  // Missed-run notice from the server's own clock and schedule: a cron that
  // is killed (CPU limit) writes no row, so absence has to be computed.
  let missed = '';
  const expMs = Date.parse(api.expectedRunAt);
  if (api.enabled === true && Number.isFinite(expMs) && nowMs > expMs + 2 * 3600e3) {
    const newestMs = newest ? Date.parse(newest.ranAt) : NaN;
    if (!(Number.isFinite(newestMs) && newestMs >= expMs - 5 * 60e3)) {
      missed = '<p class="banner">' + dgmEsc('A run was expected at ' + dgmWhen(api.expectedRunAt) + ' but none was recorded: the cron did not complete. Check the Workers plan CPU limit and the deployment log.') + '</p>';
    }
  }
  // '15 3 * * * UTC' reads as 'daily at 03:15 UTC'; anything else is shown as given.
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* \*(?: UTC)?$/.exec(String(api.schedule || ''));
  const when = cron ? 'daily at ' + String(cron[2]).padStart(2, '0') + ':' + String(cron[1]).padStart(2, '0') + ' UTC' : String(api.schedule || 'unknown');
  const sched = '<p class="note">' + dgmEsc('Schedule: ' + when + (api.enabled !== true ? ' (not enabled: the cron runs only when DGM_SELF_TEST_ENABLED=1)' : '')
    + '. The policy check is deterministic and synthetic: no model calls, no spend, not fabric quality.') + '</p>';
  const hours = Number.isSafeInteger(api.telemetryWindowHours) ? api.telemetryWindowHours : 24;
  const routing = latestEntry ? dgmRoutingHtml(latestEntry.routing, hours) : '';
  return headline + missed + sched + routing + (latest ? dgmCeilingHtml(dgmSnapshotCeiling(latest)) : '') + dgmSelfTestHtml(api);
}

async function loadDgmSelfTest() {
  const state = document.getElementById('dgm-self-test-state');
  const box = document.getElementById('dgm-self-test-result');
  paintState(state, 'Loading…');
  box.innerHTML = '';
  try {
    const r = await dgmFetch('/api/admin/v1/dgm/self-test');
    if (!r.res.ok || !r.body) {
      paintState(state, 'Unavailable: ' + dgmFailure(r.body, r.res.status) + '.');
      return;
    }
    box.innerHTML = dgmSelfTestPanelHtml(r.body);
    const n = Array.isArray(r.body.runs) ? r.body.runs.length : 0;
    paintState(state, n ? ('Loaded ' + n + ' run(s). Read-only.') : 'Loaded. No runs yet (empty).');
  } catch {
    paintState(state, 'Unavailable: request failed.');
  }
}

async function loadDgmActivity() {
  const state = document.getElementById('dgm-activity-state');
  const box = document.getElementById('dgm-activity-result');
  paintState(state, 'Loading…');
  box.innerHTML = '';
  try {
    const st = await dgmFetch('/api/admin/v1/dgm/preview/status');
    const runs = await dgmFetch('/api/admin/v1/dgm/preview/runs');
    const muse = await dgmFetch(MUSE_BASE + '/status');
    if (!st.res.ok || !runs.res.ok || !st.body || !runs.body || !Array.isArray(runs.body.items)) {
      paintState(state, 'Unavailable: ' + dgmFailure(runs.body, runs.res.status) + '.');
      return;
    }
    const items = runs.body.items.slice(0, 10);
    const details = [];
    for (const it of items) {
      if (!it || !it.runId) continue;
      const d = await dgmFetch('/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(it.runId));
      if (d.res.ok && d.body) details.push(d.body);
    }
    // Optional local hook (verifier-owned): local dry-run reports are NOT
    // served by the hosted API. This relative fetch only succeeds where a
    // local harness serves /_local/* (loopback service); everywhere else it
    // 404s and renders as not-connected, never as data. No literal loopback
    // host appears here: the public-asset privacy gate forbids it, and a
    // same-origin relative URL needs none.
    let local = null;
    try {
      const lr = await dgmFetch('/_local/dgm-activity');
      if (lr.res.ok && lr.body && Array.isArray(lr.body.reports)) local = lr.body;
    } catch {
      local = null;
    }
    box.innerHTML = dgmActivityHtml({
      status: st.body, items, total: runs.body.total,
      details, muse: muse.res.ok ? muse.body : null, local,
    });
    paintState(state, items.length ? ('Loaded ' + items.length + ' run(s). Read-only.') : 'Loaded. No preview runs yet (empty).');
  } catch {
    paintState(state, 'Unavailable: request failed.');
  }
}

// ---- DGM Muse proposal (dark slice; the server authorizes and gates every call) ----
//
// This panel spends authority, never claims it. It reads the server's Muse
// status and renders exactly what the server reports: which prerequisites are
// missing, whether live generation is configured, and the aggregate ledger.
// Generating is an explicit operator click, one request per click, with a
// client-held operation key. Nothing is generated on load, polling, refresh,
// rerender or retry. Uncertain outcomes are inspect/reconcile states: the
// panel keeps the key, never resubmits with a new one, and never invents a
// provider result. The fixed fixture table remains the only evaluator; attach
// merely links a delivered proposal to it after the server verifies delivery.

const MUSE_BASE = '/api/admin/v1/dgm/preview/muse';
const MUSE_FIXTURE_RUNS = '/api/admin/v1/dgm/preview/runs';
const MUSE_OP_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

let museSeq = 0;          // status request ordering
let museOpSeq = 0;        // inspect request ordering only (reads)
let museReceiptSeq = 0;   // a settled generation/reconcile receipt (writes)
let museLastReceiptKey = '';
let museAuthorized = false;
let museStatusBody = null;
let museBusy = false;     // one generation/attach at a time
let museBlocked = false;  // quarantine state the server reported
let museCurrent = null;   // result bound to one operation key
let museAttachKey = null; // key captured when the rendered result was drawn

function museSetState(id, text) {
  const el = document.getElementById(id);
  if (el) paintState(el, text);
}

function museUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) ? '$' + value.toFixed(6) : 'unknown';
}

function museCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';
}

function museFailure(code, status) {
  // The server's operator codes and HTTP status only: never a raw error body,
  // provider message or stack trace.
  if (code) return code + ' (HTTP ' + status + ')';
  return 'HTTP ' + status;
}

function museStoreAvailable() {
  return !!(museStatusBody && museStatusBody.spend && museStatusBody.spend.status !== 'store-not-migrated');
}

function museLiveConfigured() {
  return !!(museStatusBody && museStatusBody.provider && museStatusBody.provider.configured === true);
}

function museLiveBudget() {
  return !!(museStatusBody && Number(museStatusBody.spendCapUsd) > 0);
}

function museMode() {
  const el = document.getElementById('dgm-muse-mode');
  return el && el.value ? String(el.value) : 'fixture';
}

function museSyncControls() {
  const generate = document.getElementById('dgm-muse-generate');
  const liveOption = document.getElementById('dgm-muse-mode-live');
  if (liveOption) liveOption.disabled = !museLiveConfigured();
  if (generate) {
    generate.disabled = !museAuthorized || museBusy || museBlocked
      || !museStoreAvailable() || (museMode() === 'live' && !museLiveConfigured());
  }
  const ack = document.getElementById('dgm-muse-ack');
  const reconcile = document.getElementById('dgm-muse-reconcile-submit');
  if (reconcile) reconcile.disabled = museBusy || !museCurrent || !ack || ack.checked !== true;
}

function musePrerequisites(body) {
  const missing = [];
  if (!Array.isArray(body.modes) || !body.modes.includes('fixture')) missing.push('server does not report a fixture mode');
  if (!body.spend || body.spend.status === 'store-not-migrated') {
    missing.push('proposal store not migrated (DGM Muse migrations 0026–0028)');
  }
  if (!museLiveConfigured()) {
    missing.push('live generation disabled (DGM_MUSE_LIVE and the server-side key are not both configured)');
  }
  if (!museLiveBudget()) {
    missing.push('live budget unset (DGM_MUSE_SPEND_CAP_USD is zero or missing)');
  }
  missing.push('write grant (admin.engineering.assign) is checked by the server on every generation; this view does not claim it');
  return missing;
}

function museRenderStatus(body) {
  const box = document.getElementById('dgm-muse-status');
  const provider = body.provider || {};
  const spend = body.spend || {};
  const row = (label, value) => '<tr><th>' + esc(label) + '</th><td>' + value + '</td></tr>';
  const spendRows = spend.status === 'store-not-migrated'
    ? row('spend ledger', 'unavailable: store not migrated')
    : spend.status === 'uninitialised'
      ? row('spend ledger', 'no admission recorded yet (cap ' + esc(museUsd(spend.capUsd)) + ')')
      : row('spend cap', esc(museUsd(spend.capUsd)))
        + row('reserved (admission bound)', esc(museUsd(spend.reservedUsd)))
        + row('used (delivered usage, lower bound)', esc(museUsd(spend.usedUsd)))
        + row('remaining', esc(museUsd(spend.remainingUsd)))
        + row('ledger updated', esc(spend.updatedAt || 'unknown'));
  const missing = musePrerequisites(body).map((m) => '<li>' + esc(m) + '</li>').join('');
  if (box) {
    box.innerHTML = '<table class="kv">'
      + row('model', esc(provider.model || 'unknown'))
      + row('provider configured', museLiveConfigured() ? 'yes (synthetic-live)' : 'no (fixture only)')
      + row('reported evaluation', esc(body.evaluation || 'unknown'))
      + row('endpoint', esc(((provider.endpoint || {}).host || 'unknown') + ((provider.endpoint || {}).path || '')))
      + row('prompt bound', museCount((provider.bounds || {}).promptMaxBytes) + ' bytes')
      + row('output bound', museCount((provider.bounds || {}).outputMaxTokens) + ' tokens / deadline '
        + museCount((provider.bounds || {}).deadlineMs) + ' ms')
      + spendRows
      + '</table><h3>Missing prerequisites</h3><ul class="checklist">' + missing + '</ul>'
      + '<p class="note">A fixture dry run performs no provider call and cannot incur spend. Live mode stays disabled unless the server reports it configured.</p>';
  }
  museSetState('dgm-muse-state', 'Loaded ' + unknown(body.observedAt) + '.');
}

async function loadDgmMuse() {
  const mySeq = ++museSeq;
  museSetState('dgm-muse-state', 'Loading…');
  const box = document.getElementById('dgm-muse-status');
  if (box) box.textContent = '';
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/status');
    if (mySeq !== museSeq) return; // a newer load superseded this response
    if (!res.ok || !body) {
      museAuthorized = false;
      museStatusBody = null;
      museSetState('dgm-muse-state', 'Unavailable: ' + museFailure(body && body.code, res.status) + '. No generation is offered.');
      museSyncControls();
      return;
    }
    museAuthorized = true;
    museStatusBody = body;
    museRenderStatus(body);
    // Replace the initial placeholder only; never overwrite a result message.
    const genState = document.getElementById('dgm-muse-gen-state');
    if (genState && genState.textContent === 'Load Muse status first.') {
      museSetState('dgm-muse-gen-state', 'Ready: status loaded. One click sends at most one request.');
    }
    museSyncControls();
  } catch {
    if (mySeq !== museSeq) return;
    museAuthorized = false;
    museStatusBody = null;
    museSetState('dgm-muse-state', 'Unavailable: request failed. No generation is offered.');
    if (box) box.textContent = '';
    museSyncControls();
  }
}

function museNewOpKey() {
  // One key per deliberate generation. Held locally so an uncertain outcome
  // can be inspected instead of resubmitted under a new key.
  let suffix;
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    suffix = String(Math.random()).slice(2, 18) + String(Date.now()).slice(-4);
  }
  return 'ui-' + suffix;
}

function museRenderResult(entry) {
  const box = document.getElementById('dgm-muse-result');
  if (!box) return;
  museAttachKey = entry.opKey;
  const r = entry.receipt || {};
  const usage = r.usage && Number.isSafeInteger(r.usage.input_tokens) && Number.isSafeInteger(r.usage.output_tokens)
    ? 'input=' + r.usage.input_tokens + ' output=' + r.usage.output_tokens
    : 'unknown';
  const input = r.proposalInput && typeof r.proposalInput.fixture === 'string' ? r.proposalInput.fixture : null;
  const row = (label, value) => '<tr><th>' + esc(label) + '</th><td>' + value + '</td></tr>';
  let html = '<h3>Operation result</h3><table class="kv">'
    + row('operation key', esc(entry.opKey))
    + row('state', esc(entry.state || 'delivered'))
    + row('mode', esc(r.mode || entry.mode || 'unknown'))
    + row('evaluation', esc(r.evaluation || 'unknown'))
    + row('model', esc(r.model || 'unknown'))
    + row('response id', esc(r.responseId || 'not applicable'))
    + row('usage', esc(usage))
    + row('elapsed', Number.isFinite(r.elapsedMs) ? esc(String(r.elapsedMs) + ' ms') : 'unknown')
    + row('spend reserved', esc(museUsd(r.spendUsdReserved)))
    + row('spend used (reported, lower bound)', esc(museUsd(r.spendUsdUsed)))
    + row('provider contact', esc(r.providerContact || 'unknown'))
    + row('acceptance', esc(r.acceptance || 'unknown'))
    + row('billing', esc(r.billing || 'unknown'))
    + row('proposal hash', esc(r.proposalHash || 'unknown'))
    + row('proposal chars', museCount(r.proposalChars))
    + row('evaluated input', esc(input || 'none (no allowlisted fixture directive)'))
    + '</table>';
  if (typeof entry.proposal === 'string') {
    html += '<h3>Proposal text (' + esc(r.evaluation || entry.mode || 'unknown') + ')</h3>'
      + '<pre class="proposal">' + esc(entry.proposal) + '</pre>';
  } else {
    html += '<p class="note">No proposal text is shown: the server does not store live proposal text, so this result is the receipt only.</p>';
  }
  if (input) {
    html += '<p><button type="button" id="dgm-muse-attach">Attach to bounded fixture evaluation</button></p>';
  } else {
    html += '<p class="note">No attach: this delivery carried no usable allowlisted <code>fixture:</code> directive, so there is no evaluation input to consume.</p>';
  }
  box.innerHTML = html;
  const attach = document.getElementById('dgm-muse-attach');
  if (attach) attach.addEventListener('click', () => attachDgmMuseProposal());
  museSyncControls();
}

function museMarkReceiptSettled(key) {
  // A write outcome (delivered, replay, quarantine, cancellation or unknown)
  // outranks an inspection that was already in flight: that inspection must not
  // repaint over the receipt or its admission state.
  museReceiptSeq += 1;
  museLastReceiptKey = key;
}

function museClearResult() {
  // Entering an uncertain state invalidates the on-screen result: it belongs to
  // a different operation and must not be attachable while reconciliation is
  // pending. The receipt remains available through Inspect.
  museCurrent = null;
  museAttachKey = null;
  const box = document.getElementById('dgm-muse-result');
  if (box) box.innerHTML = '';
}

function museShowReconcile(prefillKey, explanation) {
  const panel = document.getElementById('dgm-muse-reconcile');
  if (panel) panel.hidden = false;
  const keyInput = document.getElementById('dgm-muse-op-key');
  if (keyInput && prefillKey) keyInput.value = prefillKey;
  museSetState('dgm-muse-reconcile-state', explanation);
  museSyncControls();
}

async function generateDgmMuseProposal() {
  if (museBusy) return; // duplicate clicks never send a second request
  if (!museAuthorized || !museStatusBody) {
    museSetState('dgm-muse-gen-state', 'Load Muse status first.');
    return;
  }
  const promptEl = document.getElementById('dgm-muse-prompt');
  const prompt = promptEl ? String(promptEl.value || '') : '';
  const mode = museMode();
  if (!prompt.trim()) {
    museSetState('dgm-muse-gen-state', 'Enter a synthetic test prompt first. Nothing was sent.');
    return;
  }
  if (mode === 'live' && !museLiveConfigured()) {
    museSetState('dgm-muse-gen-state', 'Live generation is not configured on the server. Nothing was sent; request a fixture dry run instead.');
    return;
  }
  if (!museStoreAvailable()) {
    museSetState('dgm-muse-gen-state', 'The DGM proposal store is not migrated. Nothing was sent.');
    return;
  }
  const opKey = museNewOpKey();
  museBusy = true;
  museSyncControls();
  museSetState('dgm-muse-gen-state', 'Generating one ' + (mode === 'live' ? 'synthetic-live' : 'fixture') + ' proposal…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/proposals', {
      method: 'POST', body: JSON.stringify({ prompt, mode, opKey })
    });
    if (res.ok && body && typeof body.proposal === 'string') {
      museMarkReceiptSettled(opKey);
      museCurrent = { opKey, mode, state: 'delivered', proposal: body.proposal, receipt: body.receipt || null };
      museBlocked = false;
      museRenderResult(museCurrent);
      museSetState('dgm-muse-gen-state', 'Delivered ' + opKey + ' (' + (body.receipt && body.receipt.evaluation ? body.receipt.evaluation : mode) + ').');
      return;
    }
    const code = body && typeof body.code === 'string' ? body.code : '';
    if (res.ok && body && body.receipt) {
      // A replay of a settled op: render its receipt, never invent text.
      const state = typeof body.state === 'string' ? body.state : 'unknown';
      museMarkReceiptSettled(opKey);
      museCurrent = { opKey, mode, state, proposal: null, receipt: body.receipt };
      museBlocked = state === 'cancelled';
      museRenderResult(museCurrent);
      museSetState('dgm-muse-gen-state', 'Replayed ' + opKey + ' as ' + state + '.');
      return;
    }
    if (code === 'DGM_MUSE_UNCERTAIN') {
      museBlocked = true;
      museMarkReceiptSettled(opKey);
      museClearResult();
      museShowReconcile('', 'Another operation for this tenant is quarantined, so the server admitted nothing. Inspect its operation key and reconcile it explicitly; this panel never resubmits with a new key.');
      museSetState('dgm-muse-gen-state', 'Quarantined: ' + museFailure(code, res.status) + '. Attempted ' + opKey + ' was not admitted; no duplicate was sent.');
      return;
    }
    if (code === 'DGM_MUSE_IN_FLIGHT') {
      museSetState('dgm-muse-gen-state', 'Another proposal is in flight: ' + museFailure(code, res.status) + '. Attempted ' + opKey + ' was not admitted; wait for it to settle, or inspect it by key.');
      return;
    }
    if (code === 'DGM_MUSE_CANCELLED') {
      museBlocked = true;
      museMarkReceiptSettled(opKey);
      museClearResult();
      museShowReconcile(opKey, 'The operation was cancelled during admission and carries a durable reservation. Inspect it and reconcile explicitly if its provider outcome is unknown.');
      museSetState('dgm-muse-gen-state', 'Cancelled during admission: ' + museFailure(code, res.status) + ' (attempted ' + opKey + ').');
      return;
    }
    museSetState('dgm-muse-gen-state', 'Refused: ' + museFailure(code, res.status) + '. Nothing was delivered (attempted ' + opKey + ').');
  } catch {
    // The request left the page but no response was read: it may or may not
    // have been admitted. Keep the key and inspect; never auto-resend.
    museBlocked = true;
    museMarkReceiptSettled(opKey);
    museClearResult();
    museShowReconcile(opKey, 'The request ended before a response was read, so the outcome is unknown. Inspect operation ' + opKey + '; nothing is resubmitted automatically.');
    museSetState('dgm-muse-gen-state', 'Outcome unknown: the request may have reached the server. Inspect ' + opKey + '.');
  } finally {
    // No read (inspection) or other path may own this reset: a generation that
    // settled always releases the panel, so its receipt/key stay reachable.
    museBusy = false;
    museSyncControls();
  }
}

function museOpKeyFromInput() {
  const el = document.getElementById('dgm-muse-op-key');
  return el ? String(el.value || '').trim() : '';
}

async function inspectDgmMuseOp() {
  const key = museOpKeyFromInput();
  if (!MUSE_OP_RE.test(key)) {
    museSetState('dgm-muse-reconcile-state', 'Enter a valid operation key (1..64 id characters).');
    return;
  }
  const mySeq = ++museOpSeq;
  const receiptAtStart = museReceiptSeq;
  museSetState('dgm-muse-reconcile-state', 'Inspecting ' + key + '…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/ops/' + encodeURIComponent(key));
    if (mySeq !== museOpSeq) return;
    if (receiptAtStart !== museReceiptSeq) {
      // A generation or reconcile settled while this inspection was in flight.
      // Its receipt and admission state are newer than this read and stay on
      // screen; the operator can inspect this key again deliberately.
      museSetState('dgm-muse-reconcile-state', 'Operation ' + museLastReceiptKey + ' settled while ' + key
        + ' was being inspected; its outcome stays on screen. Inspect ' + key + ' again to act on it.');
      return;
    }
    if (res.status === 404) {
      // No row exists: the server never admitted this key, so nothing was
      // reserved and no provider call can be attached to it.
      museBlocked = false;
      museSyncControls();
      museSetState('dgm-muse-reconcile-state', 'No stored operation ' + key + '. The server never admitted it, so no reservation or provider call exists for this key.');
      return;
    }
    if (!res.ok || !body) {
      museSetState('dgm-muse-reconcile-state', 'Inspect refused: ' + museFailure(body && body.code, res.status) + '.');
      return;
    }
    museCurrent = { opKey: key, state: body.state, proposal: null, receipt: body.receipt || null };
    museBlocked = body.blocking === true;
    museRenderResult(museCurrent);
    museSetState('dgm-muse-reconcile-state', 'State ' + unknown(body.state) + '; unknown outcome '
      + (body.unknownOutcome === true ? 'yes' : 'no') + '; blocking admission '
      + (body.blocking === true ? 'yes' : 'no') + '.');
    const panel = document.getElementById('dgm-muse-reconcile');
    if (panel) panel.hidden = false;
    museSyncControls();
  } catch {
    if (mySeq !== museOpSeq) return;
    museSetState('dgm-muse-reconcile-state', 'Inspect failed: request failed.');
  }
}

async function reconcileDgmMuseOp() {
  if (museBusy) return;
  const key = museOpKeyFromInput();
  const ack = document.getElementById('dgm-muse-ack');
  if (!MUSE_OP_RE.test(key)) {
    museSetState('dgm-muse-reconcile-state', 'Enter a valid operation key first.');
    return;
  }
  if (!ack || ack.checked !== true) {
    museSetState('dgm-muse-reconcile-state', 'Reconciliation needs the explicit acknowledgement checkbox.');
    return;
  }
  const noteEl = document.getElementById('dgm-muse-note');
  const note = noteEl ? String(noteEl.value || '').trim() : '';
  museBusy = true;
  museSyncControls();
  museSetState('dgm-muse-reconcile-state', 'Reconciling ' + key + '…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/ops/' + encodeURIComponent(key) + '/reconcile', {
      method: 'POST', body: JSON.stringify(note ? { acknowledge: true, note } : { acknowledge: true })
    });
    if (res.ok && body && body.state) {
      museMarkReceiptSettled(key);
      museCurrent = { opKey: key, state: body.state, proposal: null, receipt: body.receipt || null };
      museBlocked = body.blocking === true;
      museRenderResult(museCurrent);
      museSetState('dgm-muse-reconcile-state', 'Reconciled ' + key + ' as ' + body.state + '. The reservation is not refunded.');
      if (ack) ack.checked = false;
      return;
    }
    museSetState('dgm-muse-reconcile-state', 'Reconcile refused: ' + museFailure(body && body.code, res.status) + '.');
  } catch {
    museSetState('dgm-muse-reconcile-state', 'Reconcile failed: request failed. Nothing was recorded.');
  } finally {
    // Owned by this write only; an inspection can never suppress this reset.
    museBusy = false;
    museSyncControls();
  }
}

async function attachDgmMuseProposal() {
  if (museBusy) return;
  const opKey = museAttachKey; // captured when this result was rendered
  if (!opKey) return;
  const entry = museCurrent && museCurrent.opKey === opKey ? museCurrent : null;
  const input = entry && entry.receipt && entry.receipt.proposalInput
    && typeof entry.receipt.proposalInput.fixture === 'string' ? entry.receipt.proposalInput.fixture : null;
  if (!input) {
    museSetState('dgm-muse-gen-state', 'This delivery carried no allowlisted fixture input, so nothing can be attached.');
    return;
  }
  museBusy = true;
  museSyncControls();
  museSetState('dgm-muse-gen-state', 'Attaching ' + opKey + ' to the bounded fixture evaluation…');
  try {
    // No direct `fixture`: the server verifies delivery and evaluates the
    // proposal's own allowlisted directive.
    const { res, body } = await dgmFetch(MUSE_FIXTURE_RUNS, {
      method: 'POST', body: JSON.stringify({ proposalOpKey: opKey })
    });
    if (res.ok && body) {
      museSetState('dgm-muse-gen-state', 'Attached ' + opKey + ' as preview run ' + unknown(body.runId)
        + ' (' + unknown(body.status) + ' / ' + unknown(body.envelopeLabel) + '). The verdict is the fixture table\'s.');
      const attach = document.getElementById('dgm-muse-attach');
      if (attach) attach.disabled = true;
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      museSetState('dgm-muse-gen-state', 'Attach refused: ' + museFailure(body && body.code, res.status) + '.');
    }
  } catch {
    museSetState('dgm-muse-gen-state', 'Attach failed: request failed.');
  } finally {
    museBusy = false;
    museSyncControls();
  }
}

document.getElementById('dgm-muse-load').addEventListener('click', loadDgmMuse);
document.getElementById('dgm-muse-generate').addEventListener('click', generateDgmMuseProposal);
document.getElementById('dgm-muse-mode').addEventListener('change', museSyncControls);
document.getElementById('dgm-muse-inspect').addEventListener('click', inspectDgmMuseOp);
document.getElementById('dgm-muse-reconcile-submit').addEventListener('click', reconcileDgmMuseOp);
document.getElementById('dgm-muse-ack').addEventListener('change', museSyncControls);
