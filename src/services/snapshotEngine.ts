import type {
  Alert,
  ConclusionVersion,
  Evidence,
  EvidenceChangeSet,
  EvidenceFingerprintItem,
} from "../models/types";
import type {
  CaseRecordMap,
  CaseSnapshot,
  CommitSnapshotRequest,
  CommitSnapshotSuccess,
  FieldConflict,
  SnapshotPatch,
  SnapshotSummary,
} from "../models/snapshot";
import { createId, nowIso } from "./mockStorage";

/** 模拟服务端保存失败（演示草稿保留与重试） */
export class SimulatedSaveError extends Error {
  constructor() {
    super("模拟保存失败：本地存储暂时不可用，草稿已保留。");
    this.name = "SimulatedSaveError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);

export const fingerprintEvidence = (
  evidence: Evidence[],
): EvidenceFingerprintItem[] =>
  evidence
    .map((item) => ({
      id: item.id,
      title: item.title,
      strength: item.strength,
      version: item.version,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

/** 以结论保存时的证据指纹为基线，列出新增、移除和强度差异 */
export const diffEvidence = (
  base: EvidenceFingerprintItem[],
  current: Evidence[],
): EvidenceChangeSet => {
  const currentItems = fingerprintEvidence(current);
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const baseById = new Map(base.map((item) => [item.id, item]));

  const added: EvidenceFingerprintItem[] = [];
  const removed: EvidenceFingerprintItem[] = [];
  const changed: EvidenceChangeSet["changed"] = [];

  for (const item of currentItems) {
    const before = baseById.get(item.id);
    if (!before) {
      added.push(item);
    } else if (before.strength !== item.strength) {
      changed.push({
        id: item.id,
        title: item.title,
        before: before.strength,
        after: item.strength,
      });
    }
  }
  for (const item of base) {
    if (!currentById.has(item.id)) {
      removed.push(item);
    }
  }

  return { added, removed, changed };
};

export const hasEvidenceChanges = (changeSet: EvidenceChangeSet): boolean =>
  changeSet.added.length > 0 ||
  changeSet.removed.length > 0 ||
  changeSet.changed.length > 0;

/* ------------------------------ 字段三方合并 ------------------------------ */

type PathValue = string | number | boolean | null;

const getPathValue = (snapshot: CaseSnapshot, path: string): PathValue => {
  if (path === "case.status") {
    return snapshot.case.status;
  }
  if (path === "case.summary") {
    return snapshot.case.summary;
  }
  if (path === "case.nextReviewAt") {
    return snapshot.case.nextReviewAt;
  }
  const strengthMatch = /^evidence\.(.+)\.strength$/.exec(path);
  if (strengthMatch) {
    return snapshot.evidence.find((item) => item.id === strengthMatch[1])
      ?.strength ?? null;
  }
  return null;
};

const collectWritePaths = (patch: SnapshotPatch): string[] => {
  const paths: string[] = [];
  if (patch.writes) {
    if (patch.writes.caseStatus !== undefined) paths.push("case.status");
    if (patch.writes.caseSummary !== undefined) paths.push("case.summary");
    if (patch.writes.caseNextReviewAt !== undefined)
      paths.push("case.nextReviewAt");
    for (const evidenceId of Object.keys(patch.writes.evidenceStrength ?? {})) {
      paths.push(`evidence.${evidenceId}.strength`);
    }
  }
  return paths;
};

const getMineValue = (
  patch: SnapshotPatch,
  path: string,
): PathValue | undefined => {
  if (!patch.writes) {
    return undefined;
  }
  if (path === "case.status") {
    return patch.writes.caseStatus;
  }
  if (path === "case.summary") {
    return patch.writes.caseSummary;
  }
  if (path === "case.nextReviewAt") {
    return patch.writes.caseNextReviewAt;
  }
  const strengthMatch = /^evidence\.(.+)\.strength$/.exec(path);
  if (strengthMatch) {
    return patch.writes.evidenceStrength?.[strengthMatch[1]];
  }
  return undefined;
};

const applyWrites = (
  snapshot: CaseSnapshot,
  patch: SnapshotPatch,
  keepTheirs: Set<string>,
): void => {
  if (!patch.writes) {
    return;
  }
  // 冲突时调查员选择"保留对方"的字段：不写入本方值
  if (
    patch.writes.caseStatus !== undefined &&
    !keepTheirs.has("case.status")
  ) {
    snapshot.case.status = patch.writes.caseStatus;
  }
  if (
    patch.writes.caseSummary !== undefined &&
    !keepTheirs.has("case.summary")
  ) {
    snapshot.case.summary = patch.writes.caseSummary;
  }
  if (
    patch.writes.caseNextReviewAt !== undefined &&
    !keepTheirs.has("case.nextReviewAt")
  ) {
    snapshot.case.nextReviewAt = patch.writes.caseNextReviewAt;
  }
  for (const [evidenceId, strength] of Object.entries(
    patch.writes.evidenceStrength ?? {},
  ) as Array<[string, Evidence["strength"]]>) {
    if (keepTheirs.has(`evidence.${evidenceId}.strength`)) {
      continue;
    }
    const evidence = snapshot.evidence.find((item) => item.id === evidenceId);
    if (evidence) {
      evidence.strength = strength;
      evidence.version += 1;
    }
  }
};

const conflictLabel = (path: string): string => {
  if (path === "case.status") {
    return "案件状态";
  }
  if (path === "case.summary") {
    return "案件摘要";
  }
  if (path === "case.nextReviewAt") {
    return "下次复核时间";
  }
  const strengthMatch = /^evidence\.(.+)\.strength$/.exec(path);
  if (strengthMatch) {
    return `证据 ${strengthMatch[1]} 强度`;
  }
  return path;
};

interface MergeFieldResult {
  conflicts: FieldConflict[];
  /** 本方未改动、直接采用另一方保存结果的字段（无冲突字段先合并） */
  autoMergedPaths: string[];
}

/**
 * 字段级三方合并：
 * - 仅一方相对 base 修改：自动并入；
 * - 双方都改为相同值：无冲突；
 * - 双方改成不同值：列为冲突，调查员确认后才能覆盖。
 */
const mergeFields = (
  base: CaseSnapshot,
  theirs: CaseSnapshot,
  patch: SnapshotPatch,
  resolvedPaths: Set<string>,
  acknowledgedPaths: Set<string>,
): MergeFieldResult => {
  const conflicts: FieldConflict[] = [];
  const autoMergedPaths: string[] = [];
  const paths = new Set([
    ...collectWritePaths(patch),
    ...["case.status", "case.summary", "case.nextReviewAt"],
  ]);

  for (const path of paths) {
    const baseValue = getPathValue(base, path);
    const theirValue = getPathValue(theirs, path);
    const mineValue = getMineValue(patch, path);
    const mineChanged = mineValue !== undefined && mineValue !== baseValue;
    const theirsChanged = theirValue !== baseValue;

    if (!theirsChanged) {
      continue;
    }
    if (!mineChanged) {
      autoMergedPaths.push(path);
      continue;
    }
    if (mineValue === theirValue) {
      continue;
    }
    // 调查员已在弹窗确认过：覆盖或保留对方都不再算冲突
    if (resolvedPaths.has(path) || acknowledgedPaths.has(path)) {
      continue;
    }
    conflicts.push({
      path,
      label: conflictLabel(path),
      base: baseValue,
      theirs: theirValue,
      mine: mineValue ?? null,
    });
  }

  return { conflicts, autoMergedPaths };
};

/* ------------------------------ 集合并集合并 ------------------------------ */

const mergeById = <T extends { id: string }>(
  baseItems: T[],
  theirItems: T[],
  mineNew: T[],
): { merged: T[]; autoMerged: T[] } => {
  const merged = new Map<string, T>();
  for (const item of baseItems) {
    merged.set(item.id, item);
  }
  const mineIds = new Set(mineNew.map((item) => item.id));
  const autoMerged: T[] = [];
  for (const item of theirItems) {
    if (!merged.has(item.id) && !mineIds.has(item.id)) {
      autoMerged.push(item);
    }
    merged.set(item.id, item);
  }
  for (const item of mineNew) {
    merged.set(item.id, item);
  }
  return { merged: Array.from(merged.values()), autoMerged };
};

/* ------------------------------ 结论失效重算 ------------------------------ */

const revalidateConclusions = (snapshot: CaseSnapshot): string[] => {
  const invalidatedIds: string[] = [];
  const currentFingerprint = fingerprintEvidence(snapshot.evidence);
  let shouldReopen = false;

  for (const conclusion of snapshot.conclusions) {
    if (conclusion.status === "approved") {
      continue;
    }
    const changeSet = diffEvidence(
      conclusion.evidenceFingerprint ?? [],
      snapshot.evidence,
    );
    if (conclusion.status === "invalidated") {
      // 证据恢复到该版本基线时可解除失效
      if (!hasEvidenceChanges(changeSet)) {
        conclusion.status = "draft";
        conclusion.invalidatedAt = undefined;
        conclusion.invalidation = undefined;
      }
      continue;
    }
    if (hasEvidenceChanges(changeSet)) {
      conclusion.status = "invalidated";
      conclusion.invalidatedAt = nowIso();
      conclusion.invalidation = changeSet;
      invalidatedIds.push(conclusion.id);
      if (conclusion.version === latestVersion(snapshot.conclusions)) {
        shouldReopen = true;
      }
    }
  }

  // 旧结论失效后，待复核案件回到调查中，避免沿用旧结论
  if (
    shouldReopen &&
    (snapshot.case.status === "pending_review" ||
      snapshot.case.status === "supplement")
  ) {
    snapshot.case.status = "investigating";
  }

  return invalidatedIds;
};

const latestVersion = (conclusions: ConclusionVersion[]): number =>
  conclusions.reduce((max, item) => Math.max(max, item.version), 0);

/* ------------------------------ 快照恢复 ------------------------------ */

export const findSnapshotAtRevision = (
  snapshots: CaseRecordMap,
  caseId: string,
  revision: number,
): CaseSnapshot | null => {
  const record = snapshots[caseId];
  if (!record) {
    return null;
  }
  if (revision === record.revision) {
    return record.snapshot;
  }
  return (
    record.history.find((item) => item.revision === revision)?.snapshot ?? null
  );
};

export interface RestoreInput {
  caseId: string;
  revision: number;
  actor: string;
  label: string;
}

export const restoreSnapshot = (
  snapshots: CaseRecordMap,
  input: RestoreInput,
):
  | { snapshot: CaseSnapshot; restoredFrom: CaseSnapshot }
  | { error: string } => {
  const target = findSnapshotAtRevision(
    snapshots,
    input.caseId,
    input.revision,
  );
  if (!target) {
    return { error: "待恢复的快照版本不存在" };
  }
  const copy = clone(target);
  return { snapshot: copy, restoredFrom: clone(target) };
};

/* ------------------------------ 主提交流程 ------------------------------ */

export interface CommitContext {
  shouldFail: boolean;
}

export interface CommitConflictResult {
  conflicts: FieldConflict[];
  autoMerged: number;
}

export type CommitResult =
  | { type: "conflict"; conflicts: FieldConflict[]; autoMerged: number }
  | { type: "committed"; success: CommitSnapshotSuccess };

/**
 * 对一份案件快照执行保存。
 * 调用方（api 层）负责：模拟失败开关、写库、审计与全局告警同步。
 */
export const commitSnapshot = (
  snapshots: CaseRecordMap,
  request: CommitSnapshotRequest,
  context: CommitContext,
): CommitResult => {
  if (context.shouldFail) {
    throw new SimulatedSaveError();
  }

  const record = snapshots[request.caseId];
  if (!record) {
    throw new Error("案件不存在");
  }

  // 恢复历史快照：以历史内容生成新版本（旧版本仍保留，可再次恢复）
  if (request.restoreFromRevision !== undefined) {
    const restoredResult = restoreSnapshot(snapshots, {
      caseId: request.caseId,
      revision: request.restoreFromRevision,
      actor: request.actor,
      label: request.description,
    });
    if ("error" in restoredResult) {
      throw new Error(restoredResult.error);
    }
    const restored = restoredResult.snapshot;
    restored.case.updatedAt = nowIso();
    const revision = record.revision + 1;
    const summary: SnapshotSummary = {
      kinds: request.kinds,
      description: request.description,
      stats: {
        nodesAdded: 0,
        edgesAdded: 0,
        evidenceAdded: 0,
        evidenceChanged: 0,
        evidenceRemoved: 0,
        conclusionsAdded: 0,
        alertsLinked: 0,
        autoMerged: 0,
        conflictsResolved: 0,
        conclusionsInvalidated: 0,
      },
    };
    record.snapshot = restored;
    record.revision = revision;
    record.history.unshift({
      revision,
      at: nowIso(),
      actor: request.actor,
      kinds: request.kinds,
      label: request.description,
      description: request.description,
      restoredFromRevision: request.restoreFromRevision,
      snapshot: clone(restored),
      stats: summary.stats,
    });
    return {
      type: "committed",
      success: {
        revision,
        snapshot: clone(restored),
        summary,
        conflicts: [],
        autoMerged: 0,
        invalidatedConclusionIds: [],
      },
    };
  }

  const base: CaseSnapshot = clone(
    findSnapshotAtRevision(
      snapshots,
      request.caseId,
      request.baseRevision,
    ) ?? record.snapshot,
  );
  const theirs: CaseSnapshot = clone(record.snapshot);
  const patch = request.patch;
  const resolvedPaths = new Set(request.resolvedPaths ?? []);
  const acknowledgedPaths = new Set(request.acknowledgedConflicts ?? []);

  // 1. 字段三方合并
  const fieldMerge = mergeFields(
    base,
    theirs,
    patch,
    resolvedPaths,
    acknowledgedPaths,
  );
  if (fieldMerge.conflicts.length > 0) {
    return {
      type: "conflict",
      conflicts: fieldMerge.conflicts,
      autoMerged: fieldMerge.autoMergedPaths.length,
    };
  }

  // 弹窗中确认"保留对方"的字段：合并时丢弃本方写入
  const keepTheirs = new Set(
    Array.from(acknowledgedPaths).filter((path) => !resolvedPaths.has(path)),
  );

  // 2. 从另一方最新保存开始并入（无冲突字段先合并）
  const merged: CaseSnapshot = clone(theirs);

  // 3. 集合并集：本方新增的节点 / 关系 / 证据 / 告警
  const nodeMerge = mergeById(base.nodes, theirs.nodes, patch.nodes ?? []);
  merged.nodes = nodeMerge.merged;
  const edgeMerge = mergeById(base.edges, theirs.edges, patch.edges ?? []);
  merged.edges = edgeMerge.merged;
  const evidenceMerge = mergeById(
    base.evidence,
    theirs.evidence,
    patch.evidence ?? [],
  );
  merged.evidence = evidenceMerge.merged;
  const alertMerge = mergeById(base.alerts, theirs.alerts, patch.alerts ?? []);
  merged.alerts = alertMerge.merged;

  // 4. 证据移除（本方移除为准；另一方新增同 id 的情况不会发生，id 由客户端生成）
  if (patch.removeEvidenceIds?.length) {
    merged.evidence = merged.evidence.filter(
      (item) => !patch.removeEvidenceIds!.includes(item.id),
    );
  }

  // 5. 应用字段写入（含证据强度调整；选择"保留对方"的冲突字段跳过）
  applyWrites(merged, patch, keepTheirs);

  // 6. 结论：新建版本
  if (patch.addConclusion) {
    const version = latestVersion(merged.conclusions) + 1;
    const conclusion: ConclusionVersion = {
      id: createId("CV"),
      caseId: request.caseId,
      version,
      status: patch.addConclusion.submit ? "submitted" : "draft",
      disposition: patch.addConclusion.disposition,
      rationale: patch.addConclusion.rationale,
      riskControls: patch.addConclusion.riskControls,
      createdBy: request.actor,
      createdAt: nowIso(),
      reviewer: "赵平",
      evidenceFingerprint: fingerprintEvidence(merged.evidence),
      baseRevision: record.revision + 1,
    };
    merged.conclusions.unshift(conclusion);
    merged.case.status = patch.addConclusion.submit
      ? "pending_review"
      : "investigating";
  }

  // 7. 结论复核
  if (patch.reviewConclusion) {
    const conclusion = merged.conclusions.find(
      (item) => item.id === patch.reviewConclusion!.conclusionId,
    );
    if (!conclusion) {
      throw new Error("结论不存在");
    }
    if (conclusion.status === "invalidated") {
      throw new Error("该结论依据的证据已变化并失效，请基于最新证据重算结论。");
    }
    if (conclusion.status === "approved" || conclusion.status === "returned") {
      throw new Error("当前版本不能再次复核。");
    }
    const { decision, reviewerNote } = patch.reviewConclusion;
    conclusion.status = decision === "approve" ? "approved" : "returned";
    conclusion.reviewerNote = reviewerNote;
    merged.case.status = decision === "approve" ? "closed" : "supplement";
  }

  // 8. 证据变化后旧结论失效重算
  const invalidatedConclusionIds = revalidateConclusions(merged);

  // 9. 排序与时间戳
  merged.conclusions.sort((a, b) => b.version - a.version);
  merged.case.updatedAt = nowIso();

  // 10. 版本摘要统计
  const baseNodeIds = new Set(base.nodes.map((item) => item.id));
  const baseEdgeIds = new Set(base.edges.map((item) => item.id));
  const baseEvidenceIds = new Set(base.evidence.map((item) => item.id));
  const baseConclusionIds = new Set(base.conclusions.map((item) => item.id));
  const baseAlertIds = new Set(base.alerts.map((item) => item.id));

  const mineNodeIds = new Set((patch.nodes ?? []).map((item) => item.id));
  const mineEdgeIds = new Set((patch.edges ?? []).map((item) => item.id));
  const mineEvidenceIds = new Set(
    (patch.evidence ?? []).map((item) => item.id),
  );
  const mineAlertIds = new Set((patch.alerts ?? []).map((item) => item.id));

  const autoMergedEntities =
    nodeMerge.autoMerged.length +
    edgeMerge.autoMerged.length +
    evidenceMerge.autoMerged.length +
    alertMerge.autoMerged.length;
  const autoMergedFields = fieldMerge.autoMergedPaths.length;
  const autoMerged = autoMergedEntities + autoMergedFields;

  const summary: SnapshotSummary = {
    kinds: request.kinds,
    description: request.description,
    stats: {
      nodesAdded: merged.nodes.filter(
        (item) => !baseNodeIds.has(item.id) && mineNodeIds.has(item.id),
      ).length,
      edgesAdded: merged.edges.filter(
        (item) => !baseEdgeIds.has(item.id) && mineEdgeIds.has(item.id),
      ).length,
      evidenceAdded: merged.evidence.filter(
        (item) => !baseEvidenceIds.has(item.id) && mineEvidenceIds.has(item.id),
      ).length,
      evidenceChanged: Object.keys(
        patch.writes?.evidenceStrength ?? {},
      ).length,
      evidenceRemoved: (patch.removeEvidenceIds ?? []).filter((id) =>
        baseEvidenceIds.has(id),
      ).length,
      conclusionsAdded: patch.addConclusion
        ? 1
        : merged.conclusions.filter(
              (item) => !baseConclusionIds.has(item.id),
            ).length,
      alertsLinked: merged.alerts.filter(
        (item) => !baseAlertIds.has(item.id) && mineAlertIds.has(item.id),
      ).length,
      autoMerged,
      conflictsResolved: resolvedPaths.size,
      conclusionsInvalidated: invalidatedConclusionIds.length,
    },
  };

  const revision = record.revision + 1;
  record.snapshot = merged;
  record.revision = revision;
  record.history.unshift({
    revision,
    at: nowIso(),
    actor: request.actor,
    kinds: request.kinds,
    label: request.description,
    description: request.description,
    snapshot: clone(merged),
    stats: summary.stats,
  });
  // 历史最多保留 30 个完整快照，超出后仅保留摘要以外裁剪（这里保留全部快照）
  if (record.history.length > 30) {
    record.history.length = 30;
  }

  return {
    type: "committed",
    success: {
      revision,
      snapshot: clone(merged),
      summary,
      conflicts: [],
      autoMerged,
      invalidatedConclusionIds,
    },
  };
};

/** 将快照中的告警同步回全局告警台账 */
export const syncGlobalAlerts = (
  globalAlerts: Alert[],
  snapshot: CaseSnapshot,
): Alert[] => {
  const linkedById = new Map(snapshot.alerts.map((item) => [item.id, item]));
  let changed = false;
  const next = globalAlerts.map((item) => {
    const linked = linkedById.get(item.id);
    if (linked) {
      linkedById.delete(item.id);
      if (
        item.caseId !== snapshot.case.id ||
        item.status !== linked.status
      ) {
        changed = true;
        return { ...item, ...linked, caseId: snapshot.case.id };
      }
      return item;
    }
    return item;
  });
  // 快照中存在但全局台账缺失（极端情况）的告警补入
  for (const remaining of linkedById.values()) {
    changed = true;
    next.push(remaining);
  }
  return changed ? next : globalAlerts;
};
