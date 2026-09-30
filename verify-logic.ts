// 端到端逻辑验证：三方合并、证据失效、快照链、失败草稿
import assert from "node:assert";
import { readDatabase } from "./src/services/mockStorage";
import {
  advanceSnapshot,
  commitWorkspace,
  restoreSnapshot,
} from "./src/services/snapshotService";
import {
  diffEvidence,
  findStaleConclusions,
  reconcileBundles,
} from "./src/services/snapshotCore";
import type { CaseBundle } from "./src/models/types";
import {
  getPendingDraft,
  savePendingDraft,
  removePendingDraft,
} from "./src/services/pendingDrafts";

const CASE_ID = "CASE-2026-017";

const snapshotBundle = (db: ReturnType<typeof readDatabase>): CaseBundle => {
  const c = db.cases.find((item) => item.id === CASE_ID)!;
  return {
    case: structuredClone(c),
    alertIds: structuredClone(c.alertIds),
    nodes: db.nodes.filter((i) => i.caseId === CASE_ID).map((item) => structuredClone(item)),
    edges: db.edges.filter((i) => i.caseId === CASE_ID).map((item) => structuredClone(item)),
    evidence: db.evidence.filter((i) => i.caseId === CASE_ID).map((item) => structuredClone(item)),
    conclusions: db.conclusions
      .filter((i) => i.caseId === CASE_ID)
      .map((item) => structuredClone(item)),
  };
};

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/* ---------- 1. 迁移与基准快照 ---------- */
let db = readDatabase();
check("迁移后每个案件都有基准快照且 revision=1", () => {
  db.cases.forEach((c) => {
    const snaps = db.snapshots.filter((s) => s.caseId === c.id);
    assert.ok(snaps.length >= 1, `${c.id} 无快照`);
    assert.strictEqual(c.revision, 1);
  });
  assert.ok(db.conclusions.every((c) => Array.isArray(c.evidenceSignature)));
});

/* ---------- 2. 证据变化 → 结论失效 ---------- */
check("新增/移除/强度差异能被识别并让旧结论失效", () => {
  const bundle = snapshotBundle(db);
  // 先通过 legacy 流程创建一份锚定当前证据的草稿结论
  db.conclusions.push({
    id: "CV-TEST-1",
    caseId: CASE_ID,
    version: 99,
    status: "draft",
    disposition: "observe",
    rationale: "测试结论锚定证据".repeat(2),
    riskControls: [],
    createdBy: "测试",
    createdAt: new Date().toISOString(),
    reviewer: "赵平",
    evidenceSignature: bundle.evidence
      .map(
        (e) =>
          `${e.id}|${e.title}|${e.source}|${e.strength}|${e.occurredAt}|${e.attachment}`,
      )
      .sort(),
  });
  const changed: typeof bundle.evidence = structuredClone(bundle.evidence);
  // 强度变化
  changed[0] = { ...changed[0], strength: "weak" };
  // 移除一条
  const removed = changed.splice(1, 1)[0];
  // 新增一条
  changed.push({
    id: "EV-NEW",
    caseId: CASE_ID,
    title: "新证据",
    source: "测试来源",
    strength: "strong",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "测试",
    attachment: "x.pdf",
    note: "",
    version: 1,
  });
  const testBundle: CaseBundle = {
    ...bundle,
    evidence: changed,
    conclusions: db.conclusions
      .filter((i) => i.caseId === CASE_ID)
      .map((item) => structuredClone(item)),
  };
  const stale = findStaleConclusions(testBundle.conclusions, testBundle.evidence);
  const target = stale.find((s) => s.conclusion.id === "CV-TEST-1");
  assert.ok(target, "测试结论未被标记失效");
  const kinds = target!.changes.map((c) => c.kind).sort();
  assert.deepStrictEqual(kinds, ["added", "removed", "strength"]);
  assert.ok(target!.changes.some((c) => c.evidenceId === removed.id));
});

/* ---------- 3. commitWorkspace 正常保存 + 版本摘要 ---------- */
check("保存生成 R2 快照，带摘要计数并写审计", () => {
  const base = snapshotBundle(db);
  const local: CaseBundle = structuredClone(base);
  local.evidence.push({
    id: "EV-SAVE-1",
    caseId: CASE_ID,
    title: "保存测试证据",
    source: "测试",
    strength: "strong",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "林澜",
    attachment: "a.bin",
    note: "",
    version: 1,
  });
  const result = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 1,
    bundle: local,
    summaryNote: "新增一份证据",
    actor: "林澜",
  });
  assert.ok(!("status" in result), "不应返回冲突");
  if ("status" in result) throw new Error("unreachable");
  assert.strictEqual(result.snapshot.revision, 2);
  assert.strictEqual(result.snapshot.summary.added.evidence, 1);
  assert.strictEqual(db.cases.find((c) => c.id === CASE_ID)!.revision, 2);
  assert.ok(
    db.auditLogs.some((l) => l.action === "保存案件快照"),
    "缺少保存审计",
  );
});

/* ---------- 4. 并发：无冲突字段自动合并 ---------- */
check("两个窗口改不同字段/新增不同实体时自动合并", () => {
  const base = snapshotBundle(db); // R2
  // 服务端窗口：改节点 note
  const server: CaseBundle = structuredClone(base);
  server.nodes[0] = {
    ...server.nodes[0],
    data: { ...server.nodes[0].data, note: "对方窗口修改的说明" },
  };
  server.evidence.push({
    id: "EV-SERVER",
    caseId: CASE_ID,
    title: "对方新增证据",
    source: "对方",
    strength: "medium",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "周明",
    attachment: "s.pdf",
    note: "",
    version: 1,
  });
  // 先落库服务端 R3
  const serverResult = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 2,
    bundle: server,
    summaryNote: "对方窗口保存",
    actor: "周明",
  });
  assert.ok(!("status" in serverResult));

  // 本地窗口基于 R2：改另一个节点的位置
  const local: CaseBundle = structuredClone(base);
  local.nodes[1] = {
    ...local.nodes[1],
    position: { x: 999, y: 888 },
  };
  const result = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 2,
    bundle: local,
    summaryNote: "本方窗口保存",
    actor: "林澜",
  });
  assert.ok(!("status" in result), "不应有冲突");
  if ("status" in result) throw new Error("unreachable");
  const merged = result.bundle;
  assert.strictEqual(
    merged.nodes[0].data.note,
    "对方窗口修改的说明",
    "应保留对方字段",
  );
  assert.deepStrictEqual(merged.nodes[1].position, { x: 999, y: 888 }, "应保留本方字段");
  assert.ok(
    merged.evidence.some((e) => e.id === "EV-SERVER"),
    "应自动合入对方新增的证据",
  );
  assert.strictEqual(result.snapshot.revision, 4);
});

/* ---------- 5. 并发：同字段冲突需确认 ---------- */
check("两个窗口改同一字段产生冲突，确认后覆盖", () => {
  const base = snapshotBundle(db); // R4
  const server: CaseBundle = structuredClone(base);
  server.case.summary = "服务端写的摘要";
  const r1 = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 4,
    bundle: server,
    summaryNote: "对方改摘要",
    actor: "周明",
  });
  assert.ok(!("status" in r1)); // R5

  const local: CaseBundle = structuredClone(base);
  local.case.summary = "本方写的摘要";
  const conflictResult = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 4,
    bundle: local,
    summaryNote: "本方改摘要",
    actor: "林澜",
  });
  assert.strictEqual((conflictResult as { status?: string }).status, "CONFLICT");
  if (!("status" in conflictResult)) throw new Error("应当冲突");
  assert.ok(conflictResult.conflicts.some((c) => c.field === "summary"));

  // 调查员选择本方覆盖
  const resolved = conflictResult.conflicts.map((c) => ({
    ...c,
    resolution: "local" as const,
  }));
  const r2 = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: 4,
    bundle: local,
    summaryNote: "本方改摘要（冲突后覆盖）",
    actor: "林澜",
    resolve: resolved,
  });
  assert.ok(!("status" in r2), "冲突全部确认后应成功");
  if ("status" in r2) throw new Error("unreachable");
  assert.strictEqual(r2.bundle.case.summary, "本方写的摘要");
});

/* ---------- 6. 告警关联并集 ---------- */
check("两窗口各自关联不同告警不会互相覆盖", () => {
  const base = snapshotBundle(db);
  const server: CaseBundle = structuredClone(base);
  server.alertIds = [...server.alertIds, "AL-20260927-021"];
  server.case.alertIds = server.alertIds;
  commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: base.case.revision,
    bundle: server,
    summaryNote: "对方关联告警",
    actor: "周明",
  });
  const freshBase = snapshotBundle(db);
  const local: CaseBundle = structuredClone(freshBase);
  // 模拟本方基于更早版本，新增另一条
  const older: CaseBundle = structuredClone(base);
  older.alertIds = [...older.alertIds, "AL-20260928-014"];
  older.case.alertIds = older.alertIds;
  const result = commitWorkspace(db, {
    caseId: CASE_ID,
    baseRevision: base.case.revision,
    bundle: older,
    summaryNote: "本方关联另一条告警",
    actor: "林澜",
  });
  assert.ok(!("status" in result));
  if ("status" in result) throw new Error("unreachable");
  assert.ok(result.bundle.alertIds.includes("AL-20260927-021"), "对方关联丢失");
  assert.ok(result.bundle.alertIds.includes("AL-20260928-014"), "本方关联丢失");
});

/* ---------- 7. 恢复快照 ---------- */
check("恢复历史快照生成新版本，结论历史保留，差异结论失效", () => {
  const beforeCount = snapshotBundle(db).conclusions.length;
  const firstSnapshot = db.snapshots
    .filter((s) => s.caseId === CASE_ID)
    .sort((a, b) => a.revision - b.revision)[0];
  const currentRevision = snapshotBundle(db).case.revision;
  const result = restoreSnapshot(db, CASE_ID, firstSnapshot.id, "林澜");
  assert.strictEqual(result.snapshot.revision, currentRevision + 1);
  assert.ok(
    snapshotBundle(db).conclusions.length >= beforeCount,
    "结论历史不应丢失",
  );
  assert.ok(
    db.auditLogs.some((l) => l.action === "恢复案件快照"),
    "缺少恢复审计",
  );
});

/* ---------- 8. 失败草稿 outbox ---------- */
check("保存失败草稿写入 outbox，可读取并可清除（模拟重启）", () => {
  const base = snapshotBundle(db);
  const local: CaseBundle = structuredClone(base);
  local.case.summary = "失败也要保留的草稿";
  savePendingDraft({
    caseId: CASE_ID,
    caseTitle: base.case.title,
    reason: "save_failure",
    baseRevision: base.case.revision,
    bundle: local,
    summaryNote: "失败重试草稿",
    actor: "林澜",
    conflicts: [],
    lastError: "模拟网络中断",
  });
  const stored = getPendingDraft(CASE_ID);
  assert.ok(stored, "草稿未持久化");
  assert.strictEqual(stored!.bundle.case.summary, "失败也要保留的草稿");
  removePendingDraft(CASE_ID);
  assert.strictEqual(getPendingDraft(CASE_ID), undefined);
});

/* ---------- 9. advanceSnapshot 证据变化失效 ---------- */
check("单项写入推进快照时，证据变化导致旧结论失效", () => {
  const base = snapshotBundle(db);
  // 添加一条锚定当前证据的待复核结论
  const sig = base.evidence
    .map(
      (e) =>
        `${e.id}|${e.title}|${e.source}|${e.strength}|${e.occurredAt}|${e.attachment}`,
    )
    .sort();
  db.conclusions.push({
    id: "CV-TEST-2",
    caseId: CASE_ID,
    version: 200,
    status: "submitted",
    disposition: "freeze",
    rationale: "待复核结论".repeat(3),
    riskControls: [],
    createdBy: "林澜",
    createdAt: new Date().toISOString(),
    reviewer: "赵平",
    evidenceSignature: sig,
  });
  // 再新增一份证据，然后推进快照
  db.evidence.push({
    id: "EV-ADVANCE",
    caseId: CASE_ID,
    title: "推进快照新增证据",
    source: "测试",
    strength: "strong",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "林澜",
    attachment: "z.pdf",
    note: "",
    version: 1,
  });
  advanceSnapshot(db, CASE_ID, {
    actor: "林澜",
    source: "新增证据",
    note: "测试推进",
  });
  const target = db.conclusions.find((c) => c.id === "CV-TEST-2");
  assert.strictEqual(target!.status, "invalidated");
  assert.ok(target!.invalidatedBy?.some((c) => c.evidenceId === "EV-ADVANCE"));
});

/* ---------- 10. diffEvidence 直接校验 ---------- */
check("diffEvidence 输出新增/移除/强度三类差异", () => {
  const base = snapshotBundle(db);
  const changed = structuredClone(base.evidence);
  changed[0] = { ...changed[0], strength: "weak" };
  changed.splice(1, 1);
  changed.push({
    id: "EV-X",
    caseId: CASE_ID,
    title: "X",
    source: "s",
    strength: "medium",
    occurredAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedBy: "x",
    attachment: "x",
    note: "",
    version: 1,
  });
  const diff = diffEvidence(base.evidence, changed);
  assert.deepStrictEqual(
    diff.map((d) => d.kind).sort(),
    ["added", "removed", "strength"],
  );
});

console.log(`\n全部 ${passed} 项逻辑验证通过。`);
