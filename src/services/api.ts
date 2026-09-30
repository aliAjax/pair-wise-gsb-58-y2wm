import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AlertStatus,
  AuditLog,
  CaseStatus,
  ConclusionVersion,
  DashboardSummary,
  Evidence,
  InvestigationCase,
  InvestigationNode,
  RiskLevel,
  SnapshotSaveKind,
} from "../models/types";
import type {
  CaseSnapshot,
  CommitSnapshotRequest,
  CommitSnapshotSuccess,
  FieldConflict,
  PendingDraft,
  SnapshotHistoryEntry,
} from "../models/snapshot";
import {
  appendAudit,
  createId,
  getSimulateFailure,
  nowIso,
  readDatabase,
  readPendingDrafts,
  removePendingDraft,
  resetDatabase,
  setSimulateFailure,
  upsertPendingDraft,
  writeDatabase,
  type MockDatabase,
} from "./mockStorage";
import {
  commitSnapshot,
  fingerprintEvidence,
  SimulatedSaveError,
  syncGlobalAlerts,
} from "./snapshotEngine";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const ACTOR = "林澜";

const kindLabels: Record<SnapshotSaveKind, string> = {
  graph: "关系图谱",
  evidence: "证据台账",
  conclusion: "结论版本",
  alerts: "告警关联",
  case: "案件信息",
  review: "复核",
  restore: "快照恢复",
};

export const summarizeKinds = (kinds: SnapshotSaveKind[]): string =>
  kinds.map((kind) => kindLabels[kind]).join("、");

const buildCommitLabel = (
  kinds: SnapshotSaveKind[],
  description: string,
): string => `${summarizeKinds(kinds)}：${description}`;

const buildCommitAudit = (
  database: MockDatabase,
  request: CommitSnapshotRequest,
  result: CommitSnapshotSuccess,
): void => {
  const { stats } = result.summary;
  const parts: string[] = [`快照 V${result.revision}`];
  if (stats.nodesAdded) parts.push(`新增节点 ${stats.nodesAdded}`);
  if (stats.edgesAdded) parts.push(`新增关系 ${stats.edgesAdded}`);
  if (stats.evidenceAdded) parts.push(`新增证据 ${stats.evidenceAdded}`);
  if (stats.evidenceChanged) parts.push(`调整证据强度 ${stats.evidenceChanged}`);
  if (stats.evidenceRemoved) parts.push(`移除证据 ${stats.evidenceRemoved}`);
  if (stats.conclusionsAdded)
    parts.push(`新增结论版本 ${stats.conclusionsAdded}`);
  if (stats.alertsLinked) parts.push(`关联告警 ${stats.alertsLinked}`);
  if (stats.conclusionsInvalidated)
    parts.push(`旧结论失效 ${stats.conclusionsInvalidated}`);
  if (stats.autoMerged) parts.push(`自动合入无冲突更新 ${stats.autoMerged}`);
  if (stats.conflictsResolved)
    parts.push(`调查员确认覆盖冲突 ${stats.conflictsResolved}`);
  if (request.restoreFromRevision !== undefined) {
    parts.push(`恢复自 V${request.restoreFromRevision}`);
  }
  appendAudit(database, {
    caseId: request.caseId,
    actor: request.actor,
    action: "保存案件快照",
    detail: `${buildCommitLabel(request.kinds, request.description)}（${parts.join(
      "，",
    )}）。`,
  });
};

export interface CommitError {
  status: "CUSTOM_ERROR";
  error: string;
  conflicts?: FieldConflict[];
  autoMerged?: number;
  /** 失败已保留为本地草稿，下次打开可重试 */
  draftId?: string;
  draftStage?: PendingDraft["stage"];
}

const runCommit = (
  request: CommitSnapshotRequest,
):
  | { data: CommitSnapshotSuccess }
  | { error: CommitError } => {
  const database = readDatabase();
  const existingDraft = readPendingDrafts().find(
    (item) => item.request.description === request.description,
  );

  try {
    const outcome = commitSnapshot(
      database.snapshots,
      request,
      { shouldFail: getSimulateFailure() },
    );
    if (outcome.type === "conflict") {
      // 冲突：保留草稿，等调查员逐项确认后再覆盖
      const draft: PendingDraft = {
        draftId:
          existingDraft?.draftId ?? createId("DRAFT"),
        caseId: request.caseId,
        createdAt: existingDraft?.createdAt ?? nowIso(),
        lastAttemptAt: nowIso(),
        attempts: (existingDraft?.attempts ?? 0) + 1,
        stage: "conflict",
        reason: `与另一窗口的保存存在 ${outcome.conflicts.length} 个冲突字段，等待调查员确认。`,
        // 保留原始 baseRevision，重试时引擎据此识别调查员确认保留对方的字段
        request,
        conflicts: outcome.conflicts,
        autoMerged: outcome.autoMerged,
      };
      upsertPendingDraft(draft);
      return {
        error: {
          status: "CUSTOM_ERROR",
          error: `存在 ${outcome.conflicts.length} 个冲突项，无冲突字段已自动合并，请确认冲突项后覆盖。`,
          conflicts: outcome.conflicts,
          autoMerged: outcome.autoMerged,
          draftId: draft.draftId,
          draftStage: "conflict",
        },
      };
    }

    // 同步全局告警台账并写库
    database.alerts = syncGlobalAlerts(
      database.alerts,
      outcome.success.snapshot,
    );
    buildCommitAudit(database, request, outcome.success);
    writeDatabase(database);
    if (existingDraft) {
      removePendingDraft(existingDraft.draftId);
    }
    return { data: outcome.success };
  } catch (caught) {
    if (caught instanceof SimulatedSaveError) {
      const draft: PendingDraft = {
        draftId: existingDraft?.draftId ?? createId("DRAFT"),
        caseId: request.caseId,
        createdAt: existingDraft?.createdAt ?? nowIso(),
        lastAttemptAt: nowIso(),
        attempts: (existingDraft?.attempts ?? 0) + 1,
        stage: "failed",
        reason: caught.message,
        request,
      };
      upsertPendingDraft(draft);
      return {
        error: {
          status: "CUSTOM_ERROR",
          error: caught.message,
          draftId: draft.draftId,
          draftStage: "failed",
        },
      };
    }
    return {
      error: {
        status: "CUSTOM_ERROR",
        error: caught instanceof Error ? caught.message : "保存失败。",
      },
    };
  }
};

/* ------------------------------- 草稿构造器 ------------------------------- */

let clientSeq = 0;
const clientToken = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 6)}`;

/** 客户端生成确定性 id，保存失败重试时按 id 去重，不会重复新增 */
const deterministicId = (prefix: string): string => {
  clientSeq += 1;
  return `${prefix}-LOCAL-${clientToken}-${clientSeq}`;
};

export { deterministicId, fingerprintEvidence };

export const buildCommitRequest = (
  input: Omit<CommitSnapshotRequest, "actor">,
): CommitSnapshotRequest => ({ ...input, actor: ACTOR });

export interface AddNodeInput {
  caseId: string;
  node: InvestigationNode;
  relation?: {
    sourceId: string;
    kind: "transfer" | "shared_device" | "shared_ip" | "payee";
    label: string;
    explanation: string;
    amount?: number;
  };
}

export const bankApi = createApi({
  reducerPath: "bankApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: [
    "Alerts",
    "Cases",
    "Case",
    "Audit",
    "Dashboard",
    "Drafts",
  ],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        const cases = Object.values(database.snapshots).map(
          (item) => item.snapshot.case,
        );
        const activeCases = cases.filter((item) => item.status !== "closed");
        const caseStatusCounts: DashboardSummary["caseStatusCounts"] = {
          investigating: 0,
          pending_review: 0,
          supplement: 0,
          closed: 0,
        };
        const riskCounts: DashboardSummary["riskCounts"] = {
          high: 0,
          medium: 0,
          low: 0,
        };

        cases.forEach((item) => {
          caseStatusCounts[item.status] += 1;
          riskCounts[item.riskLevel] += 1;
        });

        return {
          data: {
            newAlerts: database.alerts.filter((item) => item.status === "new")
              .length,
            highRiskAlerts: database.alerts.filter(
              (item) => item.riskLevel === "high",
            ).length,
            activeCases: activeCases.length,
            pendingReview: cases.filter((item) =>
              ["pending_review", "supplement"].includes(item.status),
            ).length,
            totalExposure: database.alerts.reduce(
              (sum, item) => sum + item.amount,
              0,
            ),
            caseStatusCounts,
            riskCounts,
          },
        };
      },
      providesTags: ["Dashboard"],
    }),
    getAlerts: builder.query<Alert[], AlertFilters>({
      queryFn: async (filters) => {
        await wait(180);
        const database = readDatabase();
        const keyword = filters.keyword.trim().toLowerCase();
        const items = database.alerts.filter((item) => {
          const matchesKeyword =
            !keyword ||
            [
              item.id,
              item.title,
              item.account,
              item.counterparty,
              item.deviceId,
              item.ip,
              ...item.tags,
            ]
              .join(" ")
              .toLowerCase()
              .includes(keyword);
          const matchesRisk =
            filters.riskLevel === "all" ||
            item.riskLevel === filters.riskLevel;
          const matchesStatus =
            filters.status === "all" || item.status === filters.status;
          const matchesChannel =
            !filters.channel || item.channel === filters.channel;
          return (
            matchesKeyword && matchesRisk && matchesStatus && matchesChannel
          );
        });
        return { data: items };
      },
      providesTags: ["Alerts"],
    }),
    getCases: builder.query<InvestigationCase[], void>({
      queryFn: async () => {
        await wait(180);
        const database = readDatabase();
        return {
          data: Object.values(database.snapshots)
            .map((item) => item.snapshot.case)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
        };
      },
      providesTags: ["Cases"],
    }),
    getCaseWorkspace: builder.query<
      {
        revision: number;
        history: SnapshotHistoryEntry[];
        case: InvestigationCase;
        nodes: CaseSnapshot["nodes"];
        edges: CaseSnapshot["edges"];
        evidence: Evidence[];
        conclusions: ConclusionVersion[];
        alerts: Alert[];
      },
      string
    >({
      queryFn: async (caseId) => {
        await wait(180);
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const { snapshot } = record;
        return {
          data: {
            revision: record.revision,
            history: record.history,
            case: snapshot.case,
            nodes: snapshot.nodes,
            edges: snapshot.edges,
            evidence: snapshot.evidence,
            conclusions: snapshot.conclusions,
            alerts: snapshot.alerts,
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Dashboard",
        "Cases",
      ],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait(180);
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit"],
    }),
    getPendingDrafts: builder.query<PendingDraft[], string | void>({
      queryFn: async (caseId) => {
        await wait(60);
        const drafts = readPendingDrafts();
        return {
          data: caseId
            ? drafts.filter((item) => item.caseId === caseId)
            : drafts,
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Drafts", id: caseId ?? "all" },
      ],
    }),
    discardDraft: builder.mutation<{ ok: true }, string>({
      queryFn: async (draftId) => {
        await wait(80);
        removePendingDraft(draftId);
        return { data: { ok: true as const } };
      },
      invalidatesTags: ["Drafts"],
    }),
    setFailureSimulation: builder.mutation<{ ok: true }, boolean>({
      queryFn: async (enabled) => {
        await wait(40);
        setSimulateFailure(enabled);
        return { data: { ok: true as const } };
      },
    }),
    linkAlertsToCase: builder.mutation<
      CommitSnapshotSuccess,
      { alertIds: string[]; caseId: string }
    >({
      queryFn: async ({ alertIds, caseId }) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const alerts = database.alerts
          .filter((item) => alertIds.includes(item.id))
          .map((item) => ({ ...item, caseId, status: "linked" as const }));
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["alerts"],
          description: `关联告警 ${alertIds.join("、")}`,
          patch: { alerts },
        });
        return runCommit(request);
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard", "Drafts"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: AlertStatus }
    >({
      queryFn: async ({ alertId, status }) => {
        await wait(120);
        const database = readDatabase();
        const alert = database.alerts.find((item) => item.id === alertId);
        if (!alert) {
          return { error: { status: "CUSTOM_ERROR", error: "告警不存在" } };
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: ACTOR,
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        writeDatabase(database);
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Dashboard"],
    }),
    addGraphNode: builder.mutation<CommitSnapshotSuccess, AddNodeInput>({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const edges = relation
          ? [
              {
                id: deterministicId("E"),
                caseId,
                source: relation.sourceId,
                target: node.id,
                kind: relation.kind,
                label: relation.label,
                amount: relation.amount,
                occurredAt: node.data.occurredAt,
                explanation: relation.explanation,
              },
            ]
          : [];
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["graph"],
          description: `加入节点 ${node.data.label}`,
          patch: { nodes: [node], edges },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    updateGraphNode: builder.mutation<
      CommitSnapshotSuccess,
      { caseId: string; node: InvestigationNode }
    >({
      queryFn: async ({ caseId, node }) => {
        await wait(60);
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["graph"],
          description: `调整节点 ${node.data.label} 布局`,
          patch: { nodes: [node] },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Drafts",
      ],
    }),
    addEvidence: builder.mutation<
      CommitSnapshotSuccess,
      Omit<Evidence, "id" | "submittedAt" | "submittedBy" | "version">
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[input.caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const evidence: Evidence = {
          ...input,
          id: deterministicId("EV"),
          submittedAt: nowIso(),
          submittedBy: ACTOR,
          version: 1,
        };
        const request = buildCommitRequest({
          caseId: input.caseId,
          baseRevision: record.revision,
          kinds: ["evidence"],
          description: `登记证据 ${input.title}`,
          patch: { evidence: [evidence] },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    changeEvidenceStrength: builder.mutation<
      CommitSnapshotSuccess,
      { caseId: string; evidenceId: string; strength: Evidence["strength"] }
    >({
      queryFn: async ({ caseId, evidenceId, strength }) => {
        await wait(120);
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const evidence = record.snapshot.evidence.find(
          (item) => item.id === evidenceId,
        );
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["evidence"],
          description: `调整证据 ${evidence?.title ?? evidenceId} 强度为 ${strength}`,
          patch: {
            writes: { evidenceStrength: { [evidenceId]: strength } },
          },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    removeEvidence: builder.mutation<
      CommitSnapshotSuccess,
      { caseId: string; evidenceId: string; evidenceTitle: string }
    >({
      queryFn: async ({ caseId, evidenceId, evidenceTitle }) => {
        await wait(120);
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["evidence"],
          description: `移除证据 ${evidenceTitle}`,
          patch: { removeEvidenceIds: [evidenceId] },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    saveConclusion: builder.mutation<
      CommitSnapshotSuccess,
      {
        caseId: string;
        disposition: ConclusionVersion["disposition"];
        rationale: string;
        riskControls: string[];
        submit?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[input.caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const request = buildCommitRequest({
          caseId: input.caseId,
          baseRevision: record.revision,
          kinds: ["conclusion"],
          description: input.submit
            ? `提交结论 V${
                record.snapshot.conclusions.reduce(
                  (max, item) => Math.max(max, item.version),
                  0,
                ) + 1
              } 复核`
            : "保存结论草稿",
          patch: {
            addConclusion: {
              disposition: input.disposition,
              rationale: input.rationale,
              riskControls: input.riskControls,
              submit: Boolean(input.submit),
            },
          },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Drafts",
      ],
    }),
    transitionCase: builder.mutation<
      CommitSnapshotSuccess,
      { caseId: string; status: CaseStatus; reason?: string }
    >({
      queryFn: async ({ caseId, status, reason }) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const latest = record.snapshot.conclusions[0];
          const hasSubmitted = record.snapshot.conclusions.some(
            (item) => item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
          if (latest?.status === "invalidated") {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "最新结论已因证据变化失效，请重算并提交新版本后再进入复核。",
              },
            };
          }
        }
        const statusLabels: Record<CaseStatus, string> = {
          investigating: "调查中",
          pending_review: "待复核",
          supplement: "待补证",
          closed: "已关闭",
        };
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["case"],
          description: `案件状态流转为${statusLabels[status]}${
            reason ? `：${reason}` : ""
          }`,
          patch: { writes: { caseStatus: status } },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    reviewConclusion: builder.mutation<
      CommitSnapshotSuccess,
      {
        caseId: string;
        conclusionId: string;
        decision: "approve" | "return";
        reviewerNote: string;
      }
    >({
      queryFn: async ({ caseId, conclusionId, decision, reviewerNote }) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["review"],
          description:
            decision === "approve"
              ? `复核通过 ${conclusionId}`
              : `退回补证 ${conclusionId}`,
          patch: {
            reviewConclusion: { conclusionId, decision, reviewerNote },
          },
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    restoreSnapshotRevision: builder.mutation<
      CommitSnapshotSuccess,
      { caseId: string; revision: number }
    >({
      queryFn: async ({ caseId, revision }) => {
        await wait();
        const database = readDatabase();
        const record = database.snapshots[caseId];
        if (!record) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const request = buildCommitRequest({
          caseId,
          baseRevision: record.revision,
          kinds: ["restore"],
          description: `恢复到快照 V${revision}`,
          patch: {},
          restoreFromRevision: revision,
        });
        return runCommit(request);
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
        "Drafts",
      ],
    }),
    retryDraftCommit: builder.mutation<
      CommitSnapshotSuccess,
      { draftId: string; resolvedPaths?: string[] }
    >({
      queryFn: async ({ draftId, resolvedPaths }) => {
        await wait(200);
        const draft = readPendingDrafts().find(
          (item) => item.draftId === draftId,
        );
        if (!draft) {
          return { error: { status: "CUSTOM_ERROR", error: "草稿不存在" } };
        }
        const database = readDatabase();
        if (!database.snapshots[draft.caseId]) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        // 重试保留草稿的原始 baseRevision，由引擎重新做三方合并；
        // 弹窗确认的冲突（保留对方/以我的覆盖）随 acknowledgedConflicts 传入。
        const conflictPaths = (draft.conflicts ?? []).map((item) => item.path);
        const request: CommitSnapshotRequest = {
          ...draft.request,
          resolvedPaths: resolvedPaths ?? draft.request.resolvedPaths,
          acknowledgedConflicts: Array.from(
            new Set([
              ...(draft.request.acknowledgedConflicts ?? []),
              ...conflictPaths,
            ]),
          ),
        };
        return runCommit(request);
      },
      invalidatesTags: ["Drafts", "Alerts", "Cases", "Audit", "Dashboard"],
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(180);
        resetDatabase();
        return { data: { ok: true } };
      },
      invalidatesTags: ["Alerts", "Cases", "Case", "Audit", "Dashboard", "Drafts"],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useChangeEvidenceStrengthMutation,
  useDiscardDraftMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetPendingDraftsQuery,
  useLinkAlertsToCaseMutation,
  useRemoveEvidenceMutation,
  useResetMockDataMutation,
  useRestoreSnapshotRevisionMutation,
  useRetryDraftCommitMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSetFailureSimulationMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
} = bankApi;

export type { RiskLevel };
