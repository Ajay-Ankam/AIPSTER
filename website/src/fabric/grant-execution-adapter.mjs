/* Built with Meta Muse. */
// Grant-to-execution adapter (OFFLINE demo bridge).
//
// A pure, I/O-free projection of ONE committed fabric grant (+ its
// connection, one live resource row, and one execution request) into the
// exact grant-view shape the inference dispatch gate consumes
// (`dispatch-coordinator` advisory `matchGrant` + `readGrant` shape).
// It creates no authority: no grant/admission rows, no principal
// authentication, no `readGrant` replacement, no key issuance, no fallback.
// Every failure returns ineligible with a reason code; nothing here can
// return an allow without a fully valid, enforced, live-pinned grant.
//
// Fabric row shapes reused verbatim (`store.mjs:commitGrant`): grant
// `{id, connection_id, recipient_node, recipient_workspace, consumers,
// snapshot[{resourceId, incarnation}], actions, models, ceilings, route,
// expiry, status, version, exporter_id, created_at}` (JSON columns accepted
// parsed or stringified, as D1 returns them), connection
// `{id, state, version}`, live resource `{id, owner_id, incarnation}`.
// Reason codes reuse `fabric/policy.mjs` REASONS wherever the semantics are
// identical; adapter-only failures use ADAPTER_REASONS.
import { REASONS, matchDeny } from './policy.mjs';

export const ADAPTER_REASONS = {
  ...REASONS,
  INPUT_MALFORMED: 'INPUT_MALFORMED',
  CONNECTION_DOWN: 'CONNECTION_DOWN',
  CONNECTION_MISMATCH: 'CONNECTION_MISMATCH',
  GRANT_REVOKED: 'GRANT_REVOKED',
  GRANT_QUARANTINED: 'GRANT_QUARANTINED',
  EXPORTER_MISMATCH: 'EXPORTER_MISMATCH',
  STALE_INCARNATION: 'STALE_INCARNATION',
};

// D1 returns JSON columns as strings; a stored scalar/object (corrupt or
// migrated row) must fail closed as INPUT_MALFORMED, never throw on a
// downstream `.includes`/`.map`. Only real arrays pass.
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  const parsed = safeParse(v, null);
  return Array.isArray(parsed) ? parsed : null;
};
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : typeof v === 'string' ? safeParse(v, null) : null);

function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function fail(reason) {
  return { eligible: false, reason, execution: null };
}

// Validate ONE snapshot entry against live state for ONE execution request.
// Snapshot entries each fully cover the request by themselves; entries are
// never stitched together (same invariant as policy.mjs: one complete
// grant covers the whole request).
export function adaptGrantEntryToExecution({ grant, connection, resource, entry, request, denies = [] } = {}) {
  if (!grant || typeof grant !== 'object' || !connection || typeof connection !== 'object'
    || !resource || typeof resource !== 'object' || !entry || typeof entry !== 'object'
    || !request || typeof request !== 'object' || !Array.isArray(denies)) {
    return fail(ADAPTER_REASONS.INPUT_MALFORMED);
  }
  const consumers = asArray(grant.consumers);
  const actions = asArray(grant.actions);
  const models = asArray(grant.models);
  const ceilings = asObject(grant.ceilings);
  if (!isStr(grant.id) || !isStr(grant.connection_id) || !isStr(grant.recipient_node)
    || !isStr(grant.recipient_workspace) || !consumers || !actions || !models || !ceilings
    || !isStr(grant.route) || !isIso(grant.expiry) || !isIso(grant.created_at)
    || !Number.isSafeInteger(grant.version) || !isStr(grant.exporter_id)
    || !isStr(entry.resourceId) || !isStr(entry.incarnation)
    || !isStr(request.consumer) || !isStr(request.peerNode) || !isStr(request.peerWorkspace)
    || !isStr(request.action) || !isStr(request.model) || !isIso(request.at) || !isStr(request.route)
    || !isStr(request.resourceId)
    || (request.maxTokens !== undefined && typeof request.maxTokens !== 'number')
    || (request.expectedRevision !== undefined && !Number.isSafeInteger(request.expectedRevision))) {
    return fail(ADAPTER_REASONS.INPUT_MALFORMED);
  }

  // Denies first, mirroring policy.evaluate: an explicit deny decides before
  // any grant term is consulted.
  const denyRequest = { consumer: request.consumer, resourceId: entry.resourceId, action: request.action };
  for (const deny of denies) {
    if (deny && typeof deny === 'object' && matchDeny(denyRequest, deny)) {
      return fail(ADAPTER_REASONS.EXPLICIT_DENY);
    }
  }

  if (grant.connection_id !== connection.id) return fail(ADAPTER_REASONS.CONNECTION_MISMATCH);
  if (connection.state !== 'active') return fail(ADAPTER_REASONS.CONNECTION_DOWN);
  // Quarantined rows are inert on every path (preview, discovery, and here):
  // the status stays 'enforced', so quarantine is checked before status.
  // A null exporter fails closed later at the exporter pin; a preserved
  // exporter does not rescue a quarantined row.
  if (grant.quarantine_reason !== undefined && grant.quarantine_reason !== null) {
    return fail(ADAPTER_REASONS.GRANT_QUARANTINED);
  }
  // Terminal revocation is reported precisely: a revoked grant is not merely
  // "not enforced", it can never authorize again.
  if (grant.status === 'revoked') return fail(ADAPTER_REASONS.GRANT_REVOKED);
  if (grant.status !== 'enforced') return fail(ADAPTER_REASONS.GRANT_NOT_ENFORCED);
  // The exporter must still hold the live resource: ownership drift
  // authorizes nothing, and import rebinding fails closed here exactly when
  // it changes the recorded owner.
  if (!isStr(resource.id) || !isStr(resource.owner_id) || !isStr(resource.incarnation)) {
    return fail(ADAPTER_REASONS.INPUT_MALFORMED);
  }
  if (resource.owner_id !== grant.exporter_id) return fail(ADAPTER_REASONS.EXPORTER_MISMATCH);
  if (resource.id !== entry.resourceId) return fail(ADAPTER_REASONS.RESOURCE_MISMATCH);
  // The request names exactly one resource (mirrors the coordinator's
  // admission.resource_id): a snapshot entry for another resource never
  // authorizes this request, and entries are never stitched together.
  if (request.resourceId !== entry.resourceId) return fail(ADAPTER_REASONS.RESOURCE_MISMATCH);
  // Live incarnation is re-pinned at adaptation time, exactly like the
  // coordinator re-reads live state at the linearization point: a stale
  // snapshot never authorizes the new incarnation.
  if (resource.incarnation !== entry.incarnation) return fail(ADAPTER_REASONS.STALE_INCARNATION);

  // Request-to-grant terms, identical semantics to policy.matchGrant.
  if (grant.recipient_node !== request.peerNode || grant.recipient_workspace !== request.peerWorkspace) {
    return fail(ADAPTER_REASONS.RECIPIENT_MISMATCH);
  }
  if (!consumers.includes(request.consumer)) return fail(ADAPTER_REASONS.CONSUMER_NOT_COVERED);
  if (!actions.includes(request.action)) return fail(ADAPTER_REASONS.ACTION_DENIED);
  if (!models.includes(request.model)) return fail(ADAPTER_REASONS.MODEL_DENIED);
  if (request.at < grant.created_at || request.at >= grant.expiry) return fail(ADAPTER_REASONS.GRANT_EXPIRED);
  if (grant.route !== request.route) return fail(ADAPTER_REASONS.ROUTE_DENIED);
  if (typeof request.maxTokens === 'number' && typeof ceilings.maxTokens === 'number'
    && request.maxTokens > ceilings.maxTokens) {
    return fail(ADAPTER_REASONS.QUOTA_EXCEEDED);
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== grant.version) {
    return fail(ADAPTER_REASONS.STALE_REVISION);
  }

  // Coordinator-shaped execution view. `incarnation` is the LIVE pin, not a
  // stale snapshot copy; `notBefore` is grant creation (approvals cannot
  // predate the grant that consumed them).
  const execution = {
    id: grant.id,
    status: 'enforced',
    revoked: false,
    revision: grant.version,
    recipientNode: grant.recipient_node,
    recipientWorkspace: grant.recipient_workspace,
    consumers: [...consumers],
    resourceId: resource.id,
    incarnation: resource.incarnation,
    actions: [...actions],
    models: [...models],
    notBefore: grant.created_at,
    expiry: grant.expiry,
    ceilings: { ...ceilings },
    route: grant.route,
  };
  const binding = {
    grantId: grant.id,
    grantRevision: grant.version,
    resourceId: resource.id,
    incarnation: resource.incarnation,
    connectionId: connection.id,
    connectionVersion: Number.isSafeInteger(connection.version) ? connection.version : null,
    adaptedAt: request.at,
  };
  return { eligible: true, reason: null, execution, binding };
}

// Adapt a whole committed grant (possibly multi-resource snapshot) for ONE
// execution request. Each entry is evaluated whole; the witness is the
// first entry in deterministic (resourceId, incarnation) order among the
// eligible — mirroring policy.selectWitness determinism without stitching.
export function adaptGrantToExecution({ grant, connection, resources, resource, request, denies = [] } = {}) {
  if (!grant || typeof grant !== 'object') {
    // An active connection with no grant authorizes nothing: acceptance
    // never implies a grant (store.mjs accept path grants zero access).
    return { decision: 'deny', code: ADAPTER_REASONS.NO_MATCHING_GRANT, witness: null, execution: null, details: [] };
  }
  // A missing snapshot is "no cover" (NO_MATCHING_GRANT); a present but
  // unparseable one (scalar/object/null where D1 holds a JSON array) is a
  // corrupt row (INPUT_MALFORMED). Both deny; the code tells them apart.
  if (grant.snapshot === undefined) {
    return { decision: 'deny', code: ADAPTER_REASONS.NO_MATCHING_GRANT, witness: null, execution: null, details: [] };
  }
  const snapshot = asArray(grant.snapshot);
  if (!snapshot) {
    return { decision: 'deny', code: ADAPTER_REASONS.INPUT_MALFORMED, witness: null, execution: null, details: [] };
  }
  const given = resources !== undefined ? resources : resource;
  const resourceList = Array.isArray(given) ? given : (given ? [given] : []);
  if (snapshot.length === 0 || resourceList.length === 0) {
    return { decision: 'deny', code: ADAPTER_REASONS.NO_MATCHING_GRANT, witness: null, execution: null, details: [] };
  }
  const byId = new Map(resourceList.filter((r) => r && typeof r === 'object').map((r) => [r.id, r]));
  const evaluated = snapshot.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      return { i, entry, result: fail(ADAPTER_REASONS.INPUT_MALFORMED) };
    }
    const resource = byId.get(entry.resourceId) || null;
    // No live row for this snapshot entry: the entry's resource is not the
    // supplied live resource, so it authorizes nothing (RESOURCE_MISMATCH,
    // not a shape error — the shapes are fine, the binding is absent).
    if (!resource) {
      return { i, entry, result: { eligible: false, reason: ADAPTER_REASONS.RESOURCE_MISMATCH, execution: null } };
    }
    return { i, entry, result: adaptGrantEntryToExecution({ grant, connection, resource, entry, request, denies }) };
  });
  const details = evaluated.map(({ entry, result }) => ({
    resourceId: entry && entry.resourceId,
    eligible: result.eligible,
    reason: result.reason,
  }));
  const winners = evaluated
    .filter(({ result }) => result.eligible)
    .sort((a, b) => {
      const fa = a.entry && a.entry.resourceId;
      const fb = b.entry && b.entry.resourceId;
      if (fa < fb) return -1;
      if (fa > fb) return 1;
      return a.i - b.i;
    });
  if (winners.length === 0) {
    const firstReason = details.length > 0 && details[0].reason ? details[0].reason : ADAPTER_REASONS.NO_MATCHING_GRANT;
    return { decision: 'deny', code: firstReason, witness: null, execution: null, details };
  }
  const win = winners[0].result;
  return { decision: 'allow', code: null, witness: win.execution.id, execution: win.execution, binding: win.binding, details };
}
