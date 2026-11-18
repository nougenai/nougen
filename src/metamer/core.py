"""Durable, fail-closed orchestration skeleton; no live side effects."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STAGES = ("deep_grip", "leverage", "copy", "combine", "transform", "refactor", "remix")
TERMINAL = frozenset({"verified", "failed", "blocked"})


def encode(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class Contract:
    target: str
    invariants: tuple[str, ...]
    allowed_actions: tuple[str, ...] = ("analyze", "design")
    max_iterations: int = 7

    def validate(self) -> None:
        if not self.target.strip() or not self.invariants or any(not x.strip() for x in self.invariants):
            raise ValueError("Target and nonempty invariants required")
        if self.max_iterations < 1 or self.max_iterations > 1000:
            raise ValueError("Iteration budget out of bounds")
        if not set(self.allowed_actions).issubset({"analyze", "design", "implement", "release", "recover"}):
            raise ValueError("Unknown action")


class Engine:
    """Uses a SQLite-backed append-only event chain and transactional stage cursor.

    Single-writer reference only. Production requires authenticated identities,
    dedicated workers, stronger journal integrity, and distributed concurrency control.
    """

    def __init__(self, path: str | Path):
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY, contract TEXT NOT NULL, stage_idx INTEGER NOT NULL DEFAULT 0,
            iteration INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running');
        CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id),
            kind TEXT NOT NULL, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
        """)

    def _append(self, run_id: str, kind: str, payload: dict[str, Any]) -> None:
        previous = self.db.execute("SELECT event_hash FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1", (run_id,)).fetchone()
        prev = previous[0] if previous else "0" * 64
        body = encode({"run_id": run_id, "kind": kind, "payload": payload, "prev_hash": prev})
        self.db.execute("INSERT INTO events(run_id,kind,payload,prev_hash,event_hash) VALUES(?,?,?,?,?)",
                        (run_id, kind, encode(payload), prev, digest(body)))

    def start(self, run_id: str, contract: Contract) -> None:
        contract.validate()
        if not run_id.strip():
            raise ValueError("run_id required")
        c = {"target": contract.target, "invariants": list(contract.invariants),
             "allowed_actions": list(contract.allowed_actions), "max_iterations": contract.max_iterations}
        with self.db:
            self.db.execute("INSERT INTO runs(run_id,contract) VALUES(?,?)", (run_id, encode(c)))
            self._append(run_id, "started", {"contract_sha256": digest(encode(c))})

    def state(self, run_id: str) -> dict[str, Any]:
        row = self.db.execute("SELECT contract,stage_idx,iteration,status FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        c, i, iteration, status = row
        return {"contract": json.loads(c), "stage": STAGES[i], "stage_idx": i,
                "iteration": iteration, "status": status}

    def advance(self, run_id: str, evidence: dict[str, Any]) -> str:
        """Advance only with structured externally collected pass evidence.

        This skeleton checks evidence shape, not actual test authenticity.
        Production verification must run independently with signed/attested evidence.
        """
        if not isinstance(evidence, dict) or evidence.get("passed") is not True:
            raise ValueError("Passing evidence required")
        if not isinstance(evidence.get("artifact_sha256"), str) or len(evidence["artifact_sha256"]) != 64:
            raise ValueError("Content digest required")
        if not isinstance(evidence.get("checks"), list) or not evidence["checks"]:
            raise ValueError("Named checks required")
        if any(not isinstance(x, str) or not x.strip() for x in evidence["checks"]):
            raise ValueError("Invalid check")
        with self.db:
            state = self.state(run_id)
            if state["status"] != "running":
                raise ValueError("Run is not running")
            index = state["stage_idx"]
            self._append(run_id, "stage_passed", {"stage": STAGES[index], "evidence": evidence})
            if index == len(STAGES) - 1:
                self.db.execute("UPDATE runs SET status='verified' WHERE run_id=?", (run_id,))
                self._append(run_id, "verified", {})
                return "verified"
            self.db.execute("UPDATE runs SET stage_idx=? WHERE run_id=?", (index + 1, run_id))
            return STAGES[index + 1]

    def request_action(self, run_id: str, action: str, approval: dict[str, Any] | None = None) -> None:
        state = self.state(run_id)
        if state["status"] != "running":
            raise PermissionError("Cannot act on completed run")
        if action not in state["contract"]["allowed_actions"]:
            raise PermissionError("Action outside contract")
        if action in {"implement", "release", "recover"}:
            # Explicitly reject opaque approval assertions: production must verify
            # signature, principal, scope, expiry and replay nonce via trusted service.
            raise PermissionError("Privileged actions require external approval verifier")
        with self.db:
            self._append(run_id, "authorized_intent", {"action": action})

    def fail(self, run_id: str, reason: str, blocked: bool = False) -> None:
        if not reason.strip():
            raise ValueError("Reason required")
        status = "blocked" if blocked else "failed"
        with self.db:
            if self.state(run_id)["status"] != "running":
                raise ValueError("Cannot terminate completed run")
            self.db.execute("UPDATE runs SET status=? WHERE run_id=?", (status, run_id))
            self._append(run_id, status, {"reason": reason})

    def verify_chain(self, run_id: str) -> bool:
        rows = self.db.execute("SELECT kind,payload,prev_hash,event_hash FROM events WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
        if not rows:
            return False
        prior = "0" * 64
        for kind, payload, prev, actual in rows:
            if prev != prior or digest(encode({"run_id": run_id, "kind": kind,
                                                "payload": json.loads(payload), "prev_hash": prev})) != actual:
                return False
            prior = actual
        return True

    def close(self) -> None:
        self.db.close()
