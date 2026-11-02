// Administrator-access decision for the /app/experiments/dsh-dgm/ page.
//
// The /app/* and /admin/* shells are public static assets: anyone can download
// them and they carry no authority of their own. This module only decides
// whether the page should render the interactive prototype, using the
// existing read-only administration gate:
//
//   GET /api/admin/v1/status  ->  requireAdmin(ctx, 'admin.status')
//
// That route authorizes only a session actor holding a live (unrevoked,
// unexpired) admin_grants row with a recognized role and the `platform` scope.
// Demo sessions, API-key and heartbeat-key callers, expired or revoked grants
// and callers with no grant are refused server-side; the client never decides
// who is an administrator. On success the server answers 200 with
//
//   { schema_version: 'admin.status.v1', admin, elevation, mutations,
//     grant: { role, scope, expires_at }, observed_at }
//
// and on refusal it answers 401 AUTH_REQUIRED (no session) or 403
// ADMIN_FORBIDDEN (signed in, not authorized). This module only maps those
// answers to a UI state and fails closed on anything else.

export const ADMIN_STATUS_ENDPOINT = '/api/admin/v1/status';
export const ADMIN_STATUS_SCHEMA = 'admin.status.v1';
export const ADMIN_GRANT_SCOPE = 'platform';

export const ACCESS_STATES = Object.freeze({
  AUTHORIZED: 'authorized',
  ANONYMOUS: 'anonymous',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable'
});

const MESSAGES = Object.freeze({
  [ACCESS_STATES.ANONYMOUS]:
    'You are not signed in. The interactive experiment is available only to an administrator '
    + 'with a live platform grant. Sign in to the AIPSTER control panel and return to this page.',
  [ACCESS_STATES.DENIED]:
    'This account is not authorized for administration, so the interactive experiment did not load. '
    + 'An ordinary account, a demo account, an expired or revoked grant and an API-key caller are '
    + 'all refused by the server. Ask an administrator for a platform grant if you need access.',
  [ACCESS_STATES.UNAVAILABLE]:
    'The administrator authorization check did not complete, so the interactive experiment did not load. '
    + 'Try again from the AIPSTER control panel.'
});

function refuse(state, message) {
  return { state, load: false, message: message || MESSAGES[state], role: null, scope: null };
}

// input: { status, payload, error }
//   status  HTTP status of GET /api/admin/v1/status, if a response arrived
//   payload parsed JSON body, or null when it was not JSON
//   error   a short reason string when the request itself failed
export function decideAdminAccess(input) {
  const { status, payload, error } = input && typeof input === 'object' ? input : {};

  // A failed request, or a body we could not parse, is a check we could not
  // complete. It is never treated as authorization.
  if (error) return refuse(ACCESS_STATES.UNAVAILABLE);
  if (!Number.isInteger(status) || status < 100 || status > 599) return refuse(ACCESS_STATES.UNAVAILABLE);
  if (status === 401) return refuse(ACCESS_STATES.ANONYMOUS);
  if (status === 403) return refuse(ACCESS_STATES.DENIED);
  if (status !== 200) return refuse(ACCESS_STATES.UNAVAILABLE);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return refuse(ACCESS_STATES.UNAVAILABLE);
  }
  // Only the documented status envelope authorizes anything. A 200 from some
  // other route, or a future shape, leaves the page closed.
  if (payload.schema_version !== ADMIN_STATUS_SCHEMA) return refuse(ACCESS_STATES.UNAVAILABLE);

  const grant = payload.grant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return refuse(ACCESS_STATES.DENIED);
  if (typeof grant.role !== 'string' || grant.role.trim() === '') return refuse(ACCESS_STATES.DENIED);
  if (grant.scope !== ADMIN_GRANT_SCOPE) return refuse(ACCESS_STATES.DENIED);

  return {
    state: ACCESS_STATES.AUTHORIZED,
    load: true,
    role: grant.role,
    scope: grant.scope,
    message: `Administrator access verified: role ${grant.role}, scope ${grant.scope}. `
      + 'The experiment is still off until you enable it below.'
  };
}
