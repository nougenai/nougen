# Metamer Engine v3 — engineering specification

## Design objective
Build an invariant-centric optimization control plane above existing NouGenAI agents and NouGenShards. Do not replace existing working agents or storage.

## Runtime and authority
- **Trusted control plane:** InvariantCompiler, PolicyDecisionPoint, VerificationController, StateJournal, Scheduler.
- **Untrusted proposal plane:** model outputs, retrieved documents, candidate patches, research, shard content, external tool results.
- **Execution plane:** sandboxed workers, tool adapters, rate limits, scoped credentials and resource budgets.
- **Evidence plane:** test results, signed artifact digests, build provenance, metrics, trace IDs and negative findings.
- **Memory plane:** tenant-scoped, provenance-tagged, versioned Shards read/write/relay adapters.

### Workflow lifecycle
`created -> deep_grip -> leverage -> copy -> combine -> transform -> refactor -> remix -> verified`
Any running stage may enter `blocked` or `failed`; only an explicit authorized new attempt may re-enter a stage. Never automatically promote to production.

### Stage contract (future production schema)
```json
{
  "run_id":"uuid",
  "stage":"remix",
  "iteration":1,
  "input_artifact_sha256":"64 hex chars",
  "contract_id":"immutable version",
  "policy_version":"immutable version",
  "candidate_id":"immutable version",
  "agent_identity":"authenticated scoped principal",
  "permissions":["read:repo"],
  "budget":{"max_tokens":50000,"max_wall_seconds":600,"max_cost_usd":2},
  "required_checks":["unit","lint","tenant_isolation","replay","rollback"],
  "evidence_refs":[],
  "status":"pending"
}
```

## Metamer equivalence
Operational equivalence is always relative to an **observation contract** and input domain, not identical bytes. Compare functional outputs, error semantics, side effects, authorization, tenant separation, performance bounds, availability and recovery. For nondeterministic systems, compare calibrated statistical distributions and uncertainty intervals; avoid false binary equivalence assertions.

## Proposer/Verifier separation
An agent may generate a patch but may not self-approve the security or release gate. The verifier runs tests using independent credentials and environment, verifies the source/artifact identity, records evidence, and applies policy. An assertion `{passed:true}` is *never* sufficient for production promotion.

## Correctness and failure model
- Commit stages atomically to the journal; no external calls inside deterministic transitions.
- External operations are at-least-once by default: require idempotency keys and effect ledgers.
- Use leases with fencing tokens to prevent stale workers committing after failover.
- Persist work intents using transactional outbox; reconcile unknown outcomes after crash.
- Bounded exponential backoff + jitter, global deadline, circuit breaker and dead-letter quarantine.
- A terminal failed run is immutable; retry creates a new attempt linked to its parent.
- Treat shard recall as evidence with completeness and provenance flags; partial search must not silently imply no results.

## Optimization selection
Hard constraints precede any scoring. Maintain a Pareto frontier over correctness, security, reliability, latency, cost, complexity and recoverability. Compare using controlled workloads and confidence intervals. Reject candidates with invariant failures. Cap exploration budgets and stop when marginal value is not evidenced.

## Threat model
- Prompt injection through retrieved shards/README/PR review/tool output.
- Confused-deputy delegation or cross-tenant context propagation loss.
- Forged evidence, modified journals, replayed approvals, stale branch/head SHA.
- Exfiltration via logs, traces, model context or external MCP endpoints.
- Tool parameter escalation, poisoned dependencies, model-generated unsafe patches.
- Duplicate effects on crash/retry, stale lease mutations, runaway recursive loops.

### Required gates before production
1. Identity-bound authentication, scoped action authorization, explicit release approvals.
2. Actual independent test runner with signed, non-replayable evidence tied to commit and contract.
3. Artifact provenance and dependency SBOM; protected CI and branch controls.
4. Worker sandbox, network egress policy, tenant vault isolation and policy enforcement outside LLM.
5. Durable event store with authenticated integrity anchor and backup restore drill.
6. Crash recovery with leases/fencing, exactly-once intent + idempotent effects.
7. OpenTelemetry trace correlation, SLO dashboards, alert thresholds, budget enforcement.
8. Canary promotion + health gates + rollback drills + incident response.
9. Stress tests for prompt injection, parallel tenant access, retry storms, stale token and poisoned evidence.
10. Real benchmark comparison against target baseline; do not claim top percentile without population measurement.

## Evidence gates and sample SLO targets (proposed, not measured)
- 100% critical invariants verified within declared test domain.
- Zero unauthorized actions in the adversarial authorization suite.
- Zero cross-tenant reads in concurrent isolation tests.
- 100% recovery of acknowledged stage transitions after simulated process crash.
- Release rollback rehearsal succeeds before production permission is added.
- Record p50/p95/p99 stage duration, verifier latency, cost per accepted improvement, escaped regressions and recovery time.

## Incremental fleet integration
Phase A: Read-only Shards adapter + GitHub snapshot + baseline CI evidence.
Phase B: Sandboxed candidate generation, isolated test worker, immutable artifact hashes.
Phase C: Scoped signed evidence, policy engine, transactional outbox, failure injection.
Phase D: Shadow run comparison and gated canaries; controlled deployment only after authorization.

## Primary standards / technical references (checked 2026-11-18)
- MCP protocol 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28
- OWASP Agentic Applications Top 10 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- NIST AI Agent Standards Initiative: https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative
- OpenTelemetry GenAI semantic conventions: https://github.com/open-telemetry/semantic-conventions-genai
- Temporal workflow determinism: https://docs.temporal.io/workflows
- SLSA specification: https://slsa.dev/spec/v1.2/
- Google SRE canary guide: https://sre.google/workbook/canarying-releases/
