/* Built with Meta Muse. */
// Admin scaffold shell: same-origin reads only. The shell renders whatever
// availability state the server reports and invents no data — an unknown or
// missing field is shown as unknown, never as zero or healthy.
'use strict';

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
      grant.textContent = 'Authorized as ' + body.grant.role + ' (scope ' + body.grant.scope + '). '
        + 'Elevation: ' + (body.elevation || 'unknown') + '. Mutations: ' + (body.mutations || 'unknown') + '.';
      paintAuthButtons(true);
    } else if (body && body.code) {
      grant.textContent = 'Not authorized (' + body.code + '). Sign in with an administration grant.';
      paintAuthButtons(false);
    } else {
      grant.textContent = 'Authorization unknown (HTTP ' + res.status + ').';
      paintAuthButtons(false);
    }
  } catch {
    grant.textContent = 'Authorization unknown (request failed).';
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
    grant.textContent = 'Sign-in failed (request failed).';
  }
}

async function signOut() {
  const grant = document.getElementById('grant');
  try {
    await fetch('/api/auth/sign-out', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch {
    grant.textContent = 'Sign-out failed (request failed).';
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
    '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.email)
    + '</td><td>' + esc(it.provider) + '</td><td>' + esc(it.status) + '</td><td>' + esc(it.tenant)
    + '</td><td>not applicable (demo)</td><td>' + unknown(it.keys_active) + '</td></tr>').join('');
  box.innerHTML = '<p class="banner">Synthetic demo — fixture data only. No real users, no privileges, no live requests.</p>'
    + '<table><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr>' + rows + '</table>';
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
  state.textContent = 'Loading…';
  try {
    const res = await fetch(endpoint, { credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      const parts = ['state: ' + (body.state === null || body.state === undefined ? 'unknown' : body.state)];
      if (body.reason_code) parts.push('reason: ' + body.reason_code);
      if (body.metric) parts.push('metric: ' + body.metric);
      if (Array.isArray(body.items)) parts.push('items: ' + body.items.length + ' (total ' + (body.total === null ? 'unknown' : body.total) + ')');
      state.textContent = parts.join(', ') + '.';
    } else if (body && body.code) {
      state.textContent = 'Unavailable: ' + body.code + ' (HTTP ' + res.status + ').';
    } else {
      state.textContent = 'Unavailable: HTTP ' + res.status + '.';
    }
  } catch {
    state.textContent = 'Unavailable: request failed.';
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
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/overview', { credentials: 'same-origin' });
    if (mySeq !== overviewSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== overviewSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !body.resources) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    const r = body.resources;
    box.innerHTML = '<table>'
      + '<tr><th>resources total</th><td>' + unknown(r.total) + '</td></tr>'
      + '<tr><th>online</th><td>' + unknown(r.online) + '</td></tr>'
      + '<tr><th>stale</th><td>' + unknown(r.stale) + '</td></tr>'
      + '<tr><th>offline</th><td>' + unknown(r.offline) + '</td></tr>'
      + '<tr><th>unknown</th><td>' + unknown(r.unknown) + '</td></tr>'
      + '<tr><th>fabrics</th><td>' + esc(body.fabrics_state || 'unknown')
      + (body.fabrics_reason_code ? ' (' + esc(body.fabrics_reason_code) + ')' : '') + '</td></tr>'
      + '<tr><th>usable capacity</th><td>' + esc(body.usable_capacity_state || 'unknown') + '</td></tr>'
      + '<tr><th>coverage</th><td>' + esc(body.coverage_state || 'unknown')
      + (body.coverage_reason_code ? ' (' + esc(body.coverage_reason_code) + ')' : '') + '</td></tr>'
      + '</table>';
  } catch {
    if (mySeq !== overviewSeq) return;
    state.textContent = 'Unavailable: request failed.';
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
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/resources?limit=' + RESOURCES_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== resourcesSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== resourcesSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No resources registered (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.kind)
        + '</td><td>' + esc(it.liveness) + '</td><td>' + esc(it.lastSeenAt || 'unknown')
        + '</td><td>' + unknown(it.usable) + '</td><td>' + unknown(it.configured)
        + '</td><td>' + unknown(it.authenticated) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>id</th><th>name</th><th>kind</th><th>liveness</th>'
        + '<th>last seen</th><th>usable</th><th>configured</th><th>authenticated</th></tr>' + rows + '</table>';
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
    state.textContent = 'Unavailable: request failed.';
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
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/audit?limit=' + AUDIT_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== auditSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== auditSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      // Unavailable is a measurement failure, never an empty feed.
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No audit events recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) => {
        const action = it.action_known && typeof it.action === 'string' ? esc(it.action) : 'unknown';
        const at = it.at_known && typeof it.at === 'string' ? esc(it.at) : 'unknown';
        return '<tr><td>' + esc(it.id) + '</td><td>' + action + '</td><td>'
          + esc(it.category || 'unknown') + '</td><td>' + at + '</td></tr>';
      }).join('');
      box.innerHTML = '<table><tr><th>event</th><th>action</th><th>category</th><th>at</th></tr>' + rows + '</table>';
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
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Coverage (static truthful release states; no collectors yet) ----

let coverageSeq = 0;

async function loadCoverage() {
  const mySeq = ++coverageSeq;
  const section = document.getElementById('coverage');
  const state = section.querySelector('.state');
  const box = document.getElementById('coverage-result');
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/coverage', { credentials: 'same-origin' });
    if (mySeq !== coverageSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== coverageSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = 'No coverage rows recorded.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.metric) + '</td><td>' + esc(it.release_state)
        + '</td><td>' + esc(it.reason_code || 'unknown') + '</td><td>' + unknown(it.supported_runtime) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>metric</th><th>release state</th><th>reason</th><th>runtime</th></tr>' + rows + '</table>';
    }
  } catch {
    if (mySeq !== coverageSeq) return;
    state.textContent = 'Unavailable: request failed.';
  }
}

// ---- Operations health (read-only probes; nothing here changes infra) ----

let healthSeq = 0;

async function loadHealth() {
  const mySeq = ++healthSeq;
  const section = document.getElementById('operations');
  const state = section.querySelector('.state');
  const box = document.getElementById('operations-result');
  state.textContent = 'Loading…';
  box.textContent = '';
  try {
    const res = await fetch('/api/admin/v1/operations/health', { credentials: 'same-origin' });
    if (mySeq !== healthSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== healthSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !body.control_plane || !body.compatibility) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    const c = body.collectors || {};
    box.innerHTML = '<table>'
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
    state.textContent = 'Unavailable: request failed.';
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
  state.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/users?limit=' + USERS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== usersSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== usersSeq) return;
    if (!res.ok || !body) {
      state.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
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
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.name || 'unknown') + '</td><td>' + esc(it.email || 'unknown')
        + '</td><td>' + esc(it.provider || 'unknown') + '</td><td>' + esc(it.status) + '</td><td>' + esc(it.tenant)
        + '</td><td>' + roleCell(it) + '</td><td>' + unknown(it.keys_active) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>id</th><th>name</th><th>email</th><th>provider</th><th>status</th><th>tenant</th><th>admin roles</th><th>keys</th></tr>' + rows + '</table>';
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
    state.textContent = 'Unavailable: request failed.';
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
  state2.textContent = 'Loading…';
  box.textContent = '';
  pages.hidden = true;
  try {
    const res = await fetch('/api/admin/v1/access/sessions?limit=' + SESSIONS_LIMIT + '&offset=' + myOffset, { credentials: 'same-origin' });
    if (mySeq !== sessionsSeq) return;
    const body = await res.json().catch(() => null);
    if (mySeq !== sessionsSeq) return;
    if (!res.ok || !body) {
      state2.textContent = 'Unavailable: ' + requestFailure(body, res.status) + '.';
      return;
    }
    if (body.state !== 'available' || !Array.isArray(body.items)) {
      state2.textContent = 'Unavailable: ' + (body.reason_code ? body.reason_code + ' ' : '') + '(' + unknown(body.state) + ').';
      return;
    }
    const total = Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
    state2.textContent = 'Loaded ' + unknown(body.observed_at) + '.';
    if (!body.items.length) {
      box.textContent = total === 0 ? 'No sessions recorded (empty).' : 'No rows on this page.';
    } else {
      const rows = body.items.map((it) =>
        '<tr><td>' + esc(it.id) + '</td><td>' + esc(it.user_id || 'unknown') + '</td><td>' + esc(it.issued_at || 'unknown')
        + '</td><td>' + esc(it.expires_at || 'unknown') + '</td><td>' + (it.active ? 'active' : 'expired')
        + '</td><td>' + esc(it.authentication_method || 'unknown') + '</td><td>' + esc(it.presence) + '</td></tr>').join('');
      box.innerHTML = '<table><tr><th>session</th><th>user</th><th>issued</th><th>expires</th><th>state</th><th>auth method</th><th>presence</th></tr>' + rows + '</table>';
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
    state2.textContent = 'Unavailable: request failed.';
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
  state.textContent = 'Creating…';
  const fixture = document.getElementById('dgm-fixture').value;
  const held = !!document.getElementById('dgm-held').checked;
  const label = document.getElementById('dgm-label').value || '';
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs', {
      method: 'POST', body: JSON.stringify(label ? { fixture, held, label } : { fixture, held })
    });
    if (res.ok && body) {
      state.textContent = 'Created ' + body.runId + ' (' + body.status + ' / ' + body.envelopeLabel + ').';
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      state.textContent = 'Refused: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Refused: request failed.';
  }
}

function dgmDetailHtml(run) {
  const row = (label, value) => '<tr><th>' + dgmEsc(label) + '</th><td>' + value + '</td></tr>';
  const gates = (Array.isArray(run.gates) ? run.gates : []).map((g) =>
    '<tr><td>' + dgmEsc(g.name) + '</td><td>' + (g.passed ? 'pass' : 'fail') +
    '</td><td>' + dgmEsc(g.evidence) + '</td></tr>').join('');
  const events = (Array.isArray(run.events) ? run.events : []).map((e) =>
    '<tr><td>' + dgmEsc(e.sequence) + '</td><td>' + dgmEsc(e.event) +
    '</td><td>' + dgmEsc(e.detail) + '</td></tr>').join('');
  const telem = run.telemetry || {};
  const latency = telem.latencySummary || {};
  const tokens = telem.tokensSummary || {};
  const prov = run.provenance || {};
  const archive = (Array.isArray(prov.archive) ? prov.archive : []).map((a) =>
    '<tr><td>' + dgmEsc(a.scorePpm) + '</td><td>' + (a.baseline ? 'baseline' : 'candidate (fixture)') + '</td></tr>').join('');
  return '<span id="dgm-run-' + dgmEsc(run.runId) + '"></span>'
    + '<table>' + row('run', dgmEsc(run.runId)) + row('fixture', dgmEsc(run.fixture) + ' (fixture)')
    + row('evaluation', dgmEsc(run.evaluation)) + row('status', dgmEsc(run.status))
    + row('envelope', dgmEsc(run.envelopeLabel)) + row('label', dgmEsc(run.label || ''))
    + row('advice reason', dgmEsc(run.adviceReason)) + row('settlement', dgmEsc(run.settlement)) + '</table>'
    + '<h3>Readiness gates</h3><table><tr><th>gate</th><th>verdict</th><th>evidence</th></tr>' + gates + '</table>'
    + '<h3>Archived candidates (fixture)</h3><table><tr><th>score ppm</th><th>kind</th></tr>'
    + (archive || '<tr><td colspan="2">no archived entries (run never settled)</td></tr>') + '</table>'
    + '<h3>Budget/event trace</h3><table><tr><th>#</th><th>event</th><th>detail</th></tr>' + events + '</table>'
    + '<h3>Telemetry (fixture rows, real persistence)</h3><table>'
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
  state.textContent = 'Loading…';
  detail.innerHTML = '';
  dgmCurrentRun = null;
  dgmControlState(null);
  try {
    const { res, body } = await dgmFetch('/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(runId));
    if (res.ok && body) {
      dgmCurrentRun = body.runId;
      state.textContent = body.runId + ' — ' + body.status + ' / ' + body.envelopeLabel + '.';
      detail.innerHTML = dgmDetailHtml(body);
      dgmControlState(body.status);
    } else {
      state.textContent = 'Unavailable: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Unavailable: request failed.';
  }
}

async function dgmControl(action) {
  if (!dgmCurrentRun) return;
  const state = document.getElementById('dgm-run-state');
  state.textContent = 'Loading…';
  try {
    const { res, body } = await dgmFetch(
      '/api/admin/v1/dgm/preview/runs/' + encodeURIComponent(dgmCurrentRun) + '/' + action, { method: 'POST' });
    if (res.ok && body) {
      loadDgmRuns();
      loadDgmRun(body.runId);
    } else {
      state.textContent = 'Refused: ' + dgmFailure(body, res.status) + '.';
    }
  } catch {
    state.textContent = 'Refused: request failed.';
  }
}

document.getElementById('dgm-runs-load').addEventListener('click', loadDgmRuns);
document.getElementById('dgm-create').addEventListener('click', createDgmRun);
document.getElementById('dgm-pause').addEventListener('click', () => dgmControl('pause'));
document.getElementById('dgm-resume').addEventListener('click', () => dgmControl('resume'));
document.getElementById('dgm-cancel').addEventListener('click', () => dgmControl('cancel'));

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
let museOpSeq = 0;        // inspect/reconcile request ordering
let museAuthorized = false;
let museStatusBody = null;
let museBusy = false;     // one generation/attach at a time
let museBlocked = false;  // quarantine state the server reported
let museCurrent = null;   // result bound to one operation key
let museAttachKey = null; // key captured when the rendered result was drawn

function museSetState(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
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
    box.innerHTML = '<table>'
      + row('model', esc(provider.model || 'unknown'))
      + row('provider configured', museLiveConfigured() ? 'yes (synthetic-live)' : 'no (fixture only)')
      + row('reported evaluation', esc(body.evaluation || 'unknown'))
      + row('endpoint', esc(((provider.endpoint || {}).host || 'unknown') + ((provider.endpoint || {}).path || '')))
      + row('prompt bound', museCount((provider.bounds || {}).promptMaxBytes) + ' bytes')
      + row('output bound', museCount((provider.bounds || {}).outputMaxTokens) + ' tokens / deadline '
        + museCount((provider.bounds || {}).deadlineMs) + ' ms')
      + spendRows
      + '</table><h3>Missing prerequisites</h3><ul>' + missing + '</ul>'
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
  let html = '<h3>Operation result</h3><table>'
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
  const mySeq = ++museOpSeq;
  museBusy = true;
  museSyncControls();
  museSetState('dgm-muse-gen-state', 'Generating one ' + (mode === 'live' ? 'synthetic-live' : 'fixture') + ' proposal…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/proposals', {
      method: 'POST', body: JSON.stringify({ prompt, mode, opKey })
    });
    if (mySeq !== museOpSeq) return;
    if (res.ok && body && typeof body.proposal === 'string') {
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
      museCurrent = { opKey, mode, state, proposal: null, receipt: body.receipt };
      museBlocked = state === 'cancelled';
      museRenderResult(museCurrent);
      museSetState('dgm-muse-gen-state', 'Replayed ' + opKey + ' as ' + state + '.');
      return;
    }
    if (code === 'DGM_MUSE_UNCERTAIN') {
      museBlocked = true;
      museShowReconcile('', 'Another operation for this tenant is quarantined, so the server admitted nothing. Inspect its operation key and reconcile it explicitly; this panel never resubmits with a new key.');
      museSetState('dgm-muse-gen-state', 'Quarantined: ' + museFailure(code, res.status) + '. No duplicate was sent.');
      return;
    }
    if (code === 'DGM_MUSE_IN_FLIGHT') {
      museSetState('dgm-muse-gen-state', 'Another proposal is in flight: ' + museFailure(code, res.status) + '. Wait for it to settle, or inspect it by key.');
      return;
    }
    if (code === 'DGM_MUSE_CANCELLED') {
      museBlocked = true;
      museShowReconcile(opKey, 'The operation was cancelled during admission and carries a durable reservation. Inspect it and reconcile explicitly if its provider outcome is unknown.');
      museSetState('dgm-muse-gen-state', 'Cancelled during admission: ' + museFailure(code, res.status) + '.');
      return;
    }
    museSetState('dgm-muse-gen-state', 'Refused: ' + museFailure(code, res.status) + '. Nothing was delivered.');
  } catch {
    if (mySeq !== museOpSeq) return;
    // The request left the page but no response was read: it may or may not
    // have been admitted. Keep the key and inspect; never auto-resend.
    museBlocked = true;
    museShowReconcile(opKey, 'The request ended before a response was read, so the outcome is unknown. Inspect operation ' + opKey + '; nothing is resubmitted automatically.');
    museSetState('dgm-muse-gen-state', 'Outcome unknown: the request may have reached the server. Inspect ' + opKey + '.');
  } finally {
    if (mySeq === museOpSeq) {
      museBusy = false;
      museSyncControls();
    }
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
  museSetState('dgm-muse-reconcile-state', 'Inspecting ' + key + '…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/ops/' + encodeURIComponent(key));
    if (mySeq !== museOpSeq) return;
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
  const mySeq = ++museOpSeq;
  museBusy = true;
  museSyncControls();
  museSetState('dgm-muse-reconcile-state', 'Reconciling ' + key + '…');
  try {
    const { res, body } = await dgmFetch(MUSE_BASE + '/ops/' + encodeURIComponent(key) + '/reconcile', {
      method: 'POST', body: JSON.stringify(note ? { acknowledge: true, note } : { acknowledge: true })
    });
    if (mySeq !== museOpSeq) return;
    if (res.ok && body && body.state) {
      museCurrent = { opKey: key, state: body.state, proposal: null, receipt: body.receipt || null };
      museBlocked = body.blocking === true;
      museRenderResult(museCurrent);
      museSetState('dgm-muse-reconcile-state', 'Reconciled ' + key + ' as ' + body.state + '. The reservation is not refunded.');
      if (ack) ack.checked = false;
      return;
    }
    museSetState('dgm-muse-reconcile-state', 'Reconcile refused: ' + museFailure(body && body.code, res.status) + '.');
  } catch {
    if (mySeq !== museOpSeq) return;
    museSetState('dgm-muse-reconcile-state', 'Reconcile failed: request failed. Nothing was recorded.');
  } finally {
    if (mySeq === museOpSeq) {
      museBusy = false;
      museSyncControls();
    }
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
