"""Focused completion-smoke-v1 benchmark tests (meta-qual lane). Fixtures only."""
import unittest
from datetime import datetime, timedelta, timezone

import benchmark as bench
from benchmark import BenchmarkError, ObservedClient, native_timings
from inference_worker import GanglionError


def assignment(**over):
    base = {
        "runId": "qrun_1",
        "nodeId": "res1",
        "profileDigest": "a" * 64,
        "catalogVersion": "qual-catalog-v1",
        "catalogId": "completion-smoke-v1",
        "leaseId": "qlease_1",
        "deadlineAt": "2026-11-05T06:00:00.000Z",
        "runtimeAllowlist": ["ganglion"],
        "maxTokens": 32,
    }
    base.update(over)
    return base


NOW = datetime(2026, 11, 5, 5, 0, 0, tzinfo=timezone.utc)
FUTURE = "2026-11-05T06:00:00.000Z"


def timings_body(**over):
    body = {
        "model": "m",
        "choices": [{"text": "ok", "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 32,
                  "timings": {"prompt_n": 10, "prompt_ms": 500.0,
                              "predicted_n": 32, "predicted_ms": 1000.0}},
    }
    body.update(over)
    return body


class ScriptedUpstream(ObservedClient):
    """ObservedClient with a scripted upstream: no network, full evidence."""

    def __init__(self, models=None, bodies=None, fail_models=None):
        super().__init__("http://127.0.0.1:8471")
        self._script_models = models if models is not None else ["m"]
        self._bodies = list(bodies) if bodies is not None else [timings_body()]
        self.fail_models = fail_models
        self.prompts = []

    def models(self):
        if self.fail_models:
            raise self.fail_models
        return list(self._script_models)

    def _post(self, path, payload, deadline_monotonic):
        if path == "/v1/models":
            raise AssertionError("models() must not hit the wire here")
        body = self._bodies.pop(0) if self._bodies else timings_body()
        if path in ("/v1/completions", "/v1/chat/completions"):
            self.prompts.append(payload)
        self.seen.append({"path": path, "status": 200, "body": body})
        return 200, body


def run(client=None, **over):
    kw = {"assignment": assignment(), "model_id": "m",
          "runtime_id": "ganglion", "base_url": "http://127.0.0.1:8471",
          "mem_total_bytes": 8 << 30, "mem_avail_bytes": 4 << 30,
          "now": NOW}
    kw.update(over)
    if client is None:
        client = ScriptedUpstream()
    kw["client"] = client
    return bench.run_benchmark(**kw)


class TimingsTest(unittest.TestCase):
    def test_coherent_pairs_preserved(self):
        out = run()
        self.assertEqual(out["nativeTimings"],
                         {"promptN": 10, "promptMs": 500.0,
                          "predictedN": 32, "predictedMs": 1000.0})
        self.assertEqual(out["finishReason"], "stop")
        self.assertEqual(out["completionTokens"], 32)

    def test_missing_timings_without_counts_is_unmeasurable(self):
        client = ScriptedUpstream(bodies=[{"model": "m",
                                           "choices": [{"text": "ok"}],
                                           "usage": {"prompt_tokens": 5}}])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_absent_timings_with_valid_count_succeeds_unmeasured(self):
        client = ScriptedUpstream(bodies=[{"model": "m",
                                           "choices": [{"text": "ok"}],
                                           "usage": {"prompt_tokens": 5,
                                                     "completion_tokens": 30}}])
        out = run(client=client)
        self.assertNotIn("nativeTimings", out)
        self.assertEqual(out["completionTokens"], 30)

    def test_absent_timings_is_none(self):
        self.assertIsNone(native_timings({}, 32))
        self.assertIsNone(native_timings({"prompt_tokens": 1}, None))

    def test_rejects_bad_pairs(self):
        for timings in ({"predicted_n": 32},
                        {"prompt_n": 10, "prompt_ms": 500.0,
                         "predicted_n": True, "predicted_ms": 1000.0},
                        {"prompt_n": 10, "prompt_ms": 500.0,
                         "predicted_n": 32, "predicted_ms": float("nan")},
                        {"prompt_n": 10, "prompt_ms": float("inf"),
                         "predicted_n": 32, "predicted_ms": 1000.0},
                        {"prompt_n": -1, "prompt_ms": 500.0,
                         "predicted_n": 32, "predicted_ms": 1000.0},
                        {"prompt_n": 10, "prompt_ms": 0,
                         "predicted_n": 32, "predicted_ms": 1000.0},
                        {"prompt_n": 10, "prompt_ms": 500.0,
                         "predicted_n": 33, "predicted_ms": 1000.0},
                        {"prompt_n": 10, "prompt_ms": 500.0,
                         "predicted_n": 31.5, "predicted_ms": 1000.0}):
            usage = {"timings": timings}
            with self.assertRaises(BenchmarkError, msg=timings) as ctx:
                native_timings(usage, 32)
            self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_inconsistent_counts_rejected(self):
        usage = {"completion_tokens": 31,
                 "timings": {"prompt_n": 10, "prompt_ms": 500.0,
                             "predicted_n": 32, "predicted_ms": 1000.0}}
        with self.assertRaises(BenchmarkError) as ctx:
            native_timings(usage, 31)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_over_catalog_completion_is_unmeasurable(self):
        client = ScriptedUpstream(bodies=[{"model": "m",
                                           "choices": [{"text": "ok"}],
                                           "usage": {"completion_tokens": 64,
                                                     "timings": {
                                                         "prompt_n": 10,
                                                         "prompt_ms": 500.0,
                                                         "predicted_n": 32,
                                                         "predicted_ms": 1000.0}}}])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_missing_served_echo_is_unverifiable(self):
        body = timings_body()
        del body["model"]
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=ScriptedUpstream(bodies=[body]))
        self.assertEqual(ctx.exception.reason, "MODEL_MISMATCH")


class ModelsErrorTest(unittest.TestCase):
    """Real ObservedClient.models() failure paths (P1-2 repros)."""

    def _client(self):
        client = ObservedClient("http://127.0.0.1:8471")
        client.phase_deadline = __import__("time").monotonic() + 30.0
        return client

    def test_transport_error_raises_ganglion_error(self):
        import pairing
        import benchmark as bench_mod
        from inference_worker import GanglionError
        orig = bench_mod.get_json

        def boom(*a, **k):
            raise pairing.PairingError(None, "NET_DOWN", "no route")

        bench_mod.get_json = boom
        try:
            with self.assertRaises(GanglionError):
                self._client().models()
        finally:
            bench_mod.get_json = orig

    def test_non200_and_empty_list_raise_ganglion_error(self):
        import benchmark as bench_mod
        from inference_worker import GanglionError
        orig = bench_mod.get_json
        try:
            bench_mod.get_json = lambda *a, **k: (401, {}, None)
            with self.assertRaises(GanglionError):
                self._client().models()
            bench_mod.get_json = lambda *a, **k: (200, {"data": []}, None)
            with self.assertRaises(GanglionError):
                self._client().models()
        finally:
            bench_mod.get_json = orig

    def test_boundary_maps_models_failure_to_unavailable(self):
        import benchmark as bench_mod
        from inference_worker import GanglionError
        orig = bench_mod.get_json
        bench_mod.get_json = lambda *a, **k: (500, {}, None)
        try:
            with self.assertRaises(BenchmarkError) as ctx:
                run(client=self._client())
        finally:
            bench_mod.get_json = orig
        self.assertEqual(ctx.exception.reason, "UPSTREAM_UNAVAILABLE")

    def test_elapsed_phase_budget_refuses_without_wire(self):
        import benchmark as bench_mod
        calls = []
        orig = bench_mod.get_json
        bench_mod.get_json = lambda *a, **k: (calls.append(1), (200, {"data": [{"id": "m"}]}, None))[1]
        try:
            client = self._client()
            client.phase_deadline = __import__("time").monotonic() - 1.0
            from inference_worker import GanglionError
            with self.assertRaises(GanglionError):
                client.models()
        finally:
            bench_mod.get_json = orig
        self.assertEqual(calls, [])


class VerificationTest(unittest.TestCase):
    def test_simulated_upstream_refused(self):
        body = timings_body()
        body["simulated"] = True
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=ScriptedUpstream(bodies=[body]))
        self.assertEqual(ctx.exception.reason, "SIMULATED")

    def test_model_alias_refused(self):
        body = timings_body()
        body["model"] = "cloud-alias-7b"
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=ScriptedUpstream(bodies=[body]))
        self.assertEqual(ctx.exception.reason, "MODEL_MISMATCH")

    def test_model_echo_match_ok(self):
        out = run()
        self.assertEqual(out["modelId"], "m")

    def test_refusals(self):
        with self.assertRaises(BenchmarkError):
            run(client=ScriptedUpstream(models=["other"]))
        with self.assertRaises(BenchmarkError):
            run(assignment=assignment(), runtime_id="llama-server")
        slow = ScriptedUpstream()
        slow.complete = lambda *a: (_ for _ in ()).throw(
            GanglionError("GANGLION_TIMEOUT", "t"))
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=slow)
        self.assertEqual(ctx.exception.reason, "TIMED_OUT")


class PhaseBudgetTest(unittest.TestCase):
    def test_slow_models_deducts_from_fixed_now(self):
        ticks = [1000.0]

        def tick():
            return ticks[0]

        client = ScriptedUpstream()
        instant_models = client.models

        def slow_models():
            ticks[0] += 10.0  # readiness consumed 10 monotonic seconds
            return instant_models()

        client.models = slow_models
        # Fixed wall snapshot leaves 5s; readiness ate 10 monotonic seconds.
        far = (NOW + timedelta(seconds=5)).isoformat()
        with self.assertRaises(BenchmarkError) as ctx:
            bench.run_benchmark(
                assignment=assignment(deadlineAt=far), model_id="m",
                runtime_id="ganglion", base_url="http://127.0.0.1:8471",
                mem_total_bytes=8 << 30, mem_avail_bytes=4 << 30,
                now=NOW, clock=tick, client=client)
        self.assertEqual(ctx.exception.reason, "EXPIRED")
        self.assertEqual(client.prompts, [])


class DeadlineMemoryTest(unittest.TestCase):
    def test_expired_assignment_refused(self):
        past = (NOW - timedelta(seconds=1)).isoformat()
        with self.assertRaises(BenchmarkError) as ctx:
            run(assignment=assignment(deadlineAt=past))
        self.assertEqual(ctx.exception.reason, "EXPIRED")

    def test_non_utc_offset_enforced(self):
        # 05:30 local is 00:00 UTC: past relative to NOW.
        with self.assertRaises(BenchmarkError) as ctx:
            run(assignment=assignment(deadlineAt="2026-11-05T05:30:00+05:30"))
        self.assertEqual(ctx.exception.reason, "EXPIRED")
        # A future instant in a non-UTC offset is accepted.
        out = run(assignment=assignment(deadlineAt="2026-11-05T11:30:00+05:30"))
        self.assertEqual(out["runtimeId"], "ganglion")

    def test_naive_clock_and_deadline_refused(self):
        import qualification as qual
        with self.assertRaises(BenchmarkError):
            run(now=NOW.replace(tzinfo=None))
        with self.assertRaises(qual.QualificationError):
            qual.validate_assignment(
                assignment(deadlineAt="2026-11-05T06:00:00"))

    def test_available_memory_rechecked(self):
        with self.assertRaises(BenchmarkError) as ctx:
            run(mem_avail_bytes=128 * 1024 * 1024)
        self.assertEqual(ctx.exception.reason, "MEMORY_UNVERIFIED")
        with self.assertRaises(BenchmarkError):
            run(mem_avail_bytes=None)
        with self.assertRaises(BenchmarkError):
            run(mem_total_bytes=512 * 1024 * 1024)


class NativeAliasTest(unittest.TestCase):
    """Native upstream identity: listing, request and echo speak the
    upstream_model; the result reports the configured id plus the actually
    served identity and an explicit placement provenance."""

    def test_alias_listing_request_echo_bind(self):
        client = ScriptedUpstream(models=["m-up"],
                                  bodies=[timings_body(model="m-up")])
        out = run(client=client, upstream_model="m-up",
                  placement_provenance="unknown")
        self.assertEqual(out["modelId"], "m")
        self.assertEqual(out["servedModelId"], "m-up")
        self.assertEqual(out["placementProvenance"], "unknown")
        self.assertEqual(client.prompts[0]["model"], "m-up",
                         "upstream requested under its native identity")
        self.assertNotIn("placement", out,
                         "no placement certificate key, ever")

    def test_identical_bound_identity_retains_placement_provenance(self):
        for provenance in ("unknown", "operator-declared"):
            with self.subTest(provenance=provenance):
                client = ScriptedUpstream(models=["m"],
                                          bodies=[timings_body(model="m")])
                out = run(client=client, upstream_model="m",
                          placement_provenance=provenance)
                self.assertEqual(out["modelId"], "m")
                self.assertEqual(out["servedModelId"], "m")
                self.assertEqual(out["placementProvenance"], provenance)
                self.assertNotIn("placement", out)

    def test_alias_echo_of_configured_id_is_mismatch(self):
        # The upstream echoing the configured id is NOT the identity we
        # requested: alias confusion refuses closed.
        client = ScriptedUpstream(models=["m-up"],
                                  bodies=[timings_body(model="m")])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client, upstream_model="m-up")
        self.assertEqual(ctx.exception.reason, "MODEL_MISMATCH")

    def test_alias_not_listed_is_not_ready(self):
        client = ScriptedUpstream(models=["other"])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client, upstream_model="m-up")
        self.assertEqual(ctx.exception.reason, "NOT_READY")

    def test_provenance_only_under_claims_never_certifies(self):
        client = ScriptedUpstream(models=["m-up"],
                                  bodies=[timings_body(model="m-up")])
        out = run(client=client, upstream_model="m-up",
                  placement_provenance="operator-declared")
        self.assertEqual(out["placementProvenance"], "operator-declared")
        for bogus in ("verifiedCPU", "cpu", "", None, 0):
            client = ScriptedUpstream(models=["m-up"],
                                      bodies=[timings_body(model="m-up")])
            out = run(client=client, upstream_model="m-up",
                      placement_provenance=bogus)
            self.assertEqual(out["placementProvenance"], "unknown")

    def test_legacy_path_has_no_alias_keys(self):
        out = run()
        self.assertNotIn("servedModelId", out)
        self.assertNotIn("placementProvenance", out)


LLAMA_TOP = {"prompt_n": 12, "prompt_ms": 400.0,
             "predicted_n": 32, "predicted_ms": 1600.0,
             "predicted_per_second": 20.0}


def llama_body(**over):
    body = {"model": "m", "choices": [{"text": "ok", "finish_reason": "length"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 32},
            "timings": dict(LLAMA_TOP)}
    body.update(over)
    return body


class TopLevelTimingsTest(unittest.TestCase):
    """Direct-llama top-level `timings` are preserved when present."""

    def test_top_level_timings_preserved_with_extra_keys(self):
        client = ScriptedUpstream(bodies=[llama_body()])
        out = run(client=client)
        self.assertEqual(out["nativeTimings"],
                         {"promptN": 12, "promptMs": 400.0,
                          "predictedN": 32, "predictedMs": 1600.0})
        self.assertEqual(out["completionTokens"], 32)

    def test_top_level_without_usage_counts_succeeds_measured(self):
        body = llama_body()
        del body["usage"]
        client = ScriptedUpstream(bodies=[body])
        out = run(client=client)
        self.assertEqual(out["nativeTimings"]["predictedN"], 32)
        self.assertNotIn("completionTokens", out)

    def test_top_level_incoherent_refused(self):
        bad = dict(LLAMA_TOP, predicted_ms=float("nan"))
        client = ScriptedUpstream(bodies=[llama_body(timings=bad)])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_top_level_disagreeing_with_counts_refused(self):
        body = llama_body(timings=dict(LLAMA_TOP, predicted_n=30))
        client = ScriptedUpstream(bodies=[body])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_bad_usage_timings_never_fall_back_to_top(self):
        body = llama_body(usage={"prompt_tokens": 12, "completion_tokens": 32,
                                 "timings": {"predicted_n": 1}})
        client = ScriptedUpstream(bodies=[body])
        with self.assertRaises(BenchmarkError) as ctx:
            run(client=client)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_usage_timings_win_over_top_level(self):
        usage_t = {"prompt_n": 5, "prompt_ms": 100.0,
                   "predicted_n": 10, "predicted_ms": 500.0}
        body = llama_body(usage={"prompt_tokens": 5, "completion_tokens": 10,
                                 "timings": usage_t})
        client = ScriptedUpstream(bodies=[body])
        out = run(client=client)
        self.assertEqual(out["nativeTimings"]["predictedN"], 10)


class EmptyContentTest(unittest.TestCase):
    """Reasoning-only generation at the cap: genuine native timings measure;
    fabricated or absent timings never become success."""

    def empty_body(self, **over):
        body = {"model": "m-up",
                "choices": [{"text": "   ", "finish_reason": "length"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 32},
                "timings": dict(LLAMA_TOP)}
        body.update(over)
        return body

    def alias_run(self, body):
        return run(client=ScriptedUpstream(models=["m-up"], bodies=[body]),
                   upstream_model="m-up", placement_provenance="unknown")

    def test_reasoning_only_measures_from_real_timings(self):
        out = self.alias_run(self.empty_body())
        self.assertEqual(out["modelId"], "m")
        self.assertEqual(out["servedModelId"], "m-up")
        self.assertEqual(out["nativeTimings"]["predictedN"], 32)
        self.assertEqual(out["completionTokens"], 32)
        self.assertEqual(out["finishReason"], "length")

    def test_empty_without_timings_stays_failed(self):
        body = self.empty_body()
        del body["timings"]
        body["usage"] = {"prompt_tokens": 12, "completion_tokens": 32}
        with self.assertRaises(BenchmarkError) as ctx:
            self.alias_run(body)
        self.assertEqual(ctx.exception.reason, "UPSTREAM_ERROR")

    def test_empty_with_fabricated_timings_refused(self):
        body = self.empty_body(timings=dict(LLAMA_TOP, predicted_n=7))
        with self.assertRaises(BenchmarkError) as ctx:
            self.alias_run(body)
        self.assertEqual(ctx.exception.reason, "UNMEASURABLE")

    def test_empty_simulated_is_unsupported(self):
        body = self.empty_body(simulated=True)
        with self.assertRaises(BenchmarkError) as ctx:
            self.alias_run(body)
        self.assertEqual(ctx.exception.reason, "SIMULATED")

    def test_empty_echo_mismatch(self):
        body = self.empty_body(model="other")
        with self.assertRaises(BenchmarkError) as ctx:
            self.alias_run(body)
        self.assertEqual(ctx.exception.reason, "MODEL_MISMATCH")


if __name__ == "__main__":
    unittest.main()
