"""Cross-language reporter probe for website/review-tests/.

Runs the REAL local-worker reporter against a real dendrite TOML fixture.
Structured argv only; never paste paths into evaluated code here.

Usage:
    python reporter_probe.py report <toml_path>
        Print build_capability_report(toml_path) as JSON.
    python reporter_probe.py models <runtime_name> <model_id> [<model_id> ...]
        Print runtime_models_entry(runtime_name, [model ids]) as JSON.

Prerequisites (see ../review-tests/README.md): an interpreter able to import
`dendrite` (vendored under local-worker/vendor/eif) plus
pydantic==2.14.2 and psutil==7.2.2; the Node caller invokes this through
`uv run --with pydantic==2.14.2 --with psutil==7.2.2 --no-project`.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_WORKER = os.path.normpath(os.path.join(HERE, "..", "..", "local-worker"))
for entry in (
    os.path.join(LOCAL_WORKER, "vendor", "eif"),
    LOCAL_WORKER,
):
    if entry not in sys.path:
        sys.path.insert(0, entry)


def main(argv):
    if len(argv) < 3 or argv[1] not in ("report", "models"):
        raise SystemExit("usage: reporter_probe.py report <toml> | models <name> <id> [id ...]")
    if argv[1] == "report":
        from pairing import build_capability_report

        print(json.dumps(build_capability_report(argv[2])))
        return
    from model_readiness import runtime_models_entry

    print(json.dumps(runtime_models_entry(argv[2], argv[3:])))


if __name__ == "__main__":
    main(sys.argv)
