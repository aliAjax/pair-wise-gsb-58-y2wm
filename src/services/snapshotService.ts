import type {
  CaseBundle,
  CaseSnapshot,
  ConclusionVersion,
  PendingConclusion,
  SaveWorkspaceInput,
  WorkspaceConflict,
} from "../models/types";
import {
  appendAudit,
  buildSnapshotRecord,
  createId,
  getCaseBundle,
  getLatestSnapshot,
  getSnapshotAtRevision,
  nowIso,
  type MockDatabase,
} from "./mockStorage";
import {
  applyConflictResolutions,
  describeSummary,
  evidenceSignature,
  findStaleConclusions,
  reconcileBundles,
} from "./snapshotCore";

export interface ConflictError {
  status: "CONFLICT";
  conflicts: WorkspaceConflict[];
  autoMerged: WorkspaceConflict[];
  serverRevision: number;
}

export interface CommitSuccess {
  bundle: CaseBundle;
  snapshot: CaseSnapshot;
  autoMerged: WorkspaceConflict[];
}

/** 将合并后的案件包写回整库 */
const applyBundle = (database: MockDatabase, bundle: CaseBundle): void => {
  const caseIndex = database.cases.findIndex(
    (item) => item.id === bundle.case.id,
  );
  if (caseIndex < 0) {
    throw new Error("案件不存在");
  }

  const keptCase = database.cases[caseIndex];
  database.cases[caseIndex] = {
    ...keptCase,
    title: bundle.case.title,
    summary: bundle.case.summary,
    owner: bundle.case.owner,
    riskLevel: bundle.case.riskLevel,
    nextReviewAt: bundle.case.nextReviewAt,
    status: bundle.case.status,
    alertIds: bundle.alertIds,
    updatedAt: bundle.case.updatedAt,
    revision: bundle.case.revision,
  };

  // 告警联动：纳入关联、移出则回到研判中
  database.alerts = database.alerts.map((alert) => {
    const linked = bundle.alertIds.includes(alert.id);
    if (linked) {
      return { ...alert, caseId: bundle.case.id, status: "linked" as const };
    }
    if (alert.caseId === bundle.case.id) {
      return { ...alert, caseId: undefined, status: "triage" as const };
    }
    return alert;
  });

  database.nodes = [
    ...database.nodes.filter((item) => item.caseId !== bundle.case.id),
    ...bundle.nodes.map((item) => ({ ...item, caseId: bundle.case.id })),
  ];
  database.edges = [
    ...database.edges.filter((item) => item.caseId !== bundle.case.id),
    ...bundle.edges.map((item) => ({ ...item, caseId: bundle.case.id })),
  ];
  database.evidence = [
    ...database.evidence.filter((item) => item.caseId !== bundle.case.id),
    ...bundle.evidence.map((item) => ({ ...item, caseId: bundle.case.id })),
  ];
  database.conclusions = [
    ...database.conclusions.filter(
      (item) => item.caseId !== bundle.case.id,
    ),
    ...bundle.conclusions.map((item) => ({
      ...item,
      caseId: bundle.case.id,
    })),
  ];
};

const buildNextConclusion = (
  bundle: CaseBundle,
  input: PendingConclusion,
): ConclusionVersion => {
  const version =
    bundle.conclusions.reduce((max, item) => Math.max(max, item.version), 0) +
    1;
  return {
    id: createId("CV"),
    caseId: bundle.case.id,
    version,
    status: input.submit ? "submitted" : "draft",
    disposition: input.disposition,
    rationale: input.rationale,
    riskControls: input.riskControls,
    createdBy: "林澜",
    createdAt: nowIso(),
    reviewer: "赵平",
    evidenceSignature: evidenceSignature(bundle.evidence),
  };
};

const markStaleConclusions = (
  database: MockDatabase,
  bundle: CaseBundle,
  revision: number,
): ConclusionVersion[] => {
  const stale = findStaleConclusions(bundle.conclusions, bundle.evidence);
  const staleIds = new Set(stale.map((item) => item.conclusion.id));
  database.conclusions = database.conclusions.map((item) => {
    const match = stale.find((entry) => entry.conclusion.id === item.id);
    if (!match) {
      return item;
    }
    return {
      ...item,
      status: "invalidated" as const,
      invalidatedBy: match.changes,
      invalidatedAt: nowIso(),
      invalidatedRevision: revision,
    };
  });
  bundle.conclusions = bundle.conclusions.map((item) =>
    staleIds.has(item.id)
      ? {
          ...item,
          status: "invalidated" as const,
          invalidatedBy: stale.find((entry) => entry.conclusion.id === item.id)
            ?.changes,
          invalidatedAt: nowIso(),
          invalidatedRevision: revision,
        }
      : item,
  );
  return bundle.conclusions.filter((item) => staleIds.has(item.id));
};

/**
 * 统一保存入口：baseRevision 乐观并发，三方合并无冲突字段，
 * 证据变化自动失效旧结论，产生带摘要的可恢复快照。
 */
export const commitWorkspace = (
  database: MockDatabase,
  input: SaveWorkspaceInput,
): CommitSuccess | ConflictError => {
  const targetCase = database.cases.find((item) => item.id === input.caseId);
  if (!targetCase) {
    throw new Error("案件不存在");
  }

  const serverBundle = getCaseBundle(database, input.caseId);
  if (!serverBundle) {
    throw new Error("案件不存在");
  }

  const baseSnapshot =
    getSnapshotAtRevision(database, input.caseId, input.baseRevision) ??
    getLatestSnapshot(database, input.caseId);
  const baseBundle = baseSnapshot?.bundle ?? serverBundle;

  let reconciled: CaseBundle;
  let autoMerged: WorkspaceConflict[] = [];

  if (input.resolve && input.resolve.length > 0) {
    const resolved = applyConflictResolutions(
      baseBundle,
      serverBundle,
      input.bundle,
      input.resolve,
    );
    if (resolved.unresolved.length > 0) {
      return {
        status: "CONFLICT",
        conflicts: resolved.unresolved,
        autoMerged,
        serverRevision: serverBundle.case.revision,
      };
    }
    reconciled = resolved.bundle;
  } else {
    const result = reconcileBundles(baseBundle, serverBundle, input.bundle);
    autoMerged = result.autoMerged;
    if (result.conflicts.length > 0) {
      return {
        status: "CONFLICT",
        conflicts: result.conflicts,
        autoMerged: result.autoMerged,
        serverRevision: serverBundle.case.revision,
      };
    }
    reconciled = result.merged;
  }

  const nextRevision = serverBundle.case.revision + 1;
  // 告警关联以顶层 alertIds 的合并结果为准，并同步回 case 字段
  reconciled.case = {
    ...reconciled.case,
    id: input.caseId,
    revision: nextRevision,
    updatedAt: nowIso(),
    alertIds: reconciled.alertIds,
  };

  if (input.conclusion) {
    reconciled.case.status = input.conclusion.submit
      ? "pending_review"
      : "investigating";
  }

  applyBundle(database, reconciled);

  // 证据变化 → 旧结论失效（写库后基于合并结果判定）
  const afterApply = getCaseBundle(database, input.caseId);
  if (!afterApply) {
    throw new Error("案件不存在");
  }
  const invalidated = markStaleConclusions(
    database,
    afterApply,
    nextRevision,
  );

  // 新结论在失效判定之后创建，携带最新证据指纹
  if (input.conclusion) {
    const conclusion = buildNextConclusion(afterApply, input.conclusion);
    database.conclusions.push(conclusion);
    afterApply.conclusions.push(conclusion);
  }

  const snapshot = buildSnapshotRecord(database, input.caseId, {
    revision: nextRevision,
    savedBy: input.actor,
    source: input.conclusion ? "保存结论与快照" : "案件快照保存",
    note: input.summaryNote,
    previous: serverBundle,
    invalidated,
  });

  const summaryParts = describeSummary(snapshot.summary);
  appendAudit(database, {
    caseId: input.caseId,
    actor: input.actor,
    action: "保存案件快照",
    detail:
      `R${nextRevision}：${input.summaryNote}` +
      (summaryParts.length ? `（${summaryParts.join("，")}）` : "") +
      (autoMerged.length
        ? `；自动合入对方窗口的无冲突改动 ${autoMerged.length} 项`
        : ""),
  });

  return {
    bundle: getCaseBundle(database, input.caseId) ?? afterApply,
    snapshot,
    autoMerged,
  };
};

/**
 * 遗留的单项写入（关联告警、登记证据、状态流转、复核）在完成自身改动后
 * 调用本函数：统一推进 revision、失效受影响结论并落一条快照。
 */
export const advanceSnapshot = (
  database: MockDatabase,
  caseId: string,
  params: {
    actor: string;
    source: string;
    note: string;
  },
): CaseSnapshot | undefined => {
  const previous = getCaseBundle(database, caseId);
  if (!previous) {
    return undefined;
  }
  const revision = previous.case.revision + 1;
  database.cases = database.cases.map((item) =>
    item.id === caseId
      ? { ...item, revision, updatedAt: nowIso() }
      : item,
  );
  const current = getCaseBundle(database, caseId);
  if (!current) {
    return undefined;
  }
  current.case.revision = revision;
  const invalidated = markStaleConclusions(database, current, revision);
  const snapshot = buildSnapshotRecord(database, caseId, {
    revision,
    savedBy: params.actor,
    source: params.source,
    note: params.note,
    previous,
    invalidated,
  });
  const summaryParts = describeSummary(snapshot.summary);
  appendAudit(database, {
    caseId,
    actor: params.actor,
    action: params.source,
    detail:
      `R${revision}：${params.note}` +
      (summaryParts.length ? `（${summaryParts.join("，")}）` : "") +
      (invalidated.length
        ? `；证据变化已使 ${invalidated.length} 份旧结论失效`
        : ""),
  });
  return snapshot;
};

/** 恢复到指定快照：数据面回滚为新快照，结论历史保留并按证据差异自动失效 */
export const restoreSnapshot = (
  database: MockDatabase,
  caseId: string,
  snapshotId: string,
  actor: string,
): CommitSuccess => {
  const target = database.snapshots.find(
    (item) => item.id === snapshotId && item.caseId === caseId,
  );
  if (!target) {
    throw new Error("快照不存在");
  }

  const serverBundle = getCaseBundle(database, caseId);
  if (!serverBundle) {
    throw new Error("案件不存在");
  }

  const revision = serverBundle.case.revision + 1;
  const restored: CaseBundle = structuredClone(target.bundle);
  restored.case.revision = revision;
  restored.case.updatedAt = nowIso();
  restored.alertIds = restored.case.alertIds;
  // 结论历史不可变，沿用当前历史（其中的有效版本会因证据差异被失效）
  restored.conclusions = serverBundle.conclusions;

  applyBundle(database, restored);
  const afterApply = getCaseBundle(database, caseId);
  if (!afterApply) {
    throw new Error("案件不存在");
  }
  const invalidated = markStaleConclusions(database, afterApply, revision);
  const snapshot = buildSnapshotRecord(database, caseId, {
    revision,
    savedBy: actor,
    source: "恢复快照",
    note: `恢复到 R${target.revision}`,
    previous: serverBundle,
    invalidated,
  });
  appendAudit(database, {
    caseId,
    actor,
    action: "恢复案件快照",
    detail:
      `R${revision}：已恢复到 R${target.revision}（${target.summary.note}）` +
      (invalidated.length
        ? `，${invalidated.length} 份旧结论因证据差异失效`
        : ""),
  });

  return {
    bundle: getCaseBundle(database, caseId) ?? afterApply,
    snapshot,
    autoMerged: [],
  };
};
