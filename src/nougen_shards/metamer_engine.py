"""Metamer Engine v3: reference control plane (standard library only).

A verification-first runtime for the seven-stage Metamer loop. It does not
generate or apply patches. It records what a run claimed, checks that every
stage gate has evidence, and refuses to promote anything on its own say-so.

Guarantees:
* Persistent state machine: Deep Grip -> Leverage -> Copy -> Combine ->
  Transform -> Refactor -> Remix, plus terminal states.
* Typed Invariant Contract (the nine v2 fields) validated before a run starts.
* Append-only SQLite event log, one transaction per event, SHA-256 hash chain.
  ``verify_chain`` detects edits, deletions and reordering.
* Restart recovery: a run's state is rebuilt by replaying its events.
* Every iteration ends in exactly one outcome: a verified improvement, a
  negative finding, or a blocker.
* Fail-closed privileged actions: promotion needs an independent verifier
  (not the proposer) and an approval check that defaults to deny.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

STAGES = ("deep_grip", "leverage", "copy", "combine", "transform", "refactor", "remix")
MODES = ("ANALYZE", "DESIGN", "IMPLEMENT", "RELEASE", "RECOVER")
RESULT_CLASSES = ("PROVEN", "VERIFIED_WITHIN_SCOPE", "PARTIAL", "FAILED", "BLOCKED")
OUTCOMES = ("verified_improvement", "negative_finding", "blocker")
TERMINAL = ("converged", "failed", "blocked")
GENESIS = "0" * 64


class MetamerError(Exception):
    """A rule of the protocol was broken; the event was not recorded."""


@dataclass(frozen=True)
class InvariantContract:
    objective: str
    inputs: list
    outputs: list
    invariants: list
    constraints: list
    authority: dict
    failure_boundaries: list
    baseline: str
    evidence: list
    unknowns: list = field(default_factory=list)

    def validate(self) -> None:
        missing = [n for n in ("objective", "outputs", "invariants", "evidence", "baseline")
                   if not getattr(self, n)]
        if missing:
            raise MetamerError(f"invariant contract incomplete: {', '.join(missing)}")
        if not isinstance(self.authority, dict):
            raise MetamerError("authority must map action -> allowed|denied|approval")


def _deny(*_args) -> bool:
    return False


@dataclass
class RunState:
    run_id: str
    mode: str
    stage_index: int = 0
    status: str = "active"
    iteration: int = 0
    budget: int = 10
    outcomes: list = field(default_factory=list)
    promoted: bool = False

    @property
    def stage(self) -> Optional[str]:
        return STAGES[self.stage_index] if self.status == "active" else None


class MetamerEngine:
    def __init__(self, db_path: str = ":memory:",
                 approval_check: Callable[[str, str, dict], bool] = _deny):
        self.db = sqlite3.connect(db_path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS events (run_id TEXT, seq INTEGER, ts REAL, kind TEXT,"
            " payload TEXT, prev_hash TEXT, hash TEXT, PRIMARY KEY (run_id, seq))")
        self.approval_check = approval_check

    # -- event log -------------------------------------------------------
    @staticmethod
    def _digest(run_id, seq, kind, payload, prev):
        return hashlib.sha256(f"{run_id}|{seq}|{kind}|{payload}|{prev}".encode()).hexdigest()

    def _append(self, run_id: str, kind: str, data: dict) -> None:
        payload = json.dumps(data, sort_keys=True)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute("SELECT seq, hash FROM events WHERE run_id=? ORDER BY seq DESC"
                                  " LIMIT 1", (run_id,)).fetchone()
            seq, prev = (row[0] + 1, row[1]) if row else (0, GENESIS)
            self.db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)",
                            (run_id, seq, time.time(), kind, payload, prev,
                             self._digest(run_id, seq, kind, payload, prev)))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def events(self, run_id: str) -> list:
        return self.db.execute("SELECT seq, kind, payload, prev_hash, hash FROM events"
                               " WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()

    def verify_chain(self, run_id: str) -> bool:
        prev = GENESIS
        for i, (seq, kind, payload, prev_hash, h) in enumerate(self.events(run_id)):
            if seq != i or prev_hash != prev or h != self._digest(run_id, seq, kind, payload, prev):
                return False
            prev = h
        return True

    # -- lifecycle -------------------------------------------------------
    def start(self, run_id: str, contract: InvariantContract, mode: str = "DESIGN",
              budget: int = 10) -> RunState:
        if mode not in MODES:
            raise MetamerError(f"unknown mode {mode}")
        if self.events(run_id):
            raise MetamerError(f"run {run_id} already exists")
        contract.validate()
        self._append(run_id, "start", {"contract": asdict(contract), "mode": mode, "budget": budget})
        return self.load(run_id)

    def load(self, run_id: str) -> RunState:
        """Rebuild state from the log (restart recovery). Refuses a broken chain."""
        rows = self.events(run_id)
        if not rows:
            raise MetamerError(f"no such run {run_id}")
        if not self.verify_chain(run_id):
            raise MetamerError(f"event chain for {run_id} failed integrity check")
        st = None
        for _seq, kind, payload, _p, _h in rows:
            d = json.loads(payload)
            if kind == "start":
                st = RunState(run_id, d["mode"], budget=d["budget"])
            elif kind == "stage_passed":
                st.stage_index = min(st.stage_index + 1, len(STAGES) - 1)
                if d["stage"] == "remix":
                    st.iteration += 1
                    st.outcomes.append(d["outcome"])
            elif kind == "stage_failed":
                st.stage_index = STAGES.index(d["reenter"])
                st.iteration += 1
                st.outcomes.append(d["outcome"])
            elif kind == "terminal":
                st.status = d["status"]
            elif kind == "promoted":
                st.promoted = True
        return st

    def _require_active(self, run_id: str) -> RunState:
        st = self.load(run_id)
        if st.status in TERMINAL:
            raise MetamerError(f"run {run_id} is {st.status}; no further events")
        return st

    def pass_stage(self, run_id: str, stage: str, artifact: dict, evidence: list,
                   result_class: str, outcome: Optional[str] = None) -> RunState:
        st = self._require_active(run_id)
        if stage != st.stage:
            raise MetamerError(f"expected stage {st.stage}, got {stage}")
        if not artifact or not evidence:
            raise MetamerError(f"{stage}: gate needs an artifact and evidence")
        if result_class not in ("PROVEN", "VERIFIED_WITHIN_SCOPE"):
            raise MetamerError(f"{stage}: a gate passes only on PROVEN or VERIFIED_WITHIN_SCOPE")
        if stage == "remix" and outcome != "verified_improvement":
            raise MetamerError("remix passes only with outcome verified_improvement")
        self._append(run_id, "stage_passed", {"stage": stage, "artifact": artifact,
                                               "evidence": evidence, "result_class": result_class,
                                               "outcome": outcome})
        st = self.load(run_id)
        if stage == "remix":
            self._append(run_id, "terminal", {"status": "converged"})
            st = self.load(run_id)
        return st

    def fail_stage(self, run_id: str, stage: str, finding: str, outcome: str,
                   reenter: Optional[str] = None) -> RunState:
        """Record a failed gate. It must yield a negative finding or a blocker."""
        st = self._require_active(run_id)
        if stage != st.stage:
            raise MetamerError(f"expected stage {st.stage}, got {stage}")
        if outcome not in ("negative_finding", "blocker") or not finding:
            raise MetamerError("a failed gate must record a negative_finding or blocker")
        target = reenter or stage
        if STAGES.index(target) > STAGES.index(stage):
            raise MetamerError("re-entry must be at or before the failing stage")
        self._append(run_id, "stage_failed", {"stage": stage, "finding": finding,
                                               "outcome": outcome, "reenter": target})
        st = self.load(run_id)
        if outcome == "blocker":
            self._append(run_id, "terminal", {"status": "blocked", "reason": finding})
        elif st.iteration >= st.budget:
            self._append(run_id, "terminal", {"status": "failed", "reason": "iteration budget spent"})
        return self.load(run_id)

    def promote(self, run_id: str, proposer: str, verifier: str, evidence: dict) -> bool:
        """Privileged action. Fails closed: denied unless the run converged, the mode is
        RELEASE, the verifier is independent of the proposer, and approval_check says yes."""
        st = self.load(run_id)
        ok = (st.status == "converged" and st.mode == "RELEASE" and verifier and proposer
              and verifier != proposer and bool(evidence))
        try:
            ok = ok and bool(self.approval_check(run_id, verifier, evidence))
        except Exception:
            ok = False
        self._append(run_id, "promoted" if ok else "promotion_denied",
                     {"proposer": proposer, "verifier": verifier})
        return ok
