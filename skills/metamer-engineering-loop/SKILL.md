---
name: metamer-engineering-loop
description: Apply the 7-stage Metamer Engineering Loop (Deep Grip, Leverage, Copy, Combine, Transform, Refactor, Remix) to solve complex systems architecture, codebase refactoring, or workflow design problems. Use when the user asks to run the metamer pipeline / "metamer loop" / "7-stage pipeline", analyze a system via structural metamers, or architect/refactor a technical workflow using the 7-stage loop.
---

# Metamer Engineering Loop

A 7-stage pipeline for systems architecture and problem solving. It is built on **metamers**: two inputs or architectures that look completely different on the surface but produce exactly the same functional output once they hit a system.

Companion to the `valerion` skill. Valerion absorbs a whole system into NouGen, while this loop designs one target. Both "Valerion" and "Metamers" are canonical names; never flag either as drift.

## When to use

- Designing or re-architecting a software system, codebase, or technical workflow.
- Breaking an architectural deadlock by borrowing a working topology from an unrelated domain.
- Stripping accidental complexity from an over-engineered pipeline while keeping its exact output invariants.
- The operator says "metamer loop", "7-stage pipeline", or asks to run a problem through this framework.

Example trigger: "Run the metamer engineering loop on our multi-tenant webhook ingestion pipeline — at-least-once delivery under 50 ms latency with zero external message brokers."

## Pipeline

Run the target problem, codebase, or workflow through all seven stages in order. Output a structured analysis for each stage before delivering the final converged design.

### 1. Deep Grip — find the core
- **Sub-steps:**
  - Activate orchestration.
  - Deep grep for latent structure.
  - Reverse-engineer the intent.
  - Extract the invariants.
- **Action:**
  - Strip away surface framing, UI details, and implementation noise.
  - Name the core invariants: the strict rules and output guarantees that must hold however the problem is phrased or implemented.
  - Lock onto the exact target outcome.

### 2. Leverage — find the bottleneck
- **Sub-steps:**
  - Surface the leverage.
  - Integrate the constraints.
  - Invert the assumptions.
- **Action:**
  - Isolate the 1–2 hard constraints that actually govern system behavior.
  - Explicitly invert the default assumptions, for example "what if state is immutable?" or "what if this runs client-side?". This shows what genuinely breaks and what is only convention.
  - If the constraints conflict with the goal, flag the conflict here.

### 3. Copy — steal working shapes
- **Sub-steps:**
  - Copy a successful topology.
  - Transpose its patterns.
- **Action:**
  - Find a structural metamer: an existing system, ideally from a different industry or discipline, that already solves this topology reliably.
  - Extract its blueprint without the domain baggage.

### 4. Combine — wire them together
- **Sub-steps:**
  - Combine compatible systems.
  - Synthesize a coherent signal.
- **Action:**
  - Merge the borrowed blueprint with the existing stack and constraints.
  - Define clean interfaces and data contracts so the components pass signals without impedance mismatch.

### 5. Transform — reshape the system
- **Sub-steps:**
  - Transform the architecture.
  - Expand the solution space.
  - Reconstruct coherence.
- **Action:**
  - Adapt the combined topology to the domain rules.
  - Explore 2–3 high-leverage variations.
  - Lock one coherent target architecture.

### 6. Refactor — cut the dead weight
- **Sub-steps:**
  - Refactor complexity.
  - Compress noise.
- **Action:**
  - Delete every layer, abstraction, dependency, or step that does not directly serve a Stage 1 invariant.
  - Compress the operational noise.

### 7. Remix — stress-test and lock
- **Sub-steps:**
  - Remix the viable patterns.
  - Stabilize the reasoning.
  - Iterate recursively.
  - Orchestrate convergence.
- **Action:**
  - Attack the weakest points with edge cases and failure modes.
  - Repeat on fragile junctions until the design is minimal and stable and reliably hits the target output.

## Control plane (Metamer Engine v1)

Every stage has an input, an output artifact, a hard pass/fail gate, a failure condition, and a recovery path. If a stage does not produce its artifact and pass its gate, do not move to the next stage.

| Stage | Commands | Mandatory artifact | Gate (pass/fail) |
|---|---|---|---|
| 1 Deep Grip | activate orchestration → reverse-engineer intent → deep grep latent structure → extract invariants | Invariant specification | The goal and hard rules fit in one sentence that names no tool, framework, or code, and every rule is testable. |
| 2 Leverage | integrate constraints → invert assumptions → surface leverage | Constraint ranking | One #1 bottleneck is named and evidenced: if it isn't fixed, nothing else matters. |
| 3 Copy | copy successful topology → transpose patterns | Reference topology | The source system is named and its parts are mapped 1-to-1 onto ours; transfer assumptions are verified. |
| 4 Combine | combine compatible systems → synthesize coherent signal | Interface contract | The exact schema or payload between the parts is written down, with no translation layer in between. |
| 5 Transform | expand solution space → transform architecture → reconstruct coherence | Candidate architectures + chosen flow | An end-to-end flow runs from raw input to final output with no "magic happens here" gaps, and trade-offs are measured. |
| 6 Refactor | compress noise → refactor complexity | Minimal architecture | About 30% of the moving parts are cut (a target, not a law), with no change to output and no invariant regressions. |
| 7 Remix | remix viable patterns → stabilize reasoning → iterate recursively → orchestrate convergence | Verified release candidate | Output is deterministic: the same input gives the same result with zero drift. Tests, security, and rollback pass. |

Stage 6 move: swap heavy parts for lighter metamers. Replace a library, an extra API call, or a bloated loop with simple math or a direct lookup that gives the same result.

**Quick trigger** (one line to start any build or debug session):

    [Target] | [Hard Limits] -> Grip Invariants -> Choke Point -> Steal Metamer -> Wire Contract -> Bend Architecture -> Cut 30% -> Lock Loop

## Metamer equivalence rule

Equal outputs do not by themselves make two systems equivalent. Implementations A and B are operational metamers under an observation contract O only when, for every input x in the defined domain D:

    O(A, x) = O(B, x)

O covers:
- the observable outputs;
- authorized data access;
- error behavior;
- the relevant nonfunctional limits (security, reliability, cost, recovery time).

Exhaustive equivalence is usually unprovable. Always state which kind you have:
- **proven** — formal, or exhaustive over D;
- **test-supported** — name the tests and what they cover.

## Governance

- No unverified claims of correctness.
- No destructive changes without explicit authorization.
- No bypassing tests, security gates, or required reviews.
- No autonomous production promotion without an authorized deployment policy.
- Preserve audit logs, provenance, rollback capability, and tenant/access isolation.
- Stop when the acceptance criteria pass and further iteration has no measurable value.

**Placement:** the engine is an orchestration protocol layered above NouGenShards, not a separate reasoning service.
- NouGenShards supplies memory and provenance: recall before Stage 1, and capture the verified result after Stage 7.
- Existing CI and security controls stay authoritative.

**Optimization objective:** maximize verified outcome quality while minimizing complexity, dependencies, execution cost, and recovery time.

## Output contract

Deliver all of the following:
1. Invariant specification
2. Bottleneck analysis
3. Selected topology
4. Implementation changes
5. Validation evidence (proven or test-supported)
6. Residual risks
7. Next authorized action

## Output standards

- **Be concrete.** Name specific data structures, state transitions, protocols, or topology analogs, not metaphors.
- **Respect constraints.** Never violate a hard constraint from Stage 2.
- **Verify the invariants.** End with a short check that the final design satisfies every Stage 1 invariant.

## Gotchas

- **Staying abstract.** Don't restate the stage definitions; map every stage to the concrete mechanics of the problem.
- **Skipping Stage 6.** Merging borrowed patterns in Stages 3–5 adds bloat, so always prune before finalizing.
- **Surface-level analogies.** The Stage 3 metamer must match the structural topology (data flow, state guarantees, failure modes), not just share a keyword.
