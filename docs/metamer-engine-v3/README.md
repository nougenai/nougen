# NouGenAI Metamer Engine v3 — executable reference

This **local-only, non-production** Python 3.12+ prototype provides:

- Seven-stage deterministic state machine with typed invariant contract.
- SQLite WAL transactional stage persistence and hash-linked event journal.
- Fail-closed action authorization (no live execution or connected services).
- Stage evidence shape checks, lifecycle terminal states, restart replay and tamper checks.
- Standard library only, no network or external dependency.

## Run tests

From this directory:

```bash
python -m unittest discover -s tests -v
```

## Example

```python
from metamer.core import Contract, Engine
engine = Engine('local-metamer.sqlite')
engine.start('example-1', Contract('Improve search latency', ('No tenant leakage', 'Result correctness')))
print(engine.state('example-1'))
engine.close()
```

## Security and engineering boundaries

This is a **reference skeleton**, not a live multi-agent runtime. In particular:

- `advance()` validates evidence *shape*, not authenticity or whether checks actually ran. Never treat it as proof of correctness.
- Hash chaining detects accidental or partial edits but **does not defend against an attacker with DB write access who can recompute the chain**. Use signed remote attestations and immutable storage for production.
- The database uses a single local writer. Distributed workers need leases, fencing tokens, idempotency, transactional outbox and recovery reconciliation.
- Privileged implement/release/recover calls are *always rejected* until a real trusted approval verifier is wired in.
- No NouGenShards, MCP, GitHub, production, or key access is performed.
- `max_iterations` is modeled but not yet enforced by a recursive scheduler; iteration/retry machinery is a future step.
- A production verifier must separately execute tests, check tenant isolation, sign evidence, and enforce policy at execution boundaries.

## Planned interfaces

`InvariantCompiler -> CandidatePlanner -> WorkerAdapter -> EvidenceVerifier -> PolicyGate -> ShardsAdapter -> ReleaseController`

Use the current official MCP authorization requirements, OWASP agentic risk guidance, OpenTelemetry GenAI spans, SLSA provenance, and SRE canary/error-budget practices when implementing these components.
