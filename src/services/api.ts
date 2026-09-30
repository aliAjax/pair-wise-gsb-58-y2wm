import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AuditLog,
  CaseDisposition,
  CaseSnapshot,
  CaseStatus,
  ConclusionVersion,
  DashboardSummary,
  Evidence,
  InvestigationCase,
  InvestigationNode,
  PendingDraft,
  RiskLevel,
  SaveWorkspaceInput,
  WorkspaceConflict,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "./mockStorage";
import {
  advanceSnapshot,
  commitWorkspace,
  restoreSnapshot,
  type ConflictError,
} from "./snapshotService";
import { listPendingDrafts, removePendingDraft } from "./pendingDrafts";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

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
    "Snapshots",
    "Drafts",
  ],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        const activeCases = database.cases.filter(
          (item) => item.status !== "closed",
        );
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

        database.cases.forEach((item) => {
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
            pendingReview: database.cases.filter((item) =>
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
        await wait();
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
        await wait();
        return { data: readDatabase().cases };
      },
      providesTags: ["Cases"],
    }),
    getCaseWorkspace: builder.query<
      {
        case: InvestigationCase;
        nodes: InvestigationNode[];
        edges: ReturnType<typeof readDatabase>["edges"];
        evidence: Evidence[];
        conclusions: ConclusionVersion[];
        snapshots: CaseSnapshot[];
        pendingDraft?: PendingDraft;
      },
      string
    >({
      queryFn: async (caseId) => {
        await wait();
        const database = readDatabase();
        const investigationCase = database.cases.find(
          (item) => item.id === caseId,
        );
        if (!investigationCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        return {
          data: {
            case: investigationCase,
            nodes: database.nodes.filter((item) => item.caseId === caseId),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: database.evidence.filter(
              (item) => item.caseId === caseId,
            ),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version),
            snapshots: database.snapshots
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.revision - a.revision),
            pendingDraft: listPendingDrafts().find(
              (item) => item.caseId === caseId,
            ),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        { type: "Snapshots", id: caseId },
        { type: "Drafts", id: caseId },
        "Dashboard",
      ],
    }),
    getPendingDrafts: builder.query<PendingDraft[], void>({
      queryFn: async () => {
        await wait(120);
        return { data: listPendingDrafts() };
      },
      providesTags: ["Drafts"],
    }),
    getCaseSnapshots: builder.query<CaseSnapshot[], string>({
      queryFn: async (caseId) => {
        await wait(120);
        const snapshots = readDatabase()
          .snapshots.filter((item) => item.caseId === caseId)
          .sort((a, b) => b.revision - a.revision);
        return { data: snapshots };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Snapshots", id: caseId },
      ],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit"],
    }),
    linkAlertsToCase: builder.mutation<
      Alert[],
      { alertIds: string[]; caseId: string }
    >({
      queryFn: async ({ alertIds, caseId }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const updated = database.alerts.map((item) =>
          alertIds.includes(item.id)
            ? { ...item, caseId, status: "linked" as const }
            : item,
        );
        database.alerts = updated;
        targetCase.alertIds = Array.from(
          new Set([...targetCase.alertIds, ...alertIds]),
        );
        writeDatabase(database);
        advanceSnapshot(database, caseId, {
          actor: "林澜",
          source: "批量关联告警",
          note: `关联告警 ${alertIds.join("、")}`,
        });
        writeDatabase(database);
        const selected = database.alerts.filter((item) =>
          alertIds.includes(item.id),
        );
        return { data: selected };
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard", "Snapshots"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: Alert["status"] }
    >({
      queryFn: async ({ alertId, status }) => {
        await wait();
        const database = readDatabase();
        const alert = database.alerts.find((item) => item.id === alertId);
        if (!alert) {
          return { error: { status: "CUSTOM_ERROR", error: "告警不存在" } };
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: "林澜",
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        writeDatabase(database);
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard"],
    }),
    addGraphNode: builder.mutation<
      InvestigationNode,
      AddNodeInput
    >({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        database.nodes.push(node);
        if (relation) {
          database.edges.push({
            id: createId("E"),
            caseId,
            source: relation.sourceId,
            target: node.id,
            kind: relation.kind,
            label: relation.label,
            amount: relation.amount,
            occurredAt: node.data.occurredAt,
            explanation: relation.explanation,
          });
        }
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        writeDatabase(database);
        advanceSnapshot(database, caseId, {
          actor: "林澜",
          source: "加入图谱节点",
          note: `${node.data.label} 加入，证据强度 ${node.data.evidenceStrength}${relation ? `，并登记关系“${relation.label}”` : ""}`,
        });
        writeDatabase(database);
        return { data: node };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    updateGraphNode: builder.mutation<
      InvestigationNode,
      { caseId: string; node: InvestigationNode }
    >({
      queryFn: async ({ caseId, node }) => {
        await wait(80);
        const database = readDatabase();
        const index = database.nodes.findIndex((item) => item.id === node.id);
        if (index < 0) {
          return { error: { status: "CUSTOM_ERROR", error: "节点不存在" } };
        }
        database.nodes[index] = { ...database.nodes[index], ...node };
        writeDatabase(database);
        return { data: database.nodes[index] };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
      ],
    }),
    addEvidence: builder.mutation<
      Evidence,
      Omit<Evidence, "id" | "submittedAt" | "submittedBy" | "version">
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const evidence: Evidence = {
          ...input,
          id: createId("EV"),
          submittedAt: nowIso(),
          submittedBy: "林澜",
          version: 1,
        };
        database.evidence.unshift(evidence);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        writeDatabase(database);
        advanceSnapshot(database, input.caseId, {
          actor: "林澜",
          source: "新增证据",
          note: `${input.title} 已登记，来源为 ${input.source}，证据强度 ${input.strength}`,
        });
        writeDatabase(database);
        return { data: evidence };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    saveConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        disposition: CaseDisposition;
        rationale: string;
        riskControls: string[];
        submit?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === input.caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const existing = database.conclusions.filter(
          (item) => item.caseId === input.caseId,
        );
        const caseEvidence = database.evidence.filter(
          (item) => item.caseId === input.caseId,
        );
        const conclusion: ConclusionVersion = {
          id: createId("CV"),
          caseId: input.caseId,
          version:
            existing.reduce((max, item) => Math.max(max, item.version), 0) + 1,
          status: input.submit ? "submitted" : "draft",
          disposition: input.disposition,
          rationale: input.rationale,
          riskControls: input.riskControls,
          createdBy: "林澜",
          createdAt: nowIso(),
          reviewer: "赵平",
          evidenceSignature: caseEvidence.map(
            (item) => `${item.id}|${item.title}|${item.source}|${item.strength}|${item.occurredAt}|${item.attachment}`,
          ).sort((a, b) => a.localeCompare(b)),
        };
        database.conclusions.unshift(conclusion);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.status = input.submit ? "pending_review" : "investigating";
        }
        writeDatabase(database);
        advanceSnapshot(database, input.caseId, {
          actor: "林澜",
          source: "保存结论版本",
          note: `${conclusion.id} V${conclusion.version} 已${input.submit ? "提交复核" : "保存为草稿"}`,
        });
        writeDatabase(database);
        const saved = database.conclusions.find(
          (item) => item.id === conclusion.id,
        );
        return { data: saved ?? conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    transitionCase: builder.mutation<
      InvestigationCase,
      { caseId: string; status: CaseStatus; reason?: string }
    >({
      queryFn: async ({ caseId, status, reason }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) =>
              item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
        }
        targetCase.status = status;
        writeDatabase(database);
        advanceSnapshot(database, caseId, {
          actor: "林澜",
          source: "案件状态流转",
          note: `状态更新为 ${status}${reason ? `，原因：${reason}` : ""}`,
        });
        writeDatabase(database);
        return { data: targetCase };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    reviewConclusion: builder.mutation<
      ConclusionVersion,
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
        const conclusion = database.conclusions.find(
          (item) => item.id === conclusionId,
        );
        if (!conclusion) {
          return { error: { status: "CUSTOM_ERROR", error: "结论不存在" } };
        }
        if (
          conclusion.status !== "submitted" &&
          conclusion.status !== "draft"
        ) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error:
                conclusion.status === "invalidated"
                  ? "该版本已因证据变化失效，请基于最新证据重算后再提交复核。"
                  : "当前版本不能再次复核。",
            },
          };
        }
        conclusion.status = decision === "approve" ? "approved" : "returned";
        conclusion.reviewerNote = reviewerNote;
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.status =
            decision === "approve" ? "closed" : "supplement";
        }
        writeDatabase(database);
        advanceSnapshot(database, caseId, {
          actor: "赵平",
          source: decision === "approve" ? "复核通过" : "退回补证",
          note: `${conclusion.id} 已${decision === "approve" ? "通过" : "退回"}：${reviewerNote}`,
        });
        writeDatabase(database);
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    saveWorkspace: builder.mutation<
      {
        bundle: SaveWorkspaceInput["bundle"];
        snapshot: CaseSnapshot;
        autoMerged: WorkspaceConflict[];
      },
      SaveWorkspaceInput
    >({
      queryFn: async (input) => {
        await wait(420);
        if (input.simulateFailure) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "保存失败（模拟网络中断）：草稿已保留，将在下次打开时重试。",
            },
          };
        }
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === input.caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const result = commitWorkspace(database, input);
        if ((result as ConflictError).status === "CONFLICT") {
          const conflict = result as ConflictError;
          return {
            error: {
              status: "CONFLICT",
              error: "检测到另一个窗口的并发修改，存在字段冲突。",
              data: conflict,
            },
          };
        }
        writeDatabase(database);
        const success = result as {
          bundle: SaveWorkspaceInput["bundle"];
          snapshot: CaseSnapshot;
          autoMerged: WorkspaceConflict[];
        };
        return { data: success };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        { type: "Drafts", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Alerts",
      ],
    }),
    restoreCaseSnapshot: builder.mutation<
      { bundle: SaveWorkspaceInput["bundle"]; snapshot: CaseSnapshot },
      { caseId: string; snapshotId: string }
    >({
      queryFn: async ({ caseId, snapshotId }) => {
        await wait(360);
        const database = readDatabase();
        try {
          const result = restoreSnapshot(database, caseId, snapshotId, "林澜");
          writeDatabase(database);
          return {
            data: { bundle: result.bundle, snapshot: result.snapshot },
          };
        } catch (caught) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: caught instanceof Error ? caught.message : "恢复失败",
            },
          };
        }
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshots", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
        "Alerts",
      ],
    }),
    discardPendingDraft: builder.mutation<{ ok: boolean }, string>({
      queryFn: async (caseId) => {
        await wait(120);
        removePendingDraft(caseId);
        return { data: { ok: true } };
      },
      invalidatesTags: (_result, _error, caseId) => [
        { type: "Drafts", id: caseId },
        { type: "Case", id: caseId },
      ],
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(180);
        resetDatabase();
        if (typeof window !== "undefined") {
          Object.keys(window.localStorage)
            .filter((key) => key.includes("pending-drafts"))
            .forEach((key) => window.localStorage.removeItem(key));
        }
        return { data: { ok: true } };
      },
      invalidatesTags: [
        "Alerts",
        "Cases",
        "Case",
        "Audit",
        "Dashboard",
        "Snapshots",
        "Drafts",
      ],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useDiscardPendingDraftMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseSnapshotsQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetPendingDraftsQuery,
  useLinkAlertsToCaseMutation,
  useResetMockDataMutation,
  useRestoreCaseSnapshotMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSaveWorkspaceMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
} = bankApi;

export type { RiskLevel };
