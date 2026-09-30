import type {
  Alert,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
  SnapshotSaveKind,
} from "./types";

/**
 * 案件可恢复快照：告警、案件、关系图谱、证据台账、结论版本
 * 全部接入同一份快照，保存一次即产生一个新的 revision。
 */
export interface CaseSnapshot {
  case: InvestigationCase;
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  alerts: Alert[];
}

export interface SnapshotSummary {
  /** 本次保存涉及的领域，用于版本摘要展示 */
  kinds: SnapshotSaveKind[];
  description: string;
  stats: {
    nodesAdded: number;
    edgesAdded: number;
    evidenceAdded: number;
    evidenceChanged: number;
    evidenceRemoved: number;
    conclusionsAdded: number;
    alertsLinked: number;
    /** 三方合并时，与另一个窗口的保存无冲突而自动并入的字段数 */
    autoMerged: number;
    /** 调查员确认后覆盖的冲突字段数 */
    conflictsResolved: number;
    /** 本次保存导致失效的旧结论数 */
    conclusionsInvalidated: number;
  };
}

export interface SnapshotHistoryEntry extends SnapshotSummary {
  revision: number;
  at: string;
  actor: string;
  /** 保存时携带的版本摘要，审计与恢复共用 */
  label: string;
  restoredFromRevision?: number;
  /** 该版本的完整快照，用于可恢复（旧版本保留，重启后仍可查看） */
  snapshot?: CaseSnapshot;
}

export interface CaseSnapshotRecord {
  caseId: string;
  revision: number;
  snapshot: CaseSnapshot;
  history: SnapshotHistoryEntry[];
}

export type CaseRecordMap = Record<string, CaseSnapshotRecord>;

/* ----------------------------- 三方合并 / 补丁 ----------------------------- */

/**
 * 一次保存提交的补丁。集合类操作按 id 并集自动合入；
 * writes 为可冲突字段，服务端按 base / theirs / mine 做三方合并。
 */
export interface SnapshotPatch {
  nodes?: InvestigationNode[];
  edges?: InvestigationEdge[];
  evidence?: Evidence[];
  removeEvidenceIds?: string[];
  alerts?: Alert[];
  writeCase?: Partial<
    Pick<InvestigationCase, "status" | "summary" | "nextReviewAt">
  >;
  writes?: {
    caseStatus?: InvestigationCase["status"];
    caseSummary?: string;
    caseNextReviewAt?: string;
    evidenceStrength?: Record<string, Evidence["strength"]>;
  };
  addConclusion?: {
    disposition: ConclusionVersion["disposition"];
    rationale: string;
    riskControls: string[];
    submit: boolean;
  };
  reviewConclusion?: {
    conclusionId: string;
    decision: "approve" | "return";
    reviewerNote: string;
  };
}

export interface FieldConflict {
  /** 冲突字段路径，如 case.status / evidence.EV-1.strength */
  path: string;
  /** 人类可读的冲突项名称 */
  label: string;
  base: string | number | boolean | null;
  theirs: string | number | boolean | null;
  mine: string | number | boolean | null;
}

export interface CommitSnapshotRequest {
  caseId: string;
  /** 本次保存所依据的快照版本；与服务端不一致则触发三方合并 */
  baseRevision: number;
  patch: SnapshotPatch;
  kinds: SnapshotSaveKind[];
  description: string;
  actor: string;
  /** 调查员在冲突确认弹窗中选择"以我的修改覆盖"的字段路径 */
  resolvedPaths?: string[];
  /**
   * 弹窗中已经向调查员展示并完成选择的全部冲突字段。
   * 其中出现在 resolvedPaths 里的以本方覆盖；其余视为选择"保留对方"，
   * 重试时不再追问，也不会写入本方的值。
   */
  acknowledgedConflicts?: string[];
  /** 恢复历史快照时的目标 revision */
  restoreFromRevision?: number;
}

export interface CommitSnapshotSuccess {
  revision: number;
  snapshot: CaseSnapshot;
  summary: SnapshotSummary;
  conflicts: FieldConflict[];
  autoMerged: number;
  /** 本次保存被标记失效的结论（用于前端展示新增/移除/强度差异） */
  invalidatedConclusionIds: string[];
}

export type CommitSnapshotOutcome =
  | { ok: true; result: CommitSnapshotSuccess }
  | {
      ok: false;
      error: string;
      conflicts?: FieldConflict[];
      autoMerged?: number;
    };

/* -------------------------------- 失败草稿 -------------------------------- */

export type DraftStage = "failed" | "conflict";

export interface PendingDraft {
  draftId: string;
  caseId: string;
  createdAt: string;
  lastAttemptAt: string;
  attempts: number;
  stage: DraftStage;
  /** 保存失败原因或冲突说明 */
  reason: string;
  request: CommitSnapshotRequest;
  /** 发生冲突时服务端返回的冲突清单，待调查员确认 */
  conflicts?: FieldConflict[];
  /** 与冲突同时被自动并入的无冲突字段/实体数量 */
  autoMerged?: number;
}
