/**
 * 存储层端到端验证：localStorage shim 下验证
 * v1→v2 迁移、失败草稿持久化、失败开关、重置清理。
 */
import assert from "node:assert";

class LocalStorageShim {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

// @ts-expect-error 构造最小浏览器环境
globalThis.window = {
  localStorage: new LocalStorageShim(),
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
};

const {
  readDatabase,
  writeDatabase,
  resetDatabase,
  readPendingDrafts,
  upsertPendingDraft,
  getSimulateFailure,
  setSimulateFailure,
} = await import("../src/services/mockStorage.ts");
const { DATABASE_STORAGE_KEY, LEGACY_DATABASE_STORAGE_KEY } = await import(
  "../src/services/storageKeys.ts"
);

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log("A. 首次访问写入 v2 种子");
{
  const db = readDatabase();
  check("v2 含三个案件快照", () => {
    assert.equal(Object.keys(db.snapshots).length, 3);
    assert.ok(db.snapshots["CASE-2026-017"].history[0].snapshot);
  });
  check("localStorage 已写入 v2 键", () => {
    assert.ok(window.localStorage.getItem(DATABASE_STORAGE_KEY));
  });
}

console.log("B. 旧版 v1 数据自动迁移为可恢复快照");
{
  window.localStorage.removeItem(DATABASE_STORAGE_KEY);
  const v1 = {
    alerts: [
      {
        id: "AL-1",
        title: "t",
        account: "a",
        counterparty: "c",
        channel: "手机银行",
        amount: 1,
        riskLevel: "high",
        score: 90,
        status: "new",
        detectedAt: new Date().toISOString(),
        tags: [],
        deviceId: "D",
        ip: "1.1.1.1",
      },
    ],
    cases: [
      {
        id: "C1",
        title: "旧案件",
        status: "investigating",
        riskLevel: "high",
        owner: "林澜",
        openedAt: "2026-09-01T00:00:00+08:00",
        updatedAt: "2026-09-02T00:00:00+08:00",
        summary: "s",
        alertIds: [],
        nextReviewAt: "2026-09-03T00:00:00+08:00",
      },
    ],
    nodes: [],
    edges: [],
    evidence: [],
    conclusions: [],
    auditLogs: [],
  };
  window.localStorage.setItem(
    LEGACY_DATABASE_STORAGE_KEY,
    JSON.stringify(v1),
  );
  const db = readDatabase();
  check("v1 案件迁移进 snapshots", () => {
    assert.ok(db.snapshots.C1);
    assert.equal(db.snapshots.C1.snapshot.case.title, "旧案件");
    assert.equal(db.snapshots.C1.revision, 1);
  });
  check("迁移后 v2 键已持久化", () => {
    assert.ok(window.localStorage.getItem(DATABASE_STORAGE_KEY));
  });
  const again = readDatabase();
  check("再次读取走 v2，不重复迁移", () => {
    assert.equal(again.snapshots.C1.revision, 1);
  });
}

console.log("C. 保存失败草稿跨读取持久化");
{
  resetDatabase();
  upsertPendingDraft({
    draftId: "D1",
    caseId: "CASE-2026-017",
    createdAt: "2026-09-30T08:00:00+08:00",
    lastAttemptAt: "2026-09-30T08:05:00+08:00",
    attempts: 2,
    stage: "failed",
    reason: "模拟保存失败",
    request: {
      caseId: "CASE-2026-017",
      baseRevision: 1,
      kinds: ["graph"],
      description: "失败的节点",
      actor: "林澜",
      patch: { nodes: [] },
    },
  });
  check("草稿可重新读出（重启后仍在）", () => {
    const drafts = readPendingDrafts();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].draftId, "D1");
    assert.equal(drafts[0].attempts, 2);
  });
}

console.log("D. 失败模拟开关");
{
  check("默认关闭", () => assert.equal(getSimulateFailure(), false));
  setSimulateFailure(true);
  check("开启后读取为 true（跨调用持久化）", () => {
    assert.equal(getSimulateFailure(), true);
  });
  const db = resetDatabase();
  check("重置演示数据后开关关闭且草稿清空", () => {
    assert.equal(getSimulateFailure(), false);
    assert.equal(readPendingDrafts().length, 0);
    assert.ok(db.snapshots["CASE-2026-017"]);
  });
}

console.log("E. 写库后读回一致");
{
  const db = readDatabase();
  db.snapshots["CASE-2026-017"].snapshot.case.summary = "手动改摘要";
  writeDatabase(db);
  check("摘要改动持久化", () => {
    assert.equal(
      readDatabase().snapshots["CASE-2026-017"].snapshot.case.summary,
      "手动改摘要",
    );
  });
  resetDatabase();
}

console.log(`\n全部 ${passed} 项存储层检查通过。`);
