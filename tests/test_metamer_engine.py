import os
import sqlite3
import tempfile

import pytest

from nougen_shards.metamer_engine import (STAGES, InvariantContract, MetamerEngine,
                                          MetamerError)


def contract(**over):
    base = dict(objective="serve thumbnails under 50 ms", inputs=["GET /img"],
                outputs=["webp bytes"], invariants=["same pixels as baseline"],
                constraints=["no new service"], authority={"deploy": "approval"},
                failure_boundaries=["p95 > 80 ms"], baseline="p95 120 ms",
                evidence=["bench run", "pixel diff"])
    base.update(over)
    return InvariantContract(**base)


def run_all(eng, rid):
    for s in STAGES:
        eng.pass_stage(rid, s, {"doc": s}, ["test"], "VERIFIED_WITHIN_SCOPE",
                       outcome="verified_improvement" if s == "remix" else None)


def test_incomplete_contract_rejected():
    with pytest.raises(MetamerError):
        MetamerEngine().start("r", contract(invariants=[]))


def test_stages_in_order_and_converge():
    eng = MetamerEngine()
    eng.start("r", contract())
    with pytest.raises(MetamerError):
        eng.pass_stage("r", "copy", {"x": 1}, ["e"], "PROVEN")
    run_all(eng, "r")
    st = eng.load("r")
    assert st.status == "converged" and st.outcomes == ["verified_improvement"]
    with pytest.raises(MetamerError):
        eng.pass_stage("r", "deep_grip", {"x": 1}, ["e"], "PROVEN")


def test_gate_needs_evidence_and_strong_result():
    eng = MetamerEngine()
    eng.start("r", contract())
    with pytest.raises(MetamerError):
        eng.pass_stage("r", "deep_grip", {"x": 1}, [], "PROVEN")
    with pytest.raises(MetamerError):
        eng.pass_stage("r", "deep_grip", {"x": 1}, ["e"], "PARTIAL")


def test_failure_reenters_earliest_stage_and_budget_stops():
    eng = MetamerEngine()
    eng.start("r", contract(), budget=2)
    for s in STAGES[:3]:
        eng.pass_stage("r", s, {"x": 1}, ["e"], "PROVEN")
    st = eng.fail_stage("r", "combine", "contract mismatch", "negative_finding", reenter="leverage")
    assert st.stage == "leverage" and st.status == "active"
    with pytest.raises(MetamerError):
        eng.fail_stage("r", "leverage", "x", "negative_finding", reenter="remix")
    st = eng.fail_stage("r", "leverage", "no evidence", "negative_finding")
    assert st.status == "failed"


def test_blocker_is_terminal():
    eng = MetamerEngine()
    eng.start("r", contract())
    st = eng.fail_stage("r", "deep_grip", "no repo access", "blocker")
    assert st.status == "blocked" and st.outcomes == ["blocker"]


def test_restart_recovery_from_disk():
    path = os.path.join(tempfile.mkdtemp(), "m.db")
    eng = MetamerEngine(path)
    eng.start("r", contract())
    eng.pass_stage("r", "deep_grip", {"x": 1}, ["e"], "PROVEN")
    eng.db.close()
    st = MetamerEngine(path).load("r")
    assert st.stage == "leverage"


def test_hash_chain_detects_tampering():
    path = os.path.join(tempfile.mkdtemp(), "m.db")
    eng = MetamerEngine(path)
    eng.start("r", contract())
    eng.pass_stage("r", "deep_grip", {"x": 1}, ["e"], "PROVEN")
    assert eng.verify_chain("r")
    db = sqlite3.connect(path)
    db.execute("UPDATE events SET payload=replace(payload,'PROVEN','PARTIAL') WHERE seq=1")
    db.commit()
    assert not eng.verify_chain("r")
    with pytest.raises(MetamerError):
        eng.load("r")


def test_promotion_fails_closed():
    eng = MetamerEngine()
    eng.start("d", contract(), mode="DESIGN")
    run_all(eng, "d")
    assert not eng.promote("d", "agent-a", "agent-b", {"ci": "green"})  # wrong mode

    eng.start("r", contract(), mode="RELEASE")
    run_all(eng, "r")
    assert not eng.promote("r", "agent-a", "agent-b", {"ci": "green"})  # default deny
    yes = MetamerEngine(approval_check=lambda *a: True)
    yes.start("r", contract(), mode="RELEASE")
    run_all(yes, "r")
    assert not yes.promote("r", "agent-a", "agent-a", {"ci": "green"})  # not independent
    assert yes.promote("r", "agent-a", "agent-b", {"ci": "green"})
    assert yes.load("r").promoted
