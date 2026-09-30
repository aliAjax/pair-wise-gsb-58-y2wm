/**
 * 快照核心逻辑验证：三方合并、证据变化失效、冲突确认、失败重试、快照恢复。
 * 运行：node --experimental-strip-types scripts/verifySnapshot.mts
 */
import assert from "node:assert";
import {
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../src/data/seed.ts";
import type { MockDatabase } from "../src/services/mockStorage.ts";
import {
  commitSnapshot,
  diffEvidence,
  fingerprintEvidence,
  syncGlobalAlerts,
} from "../src/services/snapshotEngine.ts";

const makeDb = (): MockDatabase => {
  const alerts = structuredClone(seedAlerts);
  return {
    alerts,
    snapshots: {},
    auditLogs: [],
  };
};

// 手工组装一份带快照的数据库（绕过 localStorage）
import { seedAlerts } from "../src/data/seed.ts";

const seedDb = (): MockDatabase => {
  const db = makeDb();
  const evidence = structuredClone(seedEvidence);
  const conclusions = structuredClone(seedConclusions).map((item) => ({
    ...item,
    evidenceFingerprint:
      item.id === "CV-016-001"
        ? []
        : fingerprintEvidence(
            evidence.filter((entry) => entry.caseId === item.caseId),
          ),
    baseRevision: 1,
  }));
  for (const investigationCase of seedCases) {
    const id = investigationCase.id;
    const snapshot = {
      case: structuredClone(investigationCase),
      nodes: structuredClone(seedNodes).filter((item) => item.caseId === id),
      edges: structuredClone(seedEdges).filter((item) => item.caseId === id),
      evidence: evidence.filter((item) => item.caseId === id),
      conclusions: conclusions
        .filter((item) => item.caseId === id)
        .sort((a, b) => b.version - a.version),
      alerts: structuredClone(seedAlerts).filter(
        (item) => item.caseId === id,
      ),
    };
    db.snapshots[id] = {
      caseId: id,
      revision: 1,
      snapshot,
      history: [{ revision: 1, at: new Date().toISOString(), actor: "系统", kinds: ["case" as const], label: "init", description: "init", snapshot: structuredClone(snapshot), stats: { nodesAdded: 0, edgesAdded: 0, evidenceAdded: 0, evidenceChanged: 0, evidenceRemoved: 0, conclusionsAdded: 0, alertsLinked: 0, autoMerged: 0, conflictsResolved: 0, conclusionsInvalidated: 0 } }],
    };
  }
  return db;
};

const CASE = "CASE-2026-017";
let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("1. 证据新增后旧结论失效，差异列出新增项");
{
  const db = seedDb();
  const baseEvidence = db.snapshots[CASE].snapshot.evidence;
  const before = diffEvidence(
    fingerprintEvidence(baseEvidence),
    baseEvidence,
  );
  check("基线证据无差异", () => assert.equal(before.added.length, 0));

  // 窗口 A 新增一条证据
  const r1 = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["evidence"],
      description: "新增关键证据",
      actor: "林澜",
      patch: {
        evidence: [
          {
            id: "EV-NEW-1",
            caseId: CASE,
            title: "柜面核身录像",
            source: "运营中心",
            strength: "strong",
            occurredAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            submittedBy: "林澜",
            attachment: "video-001.mp4",
            note: "证明本人操作",
            version: 1,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  assert.equal(r1.type, "committed");
  if (r1.type !== "committed") throw new Error("unreachable");
  check("保存后 revision 递增到 2", () => assert.equal(r1.success.revision, 2));
  check(
    "旧草稿结论 CV-017-001 被标记失效",
    () => {
      const cv = r1.success.snapshot.conclusions.find(
        (item) => item.id === "CV-017-001",
      );
      assert.equal(cv?.status, "invalidated");
      assert.equal(cv?.invalidation?.added.length, 1);
      assert.equal(cv?.invalidation?.added[0].title, "柜面核身录像");
      assert.ok(cv?.invalidatedAt);
    },
  );
  check(
    "版本摘要统计了新增证据与失效结论",
    () => {
      assert.equal(r1.success.summary.stats.evidenceAdded, 1);
      assert.equal(r1.success.summary.stats.conclusionsInvalidated, 1);
    },
  );
}

console.log("2. 证据强度差异与移除均能被列出并导致失效");
{
  const db = seedDb();
  const r1 = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["evidence"],
      description: "调整强度并移除",
      actor: "林澜",
      patch: {
        writes: { evidenceStrength: { "EV-017-001": "weak" } },
        removeEvidenceIds: ["EV-017-003"],
      },
    },
    { shouldFail: false },
  );
  assert.equal(r1.type, "committed");
  if (r1.type !== "committed") throw new Error("unreachable");
  const cv = r1.success.snapshot.conclusions.find(
    (item) => item.id === "CV-017-001",
  );
  check("强度差异 before=strong after=weak", () => {
    const diff = cv?.invalidation?.changed.find(
      (item) => item.id === "EV-017-001",
    );
    assert.equal(diff?.before, "strong");
    assert.equal(diff?.after, "weak");
  });
  check("移除证据列出 EV-017-003", () => {
    assert.equal(cv?.invalidation?.removed[0].id, "EV-017-003");
  });
  check("被调强度的证据版本号 +1", () => {
    const ev = r1.success.snapshot.evidence.find(
      (item) => item.id === "EV-017-001",
    );
    assert.equal(ev?.version, 2);
    assert.equal(ev?.strength, "weak");
  });
}

console.log("3. 两个窗口并发：无冲突字段先合并，冲突项需确认");
{
  const db = seedDb();
  // 窗口 B 先在 revision 1 上保存了案件状态 -> pending_review
  const fromB = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["case"],
      description: "窗口B改状态",
      actor: "周明",
      patch: { writes: { caseStatus: "pending_review" } },
    },
    { shouldFail: false },
  );
  assert.equal(fromB.type, "committed");

  // 窗口 A 基于 revision 1：加节点（无冲突集合）+ 改状态为 closed（冲突字段）
  const firstTry = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["graph", "case"],
      description: "窗口A加节点并改状态",
      actor: "林澜",
      patch: {
        nodes: [
          {
            id: "NODE-A-1",
            caseId: CASE,
            position: { x: 1, y: 1 },
            data: {
              label: "新设备",
              kind: "device" as const,
              riskLevel: "high" as const,
              note: "n",
              evidenceStrength: "strong" as const,
              source: "s",
              occurredAt: new Date().toISOString(),
            },
          },
        ],
        writes: { caseStatus: "closed" },
      },
    },
    { shouldFail: false },
  );
  check("首次提交返回冲突", () => {
    assert.equal(firstTry.type, "conflict");
    if (firstTry.type === "conflict") {
      assert.equal(firstTry.conflicts[0].path, "case.status");
      assert.equal(firstTry.conflicts[0].theirs, "pending_review");
      assert.equal(firstTry.conflicts[0].mine, "closed");
    }
  });

  // 调查员确认：在弹窗中看到了 case.status 冲突，但选择"保留对方"（不在 resolvedPaths）
  const keepTheirs = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["graph", "case"],
      description: "窗口A重试-保留对方",
      actor: "林澜",
      resolvedPaths: [],
      acknowledgedConflicts: ["case.status"],
      patch: {
        nodes: [
          {
            id: "NODE-A-1",
            caseId: CASE,
            position: { x: 1, y: 1 },
            data: {
              label: "新设备",
              kind: "device" as const,
              riskLevel: "high" as const,
              note: "n",
              evidenceStrength: "strong" as const,
              source: "s",
              occurredAt: new Date().toISOString(),
            },
          },
        ],
        writes: { caseStatus: "closed" },
      },
    },
    { shouldFail: false },
  );
  check("无冲突节点自动并入，案件状态保留对方 pending_review", () => {
    assert.equal(keepTheirs.type, "committed");
    if (keepTheirs.type !== "committed") throw new Error("x");
    assert.ok(
      keepTheirs.success.snapshot.nodes.some((n) => n.id === "NODE-A-1"),
    );
    assert.equal(keepTheirs.success.snapshot.case.status, "pending_review");
  });

  // 再制造冲突：另一方又保存了新状态（V4），本方基于 V3 仍要改 closed
  commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 3,
      kinds: ["case"],
      description: "窗口B再次改状态",
      actor: "周明",
      patch: { writes: { caseStatus: "supplement" } },
    },
    { shouldFail: false },
  );
  const conflictAgain = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 3,
      kinds: ["case"],
      description: "窗口A再次改状态",
      actor: "林澜",
      patch: { writes: { caseStatus: "closed" } },
    },
    { shouldFail: false },
  );
  assert.equal(conflictAgain.type, "conflict");
  const overwrite = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 3,
      kinds: ["case"],
      description: "窗口A确认覆盖",
      actor: "林澜",
      resolvedPaths: ["case.status"],
      acknowledgedConflicts: ["case.status"],
      patch: { writes: { caseStatus: "closed" } },
    },
    { shouldFail: false },
  );
  check("调查员确认后以我的修改覆盖", () => {
    assert.equal(overwrite.type, "committed");
    if (overwrite.type !== "committed") throw new Error("x");
    assert.equal(overwrite.success.snapshot.case.status, "closed");
    assert.equal(overwrite.success.summary.stats.conflictsResolved, 1);
  });
}

console.log("4. 两个窗口只改不同集合：并集自动合并，无冲突");
{
  const db = seedDb();
  commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["evidence"],
      description: "B加证据",
      actor: "周明",
      patch: {
        evidence: [
          {
            id: "EV-B",
            caseId: CASE,
            title: "B的证据",
            source: "s",
            strength: "medium",
            occurredAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            submittedBy: "周明",
            attachment: "b",
            note: "",
            version: 1,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  const a = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["graph"],
      description: "A加节点",
      actor: "林澜",
      patch: {
        nodes: [
          {
            id: "NODE-A",
            caseId: CASE,
            position: { x: 0, y: 0 },
            data: {
              label: "A节点",
              kind: "ip" as const,
              riskLevel: "low" as const,
              note: "",
              evidenceStrength: "weak" as const,
              source: "s",
              occurredAt: new Date().toISOString(),
            },
          },
        ],
      },
    },
    { shouldFail: false },
  );
  check("双方新增并存（关系不被覆盖），另一方证据计入自动合入", () => {
    assert.equal(a.type, "committed");
    if (a.type !== "committed") throw new Error("x");
    assert.ok(a.success.snapshot.evidence.some((e) => e.id === "EV-B"));
    assert.ok(a.success.snapshot.nodes.some((n) => n.id === "NODE-A"));
    assert.ok(a.success.summary.stats.autoMerged >= 1);
  });
}

console.log("5. 保存失败抛错（由 api 层保留草稿），重试成功且不重复新增");
{
  const db = seedDb();
  const node = {
    id: "NODE-RETRY-1",
    caseId: CASE,
    position: { x: 0, y: 0 },
    data: {
      label: "重试节点",
      kind: "account" as const,
      riskLevel: "medium" as const,
      note: "",
      evidenceStrength: "medium" as const,
      source: "s",
      occurredAt: new Date().toISOString(),
    },
  };
  const req = {
    caseId: CASE,
    baseRevision: 1,
    kinds: ["graph" as const],
    description: "失败后重试",
    actor: "林澜",
    patch: { nodes: [node] },
  };
  let threw = false;
  try {
    commitSnapshot(db.snapshots, req, { shouldFail: true });
  } catch {
    threw = true;
  }
  check("shouldFail 时抛出错误且数据库未变更", () => {
    assert.equal(threw, true);
    assert.equal(db.snapshots[CASE].revision, 1);
  });
  const retry = commitSnapshot(db.snapshots, req, { shouldFail: false });
  check("重试成功，节点只出现一次", () => {
    assert.equal(retry.type, "committed");
    if (retry.type !== "committed") throw new Error("x");
    assert.equal(
      retry.success.snapshot.nodes.filter((n) => n.id === "NODE-RETRY-1")
        .length,
      1,
    );
  });
}

console.log("6. 历史快照可恢复，且历史不被删除（重启仍可见失效版本）");
{
  const db = seedDb();
  commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["evidence"],
      description: "加证据",
      actor: "林澜",
      patch: {
        evidence: [
          {
            id: "EV-X",
            caseId: CASE,
            title: "临时证据",
            source: "s",
            strength: "strong",
            occurredAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            submittedBy: "林澜",
            attachment: "x",
            note: "",
            version: 1,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  const restored = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 2,
      kinds: ["restore"],
      description: "恢复到 V1",
      actor: "林澜",
      patch: {},
      restoreFromRevision: 1,
    },
    { shouldFail: false },
  );
  check("恢复后生成 V3，内容回到 V1（证据消失）", () => {
    assert.equal(restored.type, "committed");
    if (restored.type !== "committed") throw new Error("x");
    assert.equal(restored.success.revision, 3);
    assert.ok(
      !restored.success.snapshot.evidence.some((e) => e.id === "EV-X"),
    );
  });
  check("V1/V2/V3 历史都保留", () => {
    const revisions = db.snapshots[CASE].history.map((h) => h.revision);
    assert.deepEqual(revisions, [3, 2, 1]);
  });
}

console.log("7. 提交新结论锁定当前证据指纹，之后证据再变化才失效");
{
  const db = seedDb();
  // 先加一条证据使旧结论失效
  commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["evidence"],
      description: "加证据",
      actor: "林澜",
      patch: {
        evidence: [
          {
            id: "EV-Z",
            caseId: CASE,
            title: "新证据",
            source: "s",
            strength: "strong",
            occurredAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            submittedBy: "林澜",
            attachment: "z",
            note: "",
            version: 1,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  // 基于最新证据提交新结论
  const submit = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 2,
      kinds: ["conclusion"],
      description: "重算结论",
      actor: "林澜",
      patch: {
        addConclusion: {
          disposition: "freeze",
          rationale: "基于包含新证据在内的完整台账重新判断，建议冻结。",
          riskControls: ["只收不付"],
          submit: true,
        },
      },
    },
    { shouldFail: false },
  );
  check("新结论 submitted 且指纹包含新证据，自身不失效", () => {
    assert.equal(submit.type, "committed");
    if (submit.type !== "committed") throw new Error("x");
    const v2 = submit.success.snapshot.conclusions[0];
    assert.equal(v2.status, "submitted");
    assert.ok(v2.evidenceFingerprint.some((f) => f.id === "EV-Z"));
  });
  // 再移除证据 -> 新结论失效，案件回到 investigating
  const invalidate = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 3,
      kinds: ["evidence"],
      description: "移除证据",
      actor: "林澜",
      patch: { removeEvidenceIds: ["EV-Z"] },
    },
    { shouldFail: false },
  );
  check("证据再变化使最新结论失效，待复核案件回到调查中", () => {
    assert.equal(invalidate.type, "committed");
    if (invalidate.type !== "committed") throw new Error("x");
    const v2 = invalidate.success.snapshot.conclusions.find(
      (c) => c.version === 2,
    );
    assert.equal(v2?.status, "invalidated");
    assert.equal(
      invalidate.success.snapshot.case.status,
      "investigating",
    );
  });
}

console.log("8. 已通过(approved)结论不被自动失效，不影响已关闭案件");
{
  const db = seedDb();
  // CASE-2026-016 结论 submitted、无证据；构造一个 approved 场景
  const c16 = db.snapshots["CASE-2026-016"];
  c16.snapshot.conclusions[0].status = "approved";
  c16.snapshot.case.status = "closed";
  c16.snapshot.evidence.push({
    id: "EV-16-X",
    caseId: "CASE-2026-016",
    title: "事后补录",
    source: "s",
    strength: "weak",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "周明",
    attachment: "x",
    note: "",
    version: 1,
  });
  const r = commitSnapshot(
    db.snapshots,
    {
      caseId: "CASE-2026-016",
      baseRevision: 1,
      kinds: ["evidence"],
      description: "补证据",
      actor: "周明",
      patch: {
        evidence: [
          {
            id: "EV-16-Y",
            caseId: "CASE-2026-016",
            title: "再补一条",
            source: "s",
            strength: "weak",
            occurredAt: new Date().toISOString(),
            submittedAt: new Date().toISOString(),
            submittedBy: "周明",
            attachment: "y",
            note: "",
            version: 1,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  check("approved 结论保持已通过", () => {
    assert.equal(r.type, "committed");
    if (r.type !== "committed") throw new Error("x");
    assert.equal(
      r.success.snapshot.conclusions[0].status,
      "approved",
    );
    assert.equal(r.success.snapshot.case.status, "closed");
  });
}

console.log("9. 快照告警同步回全局台账");
{
  const db = seedDb();
  const r = commitSnapshot(
    db.snapshots,
    {
      caseId: CASE,
      baseRevision: 1,
      kinds: ["alerts"],
      description: "关联告警",
      actor: "林澜",
      patch: {
        alerts: [
          {
            ...structuredClone(
              seedAlerts.find((a) => a.id === "AL-20260928-014")!,
            ),
            caseId: CASE,
            status: "linked" as const,
          },
        ],
      },
    },
    { shouldFail: false },
  );
  assert.equal(r.type, "committed");
  if (r.type !== "committed") throw new Error("x");
  db.alerts = syncGlobalAlerts(db.alerts, r.success.snapshot);
  const linked = db.alerts.find((a) => a.id === "AL-20260928-014");
  check("全局告警台账的 caseId/status 被同步", () => {
    assert.equal(linked?.caseId, CASE);
    assert.equal(linked?.status, "linked");
  });
}

console.log(`\n全部 ${passed} 项核心逻辑检查通过。`);
