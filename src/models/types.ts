export type RiskLevel = "high" | "medium" | "low";
export type AlertStatus = "new" | "triage" | "linked" | "dismissed";
export type CaseStatus =
  | "investigating"
  | "pending_review"
  | "supplement"
  | "closed";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type NodeKind = "account" | "device" | "ip" | "merchant";
export type EdgeKind = "transfer" | "shared_device" | "shared_ip" | "payee";
export type CaseDisposition = "freeze" | "release" | "observe";
export type ConclusionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "returned"
  | "invalidated";

export interface Alert {
  id: string;
  title: string;
  account: string;
  counterparty: string;
  channel: string;
  amount: number;
  riskLevel: RiskLevel;
  score: number;
  status: AlertStatus;
  detectedAt: string;
  tags: string[];
  deviceId: string;
  ip: string;
  caseId?: string;
}

export interface GraphNodeData {
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
}

export interface InvestigationNode {
  id: string;
  caseId: string;
  position: { x: number; y: number };
  data: GraphNodeData;
}

export interface InvestigationEdge {
  id: string;
  caseId: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  version: number;
}

export interface ConclusionVersion {
  id: string;
  caseId: string;
  version: number;
  status: ConclusionStatus;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  createdBy: string;
  createdAt: string;
  reviewer: string;
  reviewerNote?: string;
  /** 创建结论时台账证据的指纹集合，用于证据变化后失效判定 */
  evidenceSignature?: string[];
  /** 失效原因明细：新增、移除或强度发生变化的证据 */
  invalidatedBy?: EvidenceChange[];
  invalidatedAt?: string;
  invalidatedRevision?: number;
}

export interface InvestigationCase {
  id: string;
  title: string;
  status: CaseStatus;
  riskLevel: RiskLevel;
  owner: string;
  openedAt: string;
  updatedAt: string;
  summary: string;
  alertIds: string[];
  nextReviewAt: string;
  /** 乐观并发版本号，每次写入同一份快照时递增 */
  revision: number;
}

export interface AuditLog {
  id: string;
  caseId?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface AlertFilters {
  keyword: string;
  riskLevel: RiskLevel | "all";
  status: AlertStatus | "all";
  channel: string;
}

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  totalExposure: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}

/* ---------- 统一快照、版本摘要、结论失效与冲突合并 ---------- */

export type CaseEditableField =
  | "title"
  | "summary"
  | "owner"
  | "riskLevel"
  | "nextReviewAt";

export const CASE_EDITABLE_FIELDS: CaseEditableField[] = [
  "title",
  "summary",
  "owner",
  "riskLevel",
  "nextReviewAt",
];

/** 案件在某一时刻的完整可恢复快照内容 */
export interface CaseBundle {
  case: InvestigationCase;
  alertIds: string[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
}

/** 台账证据相对结论锚定时点的变化 */
export interface EvidenceChange {
  kind: "added" | "removed" | "strength";
  evidenceId: string;
  title: string;
  before?: EvidenceStrength;
  after?: EvidenceStrength;
}

/** 保存快照时随版本附带的摘要 */
export interface SnapshotSummary {
  note: string;
  added: {
    nodes: number;
    edges: number;
    evidence: number;
    alerts: number;
    conclusions: number;
  };
  removed: {
    nodes: number;
    edges: number;
    evidence: number;
    alerts: number;
  };
  strengthChanged: number;
  invalidatedConclusions: string[];
}

export interface CaseSnapshot {
  id: string;
  caseId: string;
  revision: number;
  savedAt: string;
  savedBy: string;
  source: string;
  summary: SnapshotSummary;
  bundle: CaseBundle;
}

/** 字段级或集合项级冲突 */
export interface WorkspaceConflict {
  scope: "case" | "nodes" | "edges" | "evidence";
  id?: string;
  field: string;
  label: string;
  kind: "field" | "added-removed" | "removed-added" | "removed-modified";
  baseValue?: unknown;
  serverValue?: unknown;
  localValue?: unknown;
  /** 调查员的选择，未选择前为 undefined */
  resolution?: "local" | "server";
}

/** 随保存请求一并新建的结论版本 */
export interface PendingConclusion {
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  submit: boolean;
}

export interface SaveWorkspaceInput {
  caseId: string;
  baseRevision: number;
  bundle: CaseBundle;
  summaryNote: string;
  actor: string;
  conclusion?: PendingConclusion;
  resolve?: WorkspaceConflict[];
  simulateFailure?: boolean;
}

/** 保存失败或存在未决冲突时留存的草稿（outbox） */
export interface PendingDraft {
  id: string;
  caseId: string;
  caseTitle: string;
  savedAt: string;
  reason: "save_failure" | "conflict";
  baseRevision: number;
  bundle: CaseBundle;
  summaryNote: string;
  actor: string;
  conclusion?: PendingConclusion;
  conflicts: WorkspaceConflict[];
  lastError?: string;
  attempts: number;
}

export interface WorkspaceSaveResult {
  bundle: CaseBundle;
  snapshot: CaseSnapshot;
  merged: WorkspaceConflict[];
  conflicts: WorkspaceConflict[];
}

export interface CaseWorkspace {
  case: InvestigationCase;
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
}
