# Cross-language reporter review — prerequisites and invocation

This directory is OUTSIDE the default Node suite (`npm test` runs
`tests/*.test.mjs` only). Run it explicitly:

```
node --test review-tests/qualification-reporter-review.test.mjs
```

from `website/`.

## Prerequisites (fail loudly, never silently skipped)

- `uv` on PATH (https://docs.astral.sh/uv/). The test asserts this first and
  fails with setup instructions when `uv` is missing.
- Pinned, on first use fetched by uv (subsequent runs use the uv cache):
  `pydantic==2.14.2`, `psutil==7.2.2`, via
  `uv run --with pydantic==2.14.2 --with psutil==7.2.2 --no-project`.
- No project virtualenv is created and the system interpreter is untouched.

## What it proves

`reporter_probe.py` (structured argv only, no code interpolation) drives the
REAL `local-worker` reporter (`build_capability_report`,
`runtime_models_entry`) against a real dendrite TOML fixture, and the test
feeds the produced JSON through the real intake validation, `normalizeProfile`,
`eligibleCatalog`, and the full post -> lease -> runner-shaped result chain
on isolated real Miniflare D1 via the actual `worker.js` fetch transport.
