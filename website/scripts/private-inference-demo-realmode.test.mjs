// Real-mode orchestration tests: injected FAKE process/HTTP/browser seams.
// The REAL harness server + handlers + temp DB run; engine spawn, engine
// HTTP, worker CLIs, and browser issuance are scripted fakes. The fake
// worker CLIs perform the SAME HTTP calls the real Python CLIs perform
// (pairing claim, heartbeat, lease, result-post) through the REAL routes,
// so the orchestrator's sequencing, parsing, reconciliation, and cleanup
// are tested against real server-side effects. The fake browser issues the
// SAME admission/job calls the UI Submit path makes and settles through
// the REAL status route. NOTHING here starts an engine, runs Python, calls
// a model, or leaves 127.0.0.1. Run explicitly:
//   node --test website/scripts/private-inference-demo-realmode.test.mjs
// (NOT in the repo's broad globs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildProposal, executeRealRun, resolveWorkerProvenance, sanitizeArgv } from './private-inference-demo.mjs';

const FAKE_WORKER_CONTENT = 'hello from the fake worker (TEST seam, no model executed)';

function fixturePins(tag) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `private-demo-rm-${tag}-`));
  const enginePath = path.join(tmp, 'engine.exe');
  const ggufPath = path.join(tmp, 'model.gguf');
  writeFileSync(enginePath, `fake-engine-${tag}`);
  writeFileSync(ggufPath, Buffer.alloc(128, 3));
  const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
  return { tmp, pins: {
    engine: { path: enginePath, bytes: readFileSync(enginePath).length, sha256: sha(enginePath) },
    gguf: { path: ggufPath, bytes: 128, sha256: sha(ggufPath) } } };
}

// Fixture candidate assembly: the provenance resolver hashes THESE files,
// so script-hash pinning is exercised without touching real sources.
function fixtureAssembly(tmp) {
  const root = path.join(tmp, 'assembly');
  const workerDir = path.join(root, 'local-worker');
  const vendorDir = path.join(workerDir, 'vendor', 'eif');
  const dendriteDir = path.join(vendorDir, 'dendrite');
  mkdirSync(dendriteDir, { recursive: true });
  writeFileSync(path.join(workerDir, 'pairing.py'), '# TEST fixture pairing\n');
  writeFileSync(path.join(workerDir, 'inference_worker.py'), '# TEST fixture inference_worker\n');
  writeFileSync(path.join(dendriteDir, '__init__.py'), '# TEST fixture dendrite\n');
  return { root, workerDir, vendorDir, dendriteInit: path.join(dendriteDir, '__init__.py') };
}

function writeProposal(tmp, pins, overrides = {}) {
  const params = { model_id: 'TEST-model', runtime_id: 'llama-server',
    endpoint: 'http://127.0.0.1:45679', max_tokens: 32, deadline_s: 60,
    prompt: 'Say the word hello.', max_lifetime_s: 300,
    engine: { path: pins.engine.path,
      argv: ['-m', pins.gguf.path, '--port', '45679', '--alias', 'TEST-model', '--n-gpu-layers', '0'] },
    gguf: { path: pins.gguf.path }, ...overrides };
  const built = buildProposal(params, { candidateRevOverride: 'rev-rm', pins });
  assert.equal(built.ok, true, built.reason);
  const file = path.join(tmp, 'proposal.json');
  writeFileSync(file, JSON.stringify(built.file));
  return { file, sha: built.file.sha256, params: built.file.proposal };
}

function fakeChildFactory(calls) {
  return (bin, argv) => {
    calls.push({ bin, argv });
    const child = { pid: 424242 + calls.length, exitCode: null, killed: false, kills: [],
      kill(sig) { child.killed = true; child.kills.push(sig); child.exitCode = 0; return true; } };
    return child;
  };
}

function fakeEngineRequest(modelId) {
  return async (method, url) => {
    if (url.endsWith('/health')) return { status: 200, json: { status: 'ok' }, text: '{}' };
    if (url.endsWith('/v1/models')) return { status: 200, json: { data: [{ id: modelId }] }, text: '{}' };
    throw new Error('unexpected engine URL ' + url);
  };
}
// F2: existing orchestration tests isolate the git-cleanliness gate with a
// clean stub (the real default path is covered by the F2 tests below).
const cleanGit = () => '';

// Fake worker-process seam: simulates the Python CLI boundary ONLY (argv +
// stdout). Every effect goes through the REAL routes, like the real CLIs.
function makeWorkerSeam(assembly, behavior = {}) {
  const calls = [];
  const state = { paired: null };
  const flag = (args, name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const runWorkerProc = async (bin, args, opts = {}) => {
    calls.push({ bin, args: [...args], cwd: opts.cwd || null, pythonpath: (opts.env && opts.env.PYTHONPATH) || null, at: Date.now() });
    assert.equal(bin, 'python');
    assert.equal(opts.cwd, assembly.workerDir);
    if (args[0] === '-c' && String(args[1]).includes('sys.executable')) {
      return { status: 0, stdout: '3.12.9\nC:\\TEST\\python.exe\n', stderr: '', timedOut: false };
    }
    if (args[0] === '-c' && String(args[1]).includes('import dendrite')) {
      assert.ok((opts.env && opts.env.PYTHONPATH || '').split(path.delimiter)[0] === assembly.vendorDir,
        'candidate vendor dir must lead PYTHONPATH');
      const resolved = behavior.dendritePath || assembly.dendriteInit;
      return { status: 0, stdout: resolved + '\n', stderr: '', timedOut: false };
    }
    if (args[0] === 'pairing.py' && args.includes('pair')) {
      const base = flag(args, '--api-base');
      const dir = flag(args, '--data-dir');
      const code = flag(args, '--code');
      const name = flag(args, '--name');
      assert.ok(base && dir && code && name);
      const claimCode = behavior.pairFails ? 'corrupted-code-value' : code;
      const res = await fetch(`${base}/api/pairing/claim`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode, nodeId: `test-node-${crypto.randomBytes(4).toString('hex')}`,
          kind: 'local', cpu: 'TEST', gpu: 'TEST-none', capabilities: [], name }) });
      const json = await res.json().catch(() => null);
      if (behavior.pairFails || res.status !== 201 || !json || !json.resourceId) {
        return { status: 1, stdout: '', stderr: 'pairing failed (TEST seam)', timedOut: false };
      }
      state.paired = { resourceId: json.resourceId, key: json.heartbeatKey, url: json.heartbeatUrl, dir };
      writeFileSync(path.join(dir, 'heartbeat-key.txt'), 'TEST-only dummy secret');
      writeFileSync(path.join(dir, 'pairing.json'), JSON.stringify({ resource_id: json.resourceId }));
      return { status: 0, stdout: `paired: resource ${json.resourceId}\n`, stderr: '', timedOut: false };
    }
    if (args[0] === 'pairing.py' && args.includes('heartbeat-once')) {
      const dir = flag(args, '--data-dir');
      assert.ok(dir && state.paired && state.paired.dir === dir);
      if (behavior.beatFails) return { status: 1, stdout: '', stderr: 'heartbeat failed (TEST seam)', timedOut: false };
      const res = await fetch(`${behavior.baseUrl}${state.paired.url}`, { method: 'POST',
        headers: { Authorization: `Bearer ${state.paired.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usable: false }) });
      assert.equal(res.status, 200);
      return { status: 0, stdout: `heartbeat ok: usable=False at=${new Date().toISOString()}\n`, stderr: '', timedOut: false };
    }
    if (args[0] === 'inference_worker.py') {
      const dir = flag(args, '--data-dir');
      assert.ok(dir && state.paired && state.paired.dir === dir);
      assert.equal(flag(args, '--runtime-id'), behavior.expectRuntime || 'llama-server');
      assert.equal(flag(args, '--ganglion-base'), behavior.expectEndpoint || 'http://127.0.0.1:45679');
      assert.ok(args.includes('--once'));
      const next = await fetch(`${behavior.baseUrl}/api/worker/jobs/next`, {
        headers: { Authorization: `Bearer ${state.paired.key}` } });
      assert.equal(next.status, 200);
      const lease = await next.json();
      // Seam-side worker-validation simulation: the real worker rejects
      // anything but the strict bound envelope; the seam fails loudly too.
      assert.equal(lease.envelope && lease.envelope.protocol, 'aipster-bound-cpu-internal/1');
      assert.ok(lease.envelope.task && lease.envelope.binding);
      if (behavior.inferenceFails) {
        return { status: 1, stdout: '', stderr: 'jobs: worker error (TEST seam)', timedOut: false };
      }
      if (behavior.verdictFailed) {
        return { status: 0, stdout: `jobs: ${lease.job_id} failed [TEST_SEAM]\n`, stderr: '', timedOut: false };
      }
      const result = { request_id: lease.job_id, node_id: lease.envelope.task.placement.node_id,
        runtime_id: lease.envelope.task.placement.runtime_id, model_id: lease.envelope.task.model_id,
        runtime_instance: lease.envelope.binding.runtime_instance,
        model_fingerprint: lease.envelope.binding.model_fingerprint, simulated: false,
        content: FAKE_WORKER_CONTENT, elapsed_ms: 487,
        usage: { prompt_tokens: 5, completion_tokens: 3 }, cache: {} };
      const posted = await fetch(`${behavior.baseUrl}/api/worker/jobs/${lease.job_id}/result`, { method: 'POST',
        headers: { Authorization: `Bearer ${state.paired.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease_id: lease.lease_id, status: 'succeeded', result }) });
      assert.equal(posted.status, 200);
      writeFileSync(path.join(dir, 'jobs-started.json'), JSON.stringify({ job_ids: [lease.job_id] }));
      const printed = behavior.jobMismatch ? 'job_mismatched_print' : lease.job_id;
      return { status: 0, stdout: `jobs: ${printed} succeeded posted\n`, stderr: '', timedOut: false };
    }
    throw new Error('unexpected worker argv: ' + JSON.stringify(args));
  };
  return { runWorkerProc, calls, state };
}

// Fake browser seam: the SAME HTTP calls the UI Submit path makes, then a
// live handle (alive through settle, like the real CDP issuer). Settles
// through the REAL status route, exactly as the UI poll does.
function makeBrowserSeam(workerSeam, behavior = {}) {
  const events = [];
  const timing = {};
  const issueBrowserDispatch = async ({ harness, proposal, resourceId }) => {
    events.push('issue');
    assert.equal(resourceId, workerSeam.state.paired && workerSeam.state.paired.resourceId,
      'browser must target the paired resource');
    const S = { Cookie: harness.world.operator.cookie, 'X-Aipster-CSRF': '1' };
    const key = crypto.randomUUID();
    const doSubmit = async () => {
      const admRes = await fetch(`${harness.baseUrl}/api/inference/admissions`, { method: 'POST',
        headers: { ...S, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource_id: resourceId, model_id: proposal.model_id,
          max_tokens: proposal.max_tokens, runtime_id: proposal.runtime_id }) });
      assert.equal(admRes.status, 201);
      const adm = await admRes.json();
      const sub = await fetch(`${harness.baseUrl}/api/jobs`, { method: 'POST',
        headers: { ...S, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract_version: 'v1.0.0', admission_ref: adm.admission_ref,
          idempotency_key: key, model_id: proposal.model_id, prompt: proposal.prompt,
          max_tokens: proposal.max_tokens, deadline_at: Date.now() + proposal.deadline_s * 1000 }) });
      assert.equal(sub.status, 202);
      timing.submittedAt = Date.now();
    };
    // HOLD029 variants: yield the key before the job exists (like the real
    // UI, which writes the key line synchronously at click time).
    let submitted;
    if (behavior.neverSubmit) {
      submitted = new Promise(() => {});
    } else if (behavior.submitDelayMs) {
      submitted = (async () => {
        await new Promise((r) => setTimeout(r, behavior.submitDelayMs));
        await doSubmit();
      })();
    } else {
      await doSubmit();
      submitted = Promise.resolve();
    }
    return { idempotencyKey: key,
      waitForSettled: async () => {
        events.push('waitForSettled');
        await submitted;
        const rec = await fetch(`${harness.baseUrl}/api/jobs/${key}`, { headers: S });
        const body = await rec.json().catch(() => null);
        assert.equal(rec.status, 200);
        assert.equal(body.status, 'settled');
        assert.equal(body.outcome && body.outcome.finish, 'succeeded');
        assert.equal(body.outcome.released, true);
        const content = behavior.uiMismatch ? 'UI shows something else (TEST seam)' : body.outcome.content;
        return { statusText: 'Settled: content released: the operation settled.', content,
          provenance: 'TEST fake UI provenance line' };
      },
      screenshot: async (file) => { events.push(`screenshot:${path.basename(file)}`); writeFileSync(file, 'TEST-png-bytes'); },
      close: async () => { events.push('close'); } };
  };
  return { issueBrowserDispatch, events, timing };
}

function workerArgv(calls, script, sub) {
  return calls.filter((c) => c.args[0] === script && (sub === undefined || c.args.includes(sub)));
}

test('fixture: real-mode happy path through worker-CLI + browser seams', async () => {
  const { tmp, pins } = fixturePins('happy');
  const assembly = fixtureAssembly(tmp);
  const { file, sha, params } = writeProposal(tmp, pins);
  const markerPath = path.join(tmp, 'run.attempted');
  const spawns = [];
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18740' });
  const browserSeam = makeBrowserSeam(seam);
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha, markerPath,
    harnessOpts: { port: 18740 }, deps: { spawnChild: fakeChildFactory(spawns),
      engineRequest: fakeEngineRequest('TEST-model'), runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, true, out.reason);
  assert.ok(existsSync(markerPath), 'attempt marker persisted');
  // Engine: exactly one owned spawn with the pinned argv.
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].argv, params.engine.argv);
  // Worker CLIs: version + dendrite probes, then pair/heartbeat/--once once each.
  const pairs = workerArgv(seam.calls, 'pairing.py', 'pair');
  const beats = workerArgv(seam.calls, 'pairing.py', 'heartbeat-once');
  const runs = workerArgv(seam.calls, 'inference_worker.py');
  assert.equal(pairs.length, 1, 'exactly one pair claim (no retry)');
  assert.equal(beats.length, 1, 'exactly one heartbeat');
  assert.equal(runs.length, 1, 'exactly one worker --once (no retry)');
  assert.deepEqual(pairs[0].args.slice(0, 3), ['pairing.py', '--api-base', 'http://127.0.0.1:18740']);
  assert.ok(pairs[0].args.includes('--code') && pairs[0].args.includes('TEST-real-worker'));
  assert.equal(beats[0].args[1], '--data-dir');
  assert.deepEqual(runs[0].args.slice(3), ['--once', '--runtime-id', 'llama-server',
    '--ganglion-base', 'http://127.0.0.1:45679']);
  for (const c of seam.calls) {
    assert.equal(c.cwd, assembly.workerDir);
    if (c.pythonpath) assert.ok(c.pythonpath.split(path.delimiter)[0] === assembly.vendorDir);
  }
  // Browser stayed alive through settle: issue -> wait -> shot -> close.
  assert.deepEqual(browserSeam.events,
    ['issue', 'waitForSettled', 'screenshot:real-settled.png', 'close']);
  const receipt = JSON.parse(readFileSync(out.receipt, 'utf8'));
  assert.equal(receipt.mode, 'real-approved');
  assert.equal(receipt.proposal_sha256, sha);
  assert.deepEqual(receipt.engine.argv, params.engine.argv);
  assert.deepEqual(receipt.outcome, { dispatched: true, harnessPosted: false, workerPosted: true,
    workerVerdict: 'succeeded', engineCalls: 2, ledgerCount: 1, usable: 'False', workerDataRemoved: true });
  // Harness-posts-nothing is structural (executeRealRun contains no result
  // post); the receipt records it and the worker seam did the one post.
  assert.equal(receipt.settled.content, FAKE_WORKER_CONTENT);
  assert.equal(receipt.settled.provenance.simulated, false);
  assert.equal(receipt.worker.python_version, '3.12.9');
  assert.ok(receipt.worker.dendrite.file.startsWith(assembly.vendorDir));
  const pairCall = receipt.worker.calls.find((c) => c.argv.includes('pair'));
  const codeIdx = pairCall.argv.indexOf('--code');
  assert.equal(pairCall.argv[codeIdx + 1], '<redacted>', 'pairing code redacted in receipt');
  const dataDirIdx = pairCall.argv.indexOf('--data-dir');
  assert.ok(!existsSync(pairCall.argv[dataDirIdx + 1]), 'worker datadir shredded after ledger read');
  const text = readFileSync(out.receipt, 'utf8');
  assert.ok(!/bearer|session_token|cookie/i.test(text), 'no credential material in receipt');
  assert.ok(existsSync(path.join(path.dirname(out.receipt), 'real-settled.png')), 'settled screenshot kept');
});

test('fixture: models-missing-alias refuses before any worker pairing', async () => {
  const { tmp, pins } = fixturePins('models');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18741' });
  const engineRequest = async (method, url) => {
    if (url.endsWith('/health')) return { status: 200, json: {}, text: '{}' };
    return { status: 200, json: { data: [{ id: 'OTHER-model' }] }, text: '{}' };
  };
  let issued = 0;
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18741 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest, runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { issued += 1; throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /do not list alias/);
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'pair').length, 0, 'no pair attempted');
  assert.equal(issued, 0);
  assert.ok(out.receipt && existsSync(out.receipt), 'failure receipt retained');
  assert.match(readFileSync(out.receipt, 'utf8'), /do not list alias/);
});

test('fixture: stale dendrite resolution refuses before engine spawn', async () => {
  const { tmp, pins } = fixturePins('dendrite');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18742',
    dendritePath: 'C:\\stale-venv\\Lib\\site-packages\\dendrite\\__init__.py' });
  const spawns = [];
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18742 },
    deps: { spawnChild: fakeChildFactory(spawns), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /dendrite resolved outside candidate vendor/);
  assert.equal(spawns.length, 0, 'no engine spawn after provenance refusal');
  assert.ok(out.receipt && existsSync(out.receipt), 'failure receipt retained');
});

test('fixture: unhealthy engine refuses pre-dispatch and kills the child', async () => {
  const { tmp, pins } = fixturePins('health');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins, { max_lifetime_s: 2 });
  const markerPath = path.join(tmp, 'run.attempted');
  const spawns = [];
  let childRef = null;
  const spawnChild = (...a) => { const c = fakeChildFactory(spawns)(...a); childRef = c; return c; };
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18742' });
  let issued = 0;
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha, markerPath,
    harnessOpts: { port: 18742 }, deps: { spawnChild,
      engineRequest: async () => ({ status: 500, json: null, text: 'bad' }),
      runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { issued += 1; throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /health never ok/);
  assert.equal(spawns.length, 1);
  assert.deepEqual(childRef.kills, ['SIGTERM']);
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'pair').length, 0, 'no pair attempted');
  assert.equal(issued, 0, 'no dispatch attempted');
  assert.ok(existsSync(markerPath), 'failed attempt still consumes the marker');
});

test('fixture: pair claim failure aborts before dispatch and shreds the datadir', async () => {
  const { tmp, pins } = fixturePins('pairfail');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18740', pairFails: true });
  let issued = 0;
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18740 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { issued += 1; throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /pair claim failed/);
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'pair').length, 1, 'single attempt, no retry');
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'heartbeat-once').length, 0);
  assert.equal(issued, 0);
  const receipt = JSON.parse(readFileSync(out.receipt, 'utf8'));
  assert.equal(receipt.mode, 'real-approved');
  assert.match(receipt.failure, /pair claim failed/);
  const pairCall = receipt.worker.calls.find((c) => c.argv.includes('pair'));
  const dataDirIdx = pairCall.argv.indexOf('--data-dir');
  assert.ok(!existsSync(pairCall.argv[dataDirIdx + 1]), 'failed-run datadir still shredded');
});

test('fixture: heartbeat failure aborts before dispatch', async () => {
  const { tmp, pins } = fixturePins('beatfail');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18741', beatFails: true });
  let issued = 0;
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18741 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { issued += 1; throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /heartbeat failed/);
  assert.equal(issued, 0);
});

test('fixture: worker exit without post leaves the job unsettled, no retry (DB-verified)', async () => {
  const { tmp, pins } = fixturePins('nopost');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const dbPath = path.join(tmp, 'demo.sqlite');
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18743', inferenceFails: true });
  const browserSeam = makeBrowserSeam(seam);
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18743, dbPath },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /did not post a result/);
  assert.match(out.reason, /no retry/);
  assert.equal(workerArgv(seam.calls, 'inference_worker.py').length, 1, 'single worker run, no retry');
  assert.deepEqual(browserSeam.events, ['issue', 'screenshot:real-terminal.png', 'close'],
    'browser stayed alive through the outcome, terminal UI captured, then closed');
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT status, result_json FROM dispatch_jobs').get();
    assert.ok(row, 'job row exists');
    assert.equal(row.result_json, null, 'unknown outcome posts NOTHING');
    assert.ok(['queued', 'leased'].includes(row.status), `job left ${row.status}, never settled`);
  } finally {
    db.close();
  }
});

test('fixture: worker failed verdict aborts closed with a single run', async () => {
  const { tmp, pins } = fixturePins('wfail');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const dbPath = path.join(tmp, 'demo.sqlite');
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18740', verdictFailed: true });
  const browserSeam = makeBrowserSeam(seam);
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18740, dbPath },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /reported its run failed/);
  assert.match(out.reason, /no retry/);
  assert.equal(workerArgv(seam.calls, 'inference_worker.py').length, 1);
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT result_json FROM dispatch_jobs').get();
    assert.equal(row.result_json, null, 'failed verdict posts NOTHING');
  } finally {
    db.close();
  }
});

test('fixture: worker post for another job is an anomaly, no retry', async () => {
  const { tmp, pins } = fixturePins('mismatch');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18741', jobMismatch: true });
  const browserSeam = makeBrowserSeam(seam);
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18741 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /ANOMALY/);
  assert.equal(workerArgv(seam.calls, 'inference_worker.py').length, 1, 'no retry on anomaly');
});

test('fixture: UI content differing from the posted row is an anomaly', async () => {
  const { tmp, pins } = fixturePins('uimismatch');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18742' });
  const browserSeam = makeBrowserSeam(seam, { uiMismatch: true });
  let receiptDir = null;
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18742 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /different content/);
  receiptDir = path.dirname(out.receipt);
  assert.ok(!existsSync(path.join(receiptDir, 'real-settled.png')), 'no success screenshot on anomaly');
  assert.ok(existsSync(path.join(receiptDir, 'real-terminal.png')), 'terminal UI captured on anomaly');
});

test('fixture: existing marker / bad confirm / tampered file refuse pre-spawn', async () => {
  const { tmp, pins } = fixturePins('marker');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const markerPath = path.join(tmp, 'run.attempted');
  let spawns = 0;
  let procs = 0;
  const deps = () => ({ spawnChild: () => { spawns += 1; throw new Error('must not spawn'); },
    runWorkerProc: async () => { procs += 1; throw new Error('must not run worker'); },
    candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit });
  const badConfirm = await executeRealRun({ proposalFile: file, confirmSha256: '0'.repeat(64),
    markerPath, harnessOpts: { port: 18743 }, deps: deps() });
  assert.equal(badConfirm.ok, false);
  assert.match(badConfirm.reason, /confirmation missing/);
  assert.ok(!existsSync(markerPath));
  writeFileSync(markerPath, JSON.stringify({ sha256: sha, at: 'preexisting' }));
  const reused = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath, harnessOpts: { port: 18743 }, deps: deps() });
  assert.equal(reused.ok, false);
  assert.match(reused.reason, /single-use/);
  const tamperedFile = path.join(tmp, 'tampered.json');
  const tampered = JSON.parse(JSON.stringify({ proposal: { max_tokens: 33 }, sha256: sha }));
  writeFileSync(tamperedFile, JSON.stringify(tampered));
  const badFile = await executeRealRun({ proposalFile: tamperedFile, confirmSha256: sha,
    markerPath: path.join(tmp, 'other.attempted'), harnessOpts: { port: 18743 }, deps: deps() });
  assert.equal(badFile.ok, false);
  assert.match(badFile.reason, /mismatch|must be/);
  assert.equal(spawns, 0, 'no engine spawn on gate refusal');
  assert.equal(procs, 0, 'no worker process on gate refusal');
});

test('unit: resolveWorkerProvenance pins scripts, interpreter, and dendrite', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'private-demo-rm-prov-'));
  const assembly = fixtureAssembly(tmp);
  const seen = [];
  const runProc = async (bin, args, opts = {}) => {
    seen.push({ bin, args, cwd: opts.cwd, env: opts.env || null });
    if (String(args[1]).includes('sys.executable')) {
      return { status: 0, stdout: '3.12.9\nC:\\TEST\\python.exe\n', stderr: '', timedOut: false };
    }
    return { status: 0, stdout: assembly.dendriteInit + '\n', stderr: '', timedOut: false };
  };
  const prov = await resolveWorkerProvenance({ root: assembly.root, runProc });
  assert.equal(prov.pythonVersion, '3.12.9');
  assert.equal(prov.pythonExecutable, 'C:\\TEST\\python.exe');
  assert.equal(prov.workerDir, assembly.workerDir);
  assert.equal(prov.scripts.pairing.sha256,
    crypto.createHash('sha256').update('# TEST fixture pairing\n').digest('hex'));
  assert.equal(prov.dendrite.file, assembly.dendriteInit);
  assert.equal(seen.length, 2);
  // Missing candidate file is a refusal.
  await assert.rejects(() => resolveWorkerProvenance({ root: path.join(tmp, 'nope'), runProc }),
    /candidate file missing/);
});

test('unit: sanitizeArgv redacts the pairing code but keeps engine argv intact', () => {
  assert.deepEqual(
    sanitizeArgv(['python', 'pairing.py', '--api-base', 'http://127.0.0.1:18740', '--data-dir', 'D',
      'pair', '--code', 'SECRET-CODE-VALUE', '--name', 'w']),
    ['python', 'pairing.py', '--api-base', 'http://127.0.0.1:18740', '--data-dir', 'D',
      'pair', '--code', '<redacted>', '--name', 'w']);
  const engine = ['-m', 'C:\\m\\model.gguf', '--port', '45679', '--alias', 'TEST-model', '--n-gpu-layers', '0'];
  assert.deepEqual(sanitizeArgv(engine), engine);
});

test('unit: proposal deadline must be UI-expressible (30 or 60)', () => {
  const { tmp, pins } = fixturePins('deadline');
  const base = { model_id: 'TEST-model', runtime_id: 'llama-server', endpoint: 'http://127.0.0.1:45679',
    max_tokens: 32, prompt: 'Say the word hello.', max_lifetime_s: 300,
    engine: { path: pins.engine.path,
      argv: ['-m', pins.gguf.path, '--port', '45679', '--alias', 'TEST-model', '--n-gpu-layers', '0'] },
    gguf: { path: pins.gguf.path } };
  assert.equal(buildProposal({ ...base, deadline_s: 45 }, { candidateRevOverride: 'rev-rm', pins }).ok, false);
  assert.equal(buildProposal({ ...base, deadline_s: 30 }, { candidateRevOverride: 'rev-rm', pins }).ok, true);
  assert.equal(buildProposal({ ...base, deadline_s: 60 }, { candidateRevOverride: 'rev-rm', pins }).ok, true);
  void tmp;
});

test('fixture: F2 dirty candidate refuses pre-marker with no spawn or worker run', async () => {
  const { tmp, pins } = fixturePins('f2exec');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const markerPath = path.join(tmp, 'run.attempted');
  const spawns = [];
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18740' });
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha, markerPath,
    harnessOpts: { port: 18740 },
    deps: { spawnChild: fakeChildFactory(spawns), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc,
      issueBrowserDispatch: async () => { throw new Error('must not issue'); },
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root,
      runGit: () => ' M website/src/worker.js\n' } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /dirty/);
  assert.ok(!existsSync(markerPath), 'one-use attempt NOT consumed by a dirty-tree refusal');
  assert.equal(spawns.length, 0, 'no engine spawn');
  assert.equal(seam.calls.length, 0, 'no worker process (not even provenance probes)');
});

test('fixture: HOLD029 real-mode — worker waits for the delayed keyed job (no early invocation)', async () => {
  const { tmp, pins } = fixturePins('rmkeyed');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins);
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18740' });
  const browserSeam = makeBrowserSeam(seam, { submitDelayMs: 400 });
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18740 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, true, out.reason);
  const runs = workerArgv(seam.calls, 'inference_worker.py');
  assert.equal(runs.length, 1, 'exactly one worker run for the correct job');
  assert.ok(typeof browserSeam.timing.submittedAt === 'number');
  assert.ok(runs[0].at >= browserSeam.timing.submittedAt,
    'worker invoked only after the keyed job was queued (no early lease)');
});

test('fixture: HOLD029 real-mode — unqueued key aborts before worker invocation', async () => {
  const { tmp, pins } = fixturePins('rmkeyed-out');
  const assembly = fixtureAssembly(tmp);
  const { file, sha } = writeProposal(tmp, pins, { max_lifetime_s: 2 });
  const seam = makeWorkerSeam(assembly, { baseUrl: 'http://127.0.0.1:18741' });
  const browserSeam = makeBrowserSeam(seam, { neverSubmit: true });
  const out = await executeRealRun({ proposalFile: file, confirmSha256: sha,
    markerPath: path.join(tmp, 'run.attempted'), harnessOpts: { port: 18741 },
    deps: { spawnChild: fakeChildFactory([]), engineRequest: fakeEngineRequest('TEST-model'),
      runWorkerProc: seam.runWorkerProc, issueBrowserDispatch: browserSeam.issueBrowserDispatch,
      candidateRevOverride: 'rev-rm', pins, assemblyRoot: assembly.root, runGit: cleanGit } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /never queued/);
  assert.match(out.reason, /no worker invocation/);
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'pair').length, 1, 'pairing completed first');
  assert.equal(workerArgv(seam.calls, 'pairing.py', 'heartbeat-once').length, 1);
  assert.equal(workerArgv(seam.calls, 'inference_worker.py').length, 0, 'worker never invoked, no retry');
  assert.deepEqual(browserSeam.events, ['issue', 'screenshot:real-terminal.png', 'close']);
});
