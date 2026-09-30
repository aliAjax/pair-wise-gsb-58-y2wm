import {
  Alert,
  Badge,
  Button,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  ArrowLeft,
  Check,
  FilePlus2,
  GitBranchPlus,
  Pencil,
  RotateCcw,
  Trash2,
  Unlink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../app/hooks";
import {
  CaseStatusBadge,
  ConclusionStatusBadge,
  EvidenceStrengthBadge,
  RiskBadge,
} from "../components/Badges";
import {
  focusEvidence,
  focusTimeline,
  selectNode,
} from "../features/alerts/alertsSlice";
import { InvestigationGraph } from "../features/graph/InvestigationGraph";
import {
  TransactionTimeline,
  type TimelineEvent,
} from "../features/timeline/TransactionTimeline";
import { ConflictModal, EvidenceChangeList, SaveBar, SnapshotHistoryPanel, computePendingChanges } from "../features/workspace/WorkspacePanels";
import { SaveSnapshotModal } from "../features/workspace/SaveSnapshotModal";
import type {
  CaseBundle,
  CaseDisposition,
  ConclusionVersion,
  Evidence,
  EvidenceStrength,
  InvestigationEdge,
  InvestigationNode,
  NodeKind,
  PendingConclusion,
  PendingDraft,
  RiskLevel,
  WorkspaceConflict,
} from "../models/types";
import {
  useDiscardPendingDraftMutation,
  useGetAlertsQuery,
  useGetCaseWorkspaceQuery,
  useRestoreCaseSnapshotMutation,
  useReviewConclusionMutation,
  useSaveWorkspaceMutation,
  useTransitionCaseMutation,
} from "../services/api";
import { createId, nowIso } from "../services/mockStorage";
import {
  bumpDraftAttempt,
  getPendingDraft,
  removePendingDraft,
  savePendingDraft,
} from "../services/pendingDrafts";
import { displayValue } from "../services/snapshotCore";

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请检查输入后重试。";
};

const isConflictError = (
  error: unknown,
): error is { status: string; data: { conflicts: WorkspaceConflict[]; autoMerged: WorkspaceConflict[] } } =>
  typeof error === "object" &&
  error !== null &&
  (error as { status?: unknown }).status === "CONFLICT";

const buildBundle = (
  data: NonNullable<ReturnType<typeof useGetCaseWorkspaceQuery>["data"]>,
): CaseBundle => ({
  case: structuredClone(data.case),
  alertIds: structuredClone(data.case.alertIds),
  nodes: structuredClone(data.nodes),
  edges: structuredClone(data.edges),
  evidence: structuredClone(data.evidence),
  conclusions: structuredClone(data.conclusions),
});

const defaultSaveNote = (): string => {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  return `调查员补录（${time}）`;
};

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const selectedNodeId = useAppSelector(
    (state) => state.alertsUi.selectedNodeId,
  );
  const focusedTimelineId = useAppSelector(
    (state) => state.alertsUi.focusedTimelineId,
  );
  const focusedEvidenceId = useAppSelector(
    (state) => state.alertsUi.focusedEvidenceId,
  );
  const { data, isLoading, error } = useGetCaseWorkspaceQuery(caseId);
  const { data: allAlerts = [] } = useGetAlertsQuery({
    keyword: "",
    riskLevel: "all",
    status: "all",
    channel: "",
  });
  const [saveWorkspace, { isLoading: isSaving }] =
    useSaveWorkspaceMutation();
  const [transitionCase, { isLoading: isTransitioning }] =
    useTransitionCaseMutation();
  const [reviewConclusion, { isLoading: isReviewing }] =
    useReviewConclusionMutation();
  const [restoreCase, { isLoading: isRestoring }] =
    useRestoreCaseSnapshotMutation();
  const [discardDraftMutation] = useDiscardPendingDraftMutation();

  const [nodeOpened, nodeModal] = useDisclosure(false);
  const [evidenceOpened, evidenceModal] = useDisclosure(false);
  const [saveOpened, saveModal] = useDisclosure(false);
  const [caseEditOpened, caseEditModal] = useDisclosure(false);
  const [reviewNote, setReviewNote] = useState("");

  // 服务端基准与本地编辑器
  const [serverBundle, setServerBundle] = useState<CaseBundle | null>(null);
  const [editor, setEditor] = useState<CaseBundle | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [draft, setDraft] = useState<PendingDraft | undefined>(undefined);
  const [conflicts, setConflicts] = useState<WorkspaceConflict[]>([]);
  const [autoMerged, setAutoMerged] = useState<WorkspaceConflict[]>([]);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<{
    note: string;
    conclusion?: PendingConclusion;
    simulateFailure: boolean;
  } | null>(null);
  const autoRetriedRef = useRef<string | null>(null);

  // 初次载入：优先恢复未完成草稿
  useEffect(() => {
    if (!data) {
      return;
    }
    const fresh = buildBundle(data);
    setServerBundle(fresh);
    const storedDraft = getPendingDraft(caseId);
    if (storedDraft) {
      setDraft(storedDraft);
      setEditor(structuredClone(storedDraft.bundle));
      setBaseRevision(storedDraft.baseRevision);
      setConflicts(storedDraft.conflicts.map((item) => ({ ...item })));
      setAutoMerged([]);
    } else {
      setDraft(undefined);
      setEditor(fresh);
      setBaseRevision(fresh.case.revision);
      setConflicts([]);
      setAutoMerged([]);
    }
  }, [data, caseId]);

  // 自动重试失败草稿（无冲突的保存失败）
  useEffect(() => {
    if (
      !draft ||
      draft.reason !== "save_failure" ||
      draft.conflicts.length > 0 ||
      !editor ||
      autoRetriedRef.current === draft.id
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      autoRetriedRef.current = draft.id;
      notifications.show({
        color: "blue",
        title: "正在自动重试上次失败的保存",
        message: "草稿在本地保留期间未丢失，正在重新提交…",
      });
      void performSave({
        note: draft.summaryNote,
        conclusion: draft.conclusion,
        simulateFailure: false,
      }, true);
    }, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editor]);

  const [nodeForm, setNodeForm] = useState({
    sourceId: "",
    kind: "account" as NodeKind,
    label: "",
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "2026-09-30T09:00",
    note: "",
    relationLabel: "",
    relationExplanation: "",
    amount: 0,
  });
  const [evidenceForm, setEvidenceForm] = useState({
    title: "",
    source: "",
    strength: "medium" as EvidenceStrength,
    occurredAt: "2026-09-30T09:00",
    attachment: "",
    note: "",
  });
  const [caseForm, setCaseForm] = useState({
    title: "",
    summary: "",
    owner: "",
    riskLevel: "medium" as RiskLevel,
    nextReviewAt: "",
  });

  if (isLoading || !editor || !serverBundle) {
    return <Text>正在加载案件工作区...</Text>;
  }

  if (error) {
    return (
      <Alert color="red" title="案件加载失败">
        {errorMessage(error)}
      </Alert>
    );
  }

  const dirty = JSON.stringify(editor) !== JSON.stringify(serverBundle);
  const caseAlerts = allAlerts.filter((item) =>
    editor.alertIds.includes(item.id),
  );
  const selectedNode = editor.nodes.find((item) => item.id === selectedNodeId);
  const latestConclusion = editor.conclusions[0];
  const pendingChanges = computePendingChanges(
    serverBundle,
    editor,
    Boolean(pendingPayload?.conclusion) || draft?.conclusion !== undefined,
  );

  const mutateEditor = (updater: (current: CaseBundle) => CaseBundle) => {
    setEditor((current) => (current ? updater(structuredClone(current)) : current));
  };

  const handleTimelineFocus = (event?: TimelineEvent) => {
    dispatch(focusTimeline(event?.id));
    dispatch(focusEvidence(event?.source === "evidence" ? event.id : undefined));
    if (event?.source === "transaction") {
      const edge = editor.edges.find((item) => item.id === event.id);
      if (edge) {
        dispatch(selectNode(edge.target));
      }
    }
  };

  /* ---------- 本地编辑动作（进入统一编辑器，保存时一起提交） ---------- */

  const handleAddNode = () => {
    if (!nodeForm.sourceId || !nodeForm.label.trim() || !nodeForm.source.trim()) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "关系源节点、节点名称和证据来源均为必填项。",
      });
      return;
    }
    const nodeId = createId("NODE");
    const node: InvestigationNode = {
      id: nodeId,
      caseId,
      position: { x: 420, y: 240 },
      data: {
        label: nodeForm.label.trim(),
        kind: nodeForm.kind,
        riskLevel: nodeForm.riskLevel,
        note: nodeForm.note.trim() || "待补充关系说明。",
        evidenceStrength: nodeForm.evidenceStrength,
        source: nodeForm.source.trim(),
        occurredAt: new Date(nodeForm.occurredAt).toISOString(),
      },
    };
    const edge: InvestigationEdge = {
      id: createId("E"),
      caseId,
      source: nodeForm.sourceId,
      target: nodeId,
      kind: "transfer",
      label: nodeForm.relationLabel.trim() || "已登记关系",
      amount: nodeForm.amount || undefined,
      occurredAt: node.data.occurredAt,
      explanation:
        nodeForm.relationExplanation.trim() ||
        "关系来自调查员登记，需结合来源材料复核。",
    };
    mutateEditor((current) => ({
      ...current,
      nodes: [...current.nodes, node],
      edges: [...current.edges, edge],
    }));
    notifications.show({
      color: "blue",
      title: "已加入待保存改动",
      message: "节点与关系将在点击“保存快照”时与其他模块一并提交。",
    });
    nodeModal.close();
    setNodeForm((current) => ({ ...current, label: "", source: "", note: "" }));
  };

  const handleRemoveNode = (nodeId: string) => {
    mutateEditor((current) => ({
      ...current,
      nodes: current.nodes.filter((item) => item.id !== nodeId),
      edges: current.edges.filter(
        (item) => item.source !== nodeId && item.target !== nodeId,
      ),
    }));
    dispatch(selectNode(undefined));
  };

  const handleNodePositionChange = (
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    mutateEditor((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === nodeId ? { ...item, position } : item,
      ),
    }));
  };

  const handleAddEvidence = () => {
    if (
      !evidenceForm.title.trim() ||
      !evidenceForm.source.trim() ||
      !evidenceForm.attachment.trim()
    ) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "证据名称、来源和附件标识均为必填项。",
      });
      return;
    }
    const evidence: Evidence = {
      id: createId("EV"),
      caseId,
      title: evidenceForm.title.trim(),
      source: evidenceForm.source.trim(),
      strength: evidenceForm.strength,
      occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
      submittedAt: nowIso(),
      submittedBy: "林澜",
      attachment: evidenceForm.attachment.trim(),
      note: evidenceForm.note.trim() || "未补充说明。",
      version: 1,
    };
    mutateEditor((current) => ({
      ...current,
      evidence: [evidence, ...current.evidence],
    }));
    notifications.show({
      color: "blue",
      title: "证据已进入待保存台账",
      message: "保存后旧结论将按新增、移除与强度差异自动失效重算。",
    });
    evidenceModal.close();
    setEvidenceForm({
      title: "",
      source: "",
      strength: "medium",
      occurredAt: "2026-09-30T09:00",
      attachment: "",
      note: "",
    });
  };

  const handleEvidenceStrength = (
    evidenceId: string,
    strength: EvidenceStrength,
  ) => {
    mutateEditor((current) => ({
      ...current,
      evidence: current.evidence.map((item) =>
        item.id === evidenceId ? { ...item, strength } : item,
      ),
    }));
  };

  const handleRemoveEvidence = (evidenceId: string) => {
    mutateEditor((current) => ({
      ...current,
      evidence: current.evidence.filter((item) => item.id !== evidenceId),
    }));
  };

  const handleUnlinkAlert = (alertId: string) => {
    mutateEditor((current) => ({
      ...current,
      alertIds: current.alertIds.filter((id) => id !== alertId),
      case: {
        ...current.case,
        alertIds: current.alertIds.filter((id) => id !== alertId),
      },
    }));
  };

  const openCaseEdit = () => {
    setCaseForm({
      title: editor.case.title,
      summary: editor.case.summary,
      owner: editor.case.owner,
      riskLevel: editor.case.riskLevel,
      nextReviewAt: editor.case.nextReviewAt.slice(0, 16),
    });
    caseEditModal.open();
  };

  const handleSaveCaseFields = () => {
    mutateEditor((current) => ({
      ...current,
      case: {
        ...current.case,
        title: caseForm.title.trim() || current.case.title,
        summary: caseForm.summary.trim(),
        owner: caseForm.owner.trim() || current.case.owner,
        riskLevel: caseForm.riskLevel,
        nextReviewAt: new Date(caseForm.nextReviewAt).toISOString(),
      },
    }));
    caseEditModal.close();
  };

  /* ---------- 统一保存 ---------- */

  const persistDraft = (
    reason: PendingDraft["reason"],
    payload: { note: string; conclusion?: PendingConclusion },
    conflictItems: WorkspaceConflict[],
    lastError?: string,
  ) => {
    const record = savePendingDraft({
      caseId,
      caseTitle: editor.case.title,
      reason,
      baseRevision,
      bundle: structuredClone(editor),
      summaryNote: payload.note,
      actor: "林澜",
      conclusion: payload.conclusion,
      conflicts: conflictItems,
      lastError,
    });
    setDraft(record);
    return record;
  };

  const performSave = async (
    payload: {
      note: string;
      conclusion?: PendingConclusion;
      simulateFailure: boolean;
    },
    fromDraft = false,
  ) => {
    setPendingPayload(payload);
    try {
      const result = await saveWorkspace({
        caseId,
        baseRevision,
        bundle: structuredClone(editor),
        summaryNote: payload.note,
        actor: "林澜",
        conclusion: payload.conclusion,
        resolve: fromDraft && conflicts.length > 0 ? conflicts : undefined,
        simulateFailure: payload.simulateFailure,
      }).unwrap();

      // 保存成功：清理本地草稿
      removePendingDraft(caseId);
      setDraft(undefined);
      setConflicts([]);
      setAutoMerged(result.autoMerged);
      const mergedBundle = structuredClone(result.bundle);
      setServerBundle(mergedBundle);
      setEditor(mergedBundle);
      setBaseRevision(result.snapshot.revision);
      setPendingPayload(null);
      saveModal.close();
      setConflictOpen(false);

      notifications.show({
        color: "teal",
        title: `快照 R${result.snapshot.revision} 已保存`,
        message:
          result.snapshot.summary.note +
          (result.autoMerged.length
            ? `；已自动合入对方窗口的 ${result.autoMerged.length} 项无冲突改动。`
            : ""),
      });
      const invalidCount =
        result.snapshot.summary.invalidatedConclusions.length;
      if (invalidCount > 0) {
        notifications.show({
          color: "orange",
          title: `${invalidCount} 份旧结论已失效`,
          message: "证据台账发生新增、移除或强度差异，请基于最新证据重算结论。",
        });
      }
    } catch (mutationError) {
      if (isConflictError(mutationError)) {
        const conflictData = mutationError.data;
        setConflicts(conflictData.conflicts.map((item) => ({ ...item })));
        setAutoMerged(conflictData.autoMerged);
        const record = persistDraft(
          "conflict",
          payload,
          conflictData.conflicts,
          "存在并发字段冲突",
        );
        bumpDraftAttempt(caseId);
        setDraft(record);
        setConflictOpen(true);
        notifications.show({
          color: "orange",
          title: "检测到并发冲突",
          message: `无冲突改动已自动合并，${conflictData.conflicts.length} 项冲突请逐项确认后覆盖。`,
        });
        return;
      }

      // 其他保存失败：保留草稿，下次打开重试
      const record = persistDraft(
        "save_failure",
        payload,
        [],
        errorMessage(mutationError),
      );
      bumpDraftAttempt(caseId);
      setDraft(record);
      notifications.show({
        color: "red",
        title: "保存失败，草稿已保留",
        message:
          errorMessage(mutationError) + " 下次打开案件时会自动重试，也可立即重试。",
      });
    }
  };

  const handleConflictResolutionChange = (
    index: number,
    resolution: "local" | "server",
  ) => {
    setConflicts((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, resolution } : item,
      ),
    );
  };

  const handleConfirmOverwrite = async () => {
    // 无论从保存流程还是草稿恢复进入，都先持久化已选项，再用冲突解决结果提交
    if (draft) {
      savePendingDraft({ ...draft, conflicts });
    }
    const payload = pendingPayload ?? {
      note: draft?.summaryNote ?? defaultSaveNote(),
      conclusion: draft?.conclusion,
      simulateFailure: false,
    };
    await performSave(payload, true);
  };

  const handleRetryDraft = async () => {
    if (!draft) {
      return;
    }
    bumpDraftAttempt(caseId);
    await performSave(
      {
        note: draft.summaryNote,
        conclusion: draft.conclusion,
        simulateFailure: false,
      },
      true,
    );
  };

  const handleDiscardDraft = async () => {
    removePendingDraft(caseId);
    setDraft(undefined);
    setConflicts([]);
    setPendingPayload(null);
    setConflictOpen(false);
    setEditor(structuredClone(serverBundle));
    setBaseRevision(serverBundle.case.revision);
    await discardDraftMutation(caseId);
    notifications.show({ color: "gray", title: "草稿已丢弃", message: "未保存的本地草稿已清除。" });
  };

  const handleDiscardChanges = () => {
    setEditor(structuredClone(serverBundle));
    notifications.show({ color: "gray", title: "本地改动已放弃", message: "编辑器已恢复到最新快照内容。" });
  };

  /* ---------- 其他 ---------- */

  const handleTransition = async (status: typeof editor.case.status) => {
    if (dirty) {
      notifications.show({
        color: "orange",
        title: "请先保存快照",
        message: "工作区有未保存改动，状态流转会写入新的快照版本，请先保存。",
      });
      return;
    }
    try {
      await transitionCase({ caseId, status }).unwrap();
      notifications.show({
        color: "teal",
        title: "状态已更新",
        message: "状态流转已写入新的统一快照。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "状态流转失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleReview = async (decision: "approve" | "return") => {
    if (!latestConclusion) {
      return;
    }
    if (latestConclusion.status === "invalidated") {
      return;
    }
    if (reviewNote.trim().length < 6) {
      notifications.show({
        color: "red",
        title: "复核意见不足",
        message: "复核意见至少需要 6 个字符。",
      });
      return;
    }
    try {
      await reviewConclusion({
        caseId,
        conclusionId: latestConclusion.id,
        decision,
        reviewerNote: reviewNote.trim(),
      }).unwrap();
      notifications.show({
        color: decision === "approve" ? "teal" : "orange",
        title: decision === "approve" ? "复核通过" : "已退回补证",
        message: "复核动作和意见已写入快照与审计日志。",
      });
      setReviewNote("");
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "复核失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleRestore = async (snapshotId: string, revision: number) => {
    if (!window.confirm(`确认把案件数据面恢复到 R${revision}？恢复本身会生成一条新快照。`)) {
      return;
    }
    try {
      const result = await restoreCase({ caseId, snapshotId }).unwrap();
      const bundle = structuredClone(result.bundle);
      setServerBundle(bundle);
      setEditor(bundle);
      setBaseRevision(result.snapshot.revision);
      removePendingDraft(caseId);
      setDraft(undefined);
      notifications.show({
        color: "teal",
        title: `已恢复到 R${revision}`,
        message: "结论历史保留；证据差异导致失效的版本已在下方标出。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "恢复失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const snapshots = data?.snapshots ?? [];

  const renderConclusion = (item: ConclusionVersion, index: number) => (
    <div key={item.id}>
      {index > 0 ? <Divider /> : null}
      <Stack gap="xs" p="md">
        <Group justify="space-between">
          <Group>
            <Text fw={600}>V{item.version}</Text>
            <ConclusionStatusBadge value={item.status} />
            <Badge variant="light" color="gray">
              {dispositionLabels[item.disposition]}
            </Badge>
            {item.invalidatedRevision ? (
              <Badge variant="dot" color="red">
                快照 R{item.invalidatedRevision} 后失效
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {item.createdBy} ·{" "}
            {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}
          </Text>
        </Group>
        <Text size="sm">{item.rationale}</Text>
        <Group gap="xs">
          {item.riskControls.map((control) => (
            <Badge key={control} variant="outline" color="gray">
              {control}
            </Badge>
          ))}
        </Group>
        {item.status === "invalidated" && item.invalidatedBy ? (
          <Alert color="red" title="该结论依据的证据已变化，结论失效，请重算">
            <Stack gap="xs">
              <EvidenceChangeList changes={item.invalidatedBy} />
              <Text size="xs" c="dimmed">
                失效时间：
                {item.invalidatedAt
                  ? new Date(item.invalidatedAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })
                  : "—"}
                ；失效版本仍保留在版本链中，重启后可查。
              </Text>
            </Stack>
          </Alert>
        ) : null}
        {item.reviewerNote ? (
          <Alert
            color={item.status === "approved" ? "teal" : "orange"}
            title={`复核意见 · ${item.reviewer}`}
          >
            {item.reviewerNote}
          </Alert>
        ) : null}
      </Stack>
    </div>
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Group align="flex-start">
          <Button
            variant="subtle"
            px={6}
            leftSection={<ArrowLeft size={16} />}
            onClick={() => navigate("/cases")}
          >
            返回案件
          </Button>
          <div>
            <Group gap="sm">
              <Title order={2}>{editor.case.title}</Title>
              <RiskBadge value={editor.case.riskLevel} />
              <CaseStatusBadge value={editor.case.status} />
              <Badge variant="outline" color="grape">
                快照 R{editor.case.revision}
              </Badge>
              {baseRevision !== editor.case.revision ? (
                <Badge variant="light" color="orange">
                  草稿基于 R{baseRevision}
                </Badge>
              ) : null}
            </Group>
            <Text c="dimmed" size="sm" mt={5}>
              {editor.case.id} · 负责人 {editor.case.owner} · 更新于{" "}
              {new Date(editor.case.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </Text>
          </div>
        </Group>
        <Group>
          <Button
            variant="default"
            leftSection={<Pencil size={16} />}
            onClick={openCaseEdit}
          >
            编辑案件字段
          </Button>
          <Button
            variant="default"
            leftSection={<GitBranchPlus size={16} />}
            onClick={nodeModal.open}
          >
            加入图谱节点
          </Button>
          <Button
            variant="light"
            leftSection={<FilePlus2 size={16} />}
            onClick={evidenceModal.open}
          >
            登记证据
          </Button>
        </Group>
      </Group>

      <SaveBar
        revision={editor.case.revision}
        changes={pendingChanges}
        dirty={dirty}
        saving={isSaving}
        draft={draft}
        onOpenSave={saveModal.open}
        onDiscard={handleDiscardChanges}
        onRetryDraft={handleRetryDraft}
        onOpenConflicts={() => setConflictOpen(true)}
        onDiscardDraft={handleDiscardDraft}
      />

      <Paper withBorder p="md">
        <Group justify="space-between">
          <div>
            <Text size="sm" fw={600}>
              案件摘要
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {editor.case.summary}
            </Text>
          </div>
          <Group>
            <Button
              size="xs"
              variant="default"
              loading={isTransitioning}
              onClick={() => handleTransition("investigating")}
            >
              标记调查中
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={isTransitioning}
              onClick={() => handleTransition("pending_review")}
            >
              提交复核
            </Button>
            <Button
              size="xs"
              variant="light"
              color="orange"
              loading={isTransitioning}
              onClick={() => handleTransition("supplement")}
            >
              要求补证
            </Button>
            <Button
              size="xs"
              variant="light"
              color="teal"
              loading={isTransitioning}
              onClick={() => handleTransition("closed")}
            >
              关闭案件
            </Button>
          </Group>
        </Group>
      </Paper>

      <Tabs defaultValue="graph" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="graph">关系图谱与时间轴</Tabs.Tab>
          <Tabs.Tab value="evidence">证据台账</Tabs.Tab>
          <Tabs.Tab value="conclusions">结论与复核</Tabs.Tab>
          <Tabs.Tab value="alerts">关联告警</Tabs.Tab>
          <Tabs.Tab value="snapshots">快照与恢复</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="graph" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, xl: 8 }}>
              <Paper withBorder>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      案件关系图谱
                    </Text>
                    <Text size="xs" c="dimmed">
                      节点拖动与新增关系先进入本地草稿，保存快照时统一提交，避免覆盖另一窗口。
                    </Text>
                  </div>
                  <Badge variant="light" color="gray">
                    {editor.nodes.length} 节点 / {editor.edges.length} 关系
                  </Badge>
                </Group>
                <Divider />
                <InvestigationGraph
                  nodes={editor.nodes}
                  edges={editor.edges}
                  selectedNodeId={selectedNodeId}
                  focusedTimelineId={focusedTimelineId}
                  onSelectNode={(nodeId) => dispatch(selectNode(nodeId))}
                  onNodePositionChange={handleNodePositionChange}
                />
              </Paper>
              {selectedNode ? (
                <Paper withBorder p="md" mt="md">
                  <Group justify="space-between">
                    <div>
                      <Text fw={600}>{selectedNode.data.label} 节点说明</Text>
                      <Text size="xs" c="dimmed">
                        {selectedNode.data.source} ·{" "}
                        {new Date(
                          selectedNode.data.occurredAt,
                        ).toLocaleString("zh-CN", { hour12: false })}
                      </Text>
                    </div>
                    <Group>
                      <EvidenceStrengthBadge
                        value={selectedNode.data.evidenceStrength}
                      />
                      <Button
                        size="compact-xs"
                        color="red"
                        variant="subtle"
                        leftSection={<Trash2 size={13} />}
                        onClick={() => handleRemoveNode(selectedNode.id)}
                      >
                        删除节点及关系
                      </Button>
                    </Group>
                  </Group>
                  <Text size="sm" mt="sm">
                    {selectedNode.data.note}
                  </Text>
                </Paper>
              ) : null}
            </Grid.Col>
            <Grid.Col span={{ base: 12, xl: 4 }}>
              <Paper withBorder h={selectedNode ? 702 : 620}>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      联动时间轴
                    </Text>
                    <Text size="xs" c="dimmed">
                      点击事件可高亮关系或证据
                    </Text>
                  </div>
                  {focusedTimelineId ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<RotateCcw size={13} />}
                      onClick={() => handleTimelineFocus(undefined)}
                    >
                      清除
                    </Button>
                  ) : null}
                </Group>
                <Divider />
                <div style={{ height: selectedNode ? 642 : 560, padding: 12 }}>
                  <TransactionTimeline
                    alerts={caseAlerts}
                    edges={editor.edges}
                    evidence={editor.evidence}
                    focusedId={focusedTimelineId}
                    onFocus={handleTimelineFocus}
                  />
                </div>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="evidence" pt="md">
          <Paper withBorder>
            <Group justify="space-between" p="md">
              <div>
                <Text fw={600}>证据台账</Text>
                <Text size="sm" c="dimmed">
                  新增、移除或调整证据强度后保存，旧结论会列出新增、移除与强度差异并自动失效。
                </Text>
              </div>
              <Button
                leftSection={<FilePlus2 size={16} />}
                onClick={evidenceModal.open}
              >
                登记证据
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={1060}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>证据名称</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>强度（可调整）</Table.Th>
                    <Table.Th>发生时间</Table.Th>
                    <Table.Th>提交记录</Table.Th>
                    <Table.Th>附件标识</Table.Th>
                    <Table.Th>说明</Table.Th>
                    <Table.Th>操作</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {editor.evidence.map((item) => (
                    <Table.Tr
                      key={item.id}
                      className={
                        focusedEvidenceId === item.id
                          ? "table-row-focused"
                          : ""
                      }
                    >
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {item.title}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {item.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.source}</Table.Td>
                      <Table.Td>
                        <Select
                          size="xs"
                          w={110}
                          value={item.strength}
                          onChange={(value) =>
                            handleEvidenceStrength(
                              item.id,
                              (value as EvidenceStrength) ?? item.strength,
                            )
                          }
                          data={[
                            { value: "strong", label: "强证据" },
                            { value: "medium", label: "中等" },
                            { value: "weak", label: "弱证据" },
                          ]}
                        />
                      </Table.Td>
                      <Table.Td>
                        {new Date(item.occurredAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {item.submittedBy} · V{item.version}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {new Date(item.submittedAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {item.attachment}
                        </Text>
                      </Table.Td>
                      <Table.Td maw={260}>
                        <Text size="xs" c="dimmed">
                          {item.note}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<Trash2 size={12} />}
                          onClick={() => handleRemoveEvidence(item.id)}
                        >
                          移除
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="conclusions" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Paper withBorder>
                <Group justify="space-between" p="md">
                  <div>
                    <Text fw={600}>结论版本链</Text>
                    <Text size="sm" c="dimmed">
                      证据变化后草稿与待复核版本自动失效并保留在链上；已通过版本不可变。
                    </Text>
                  </div>
                  <Button onClick={saveModal.open}>保存时重算新版本</Button>
                </Group>
                <Stack gap={0}>
                  {editor.conclusions.length === 0 ? (
                    <Text c="dimmed" p="md" size="sm">
                      尚无结论版本。
                    </Text>
                  ) : (
                    editor.conclusions.map(renderConclusion)
                  )}
                </Stack>
              </Paper>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Paper withBorder p="md">
                <Title order={4}>复核操作</Title>
                {latestConclusion ? (
                  <>
                    <Text size="sm" c="dimmed" mt={5}>
                      当前版本 V{latestConclusion.version} ·{" "}
                      {dispositionLabels[latestConclusion.disposition]}
                    </Text>
                    {latestConclusion.status === "invalidated" ? (
                      <Alert color="red" mt="md" title="当前版本已失效，禁止复核">
                        证据台账已变化，请保存一份重算的新结论版本后再提交复核。
                      </Alert>
                    ) : (
                      <>
                        <Alert
                          color="orange"
                          icon={<RotateCcw size={16} />}
                          mt="md"
                        >
                          关系关联不能直接作为结论。通过前应检查证据来源、发生时间与证据强度。
                        </Alert>
                        <Textarea
                          label="复核意见"
                          description="通过或退回意见均进入不可删除的审计记录"
                          minRows={4}
                          mt="md"
                          value={reviewNote}
                          onChange={(event) =>
                            setReviewNote(event.currentTarget.value)
                          }
                        />
                        <Group mt="md">
                          <Button
                            leftSection={<Check size={16} />}
                            color="teal"
                            loading={isReviewing}
                            onClick={() => handleReview("approve")}
                          >
                            复核通过
                          </Button>
                          <Button
                            variant="light"
                            color="orange"
                            leftSection={<RotateCcw size={16} />}
                            loading={isReviewing}
                            onClick={() => handleReview("return")}
                          >
                            退回补证
                          </Button>
                        </Group>
                      </>
                    )}
                  </>
                ) : (
                  <Text c="dimmed" mt="md">
                    尚无结论版本。
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="alerts" pt="md">
          <Paper withBorder>
            <Group p="md" justify="space-between">
              <Text size="sm" c="dimmed">
                取消关联会先进入本地草稿，保存时与另一窗口的告警关联做并集合并。
              </Text>
            </Group>
            <Table.ScrollContainer minWidth={880}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>告警编号</Table.Th>
                    <Table.Th>标题</Table.Th>
                    <Table.Th>账户</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>金额</Table.Th>
                    <Table.Th>检测时间</Table.Th>
                    <Table.Th>操作</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {caseAlerts.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td ff="monospace">{item.id}</Table.Td>
                      <Table.Td>{item.title}</Table.Td>
                      <Table.Td>{item.account}</Table.Td>
                      <Table.Td>
                        <RiskBadge value={item.riskLevel} />
                      </Table.Td>
                      <Table.Td>¥{item.amount.toLocaleString("zh-CN")}</Table.Td>
                      <Table.Td>
                        {new Date(item.detectedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="orange"
                          leftSection={<Unlink size={12} />}
                          onClick={() => handleUnlinkAlert(item.id)}
                        >
                          取消关联
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {caseAlerts.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <Text size="sm" c="dimmed" py="md">
                          暂无关联告警，可在告警中心批量关联。
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : null}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="snapshots" pt="md">
          <SnapshotHistoryPanel
            snapshots={snapshots}
            currentRevision={editor.case.revision}
            restoring={isRestoring}
            onRestore={handleRestore}
          />
        </Tabs.Panel>
      </Tabs>

      {/* 加入图谱节点 */}
      <Modal
        opened={nodeOpened}
        onClose={nodeModal.close}
        title="加入案件图谱节点（进入待保存草稿）"
        size="lg"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="关系源节点"
            required
            searchable
            value={nodeForm.sourceId}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                sourceId: value ?? "",
              }))
            }
            data={editor.nodes.map((item) => ({
              value: item.id,
              label: item.data.label,
            }))}
          />
          <Select
            label="节点类型"
            value={nodeForm.kind}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                kind: (value as NodeKind) ?? "account",
              }))
            }
            data={[
              { value: "account", label: "账户" },
              { value: "device", label: "设备" },
              { value: "ip", label: "IP 地址" },
              { value: "merchant", label: "商户" },
            ]}
          />
          <TextInput
            label="节点名称"
            required
            value={nodeForm.label}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                label: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={nodeForm.source}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="风险等级"
            value={nodeForm.riskLevel}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                riskLevel: (value as RiskLevel) ?? "medium",
              }))
            }
            data={[
              { value: "high", label: "高风险" },
              { value: "medium", label: "中风险" },
              { value: "low", label: "低风险" },
            ]}
          />
          <Select
            label="证据强度"
            value={nodeForm.evidenceStrength}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                evidenceStrength:
                  (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强" },
              { value: "medium", label: "中" },
              { value: "weak", label: "弱" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={nodeForm.occurredAt}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <NumberInput
            label="关联金额"
            value={nodeForm.amount}
            min={0}
            thousandSeparator
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                amount: Number(value) || 0,
              }))
            }
          />
          <TextInput
            label="关系名称"
            placeholder="例如：转账 12 万"
            value={nodeForm.relationLabel}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationLabel: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="关系解释"
            placeholder="说明关联依据与限制"
            value={nodeForm.relationExplanation}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationExplanation: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="节点说明"
          minRows={3}
          mt="md"
          value={nodeForm.note}
          onChange={(event) =>
            setNodeForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={nodeModal.close}>
            取消
          </Button>
          <Button onClick={handleAddNode}>加入草稿</Button>
        </Group>
      </Modal>

      {/* 登记证据 */}
      <Modal
        opened={evidenceOpened}
        onClose={evidenceModal.close}
        title="登记案件证据（进入待保存台账）"
        size="lg"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="证据名称"
            required
            value={evidenceForm.title}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                title: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={evidenceForm.source}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="证据强度"
            value={evidenceForm.strength}
            onChange={(value) =>
              setEvidenceForm((current) => ({
                ...current,
                strength: (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强证据" },
              { value: "medium", label: "中等证据" },
              { value: "weak", label: "弱证据" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={evidenceForm.occurredAt}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="附件标识"
            required
            placeholder="文件名或本地附件编号"
            value={evidenceForm.attachment}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                attachment: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="证据说明"
          minRows={3}
          mt="md"
          value={evidenceForm.note}
          onChange={(event) =>
            setEvidenceForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={evidenceModal.close}>
            取消
          </Button>
          <Button onClick={handleAddEvidence}>加入草稿</Button>
        </Group>
      </Modal>

      {/* 编辑案件字段 */}
      <Modal
        opened={caseEditOpened}
        onClose={caseEditModal.close}
        title="编辑案件字段（进入待保存草稿）"
      >
        <Stack gap="sm">
          <TextInput
            label="案件标题"
            value={caseForm.title}
            onChange={(event) =>
              setCaseForm((current) => ({
                ...current,
                title: event.currentTarget.value,
              }))
            }
          />
          <Textarea
            label="案件摘要"
            minRows={3}
            value={caseForm.summary}
            onChange={(event) =>
              setCaseForm((current) => ({
                ...current,
                summary: event.currentTarget.value,
              }))
            }
          />
          <SimpleGrid cols={2}>
            <TextInput
              label="负责人"
              value={caseForm.owner}
              onChange={(event) =>
                setCaseForm((current) => ({
                  ...current,
                  owner: event.currentTarget.value,
                }))
              }
            />
            <Select
              label="风险等级"
              value={caseForm.riskLevel}
              onChange={(value) =>
                setCaseForm((current) => ({
                  ...current,
                  riskLevel: (value as RiskLevel) ?? "medium",
                }))
              }
              data={[
                { value: "high", label: "高风险" },
                { value: "medium", label: "中风险" },
                { value: "low", label: "低风险" },
              ]}
            />
          </SimpleGrid>
          <TextInput
            type="datetime-local"
            label="下次复核时间"
            value={caseForm.nextReviewAt}
            onChange={(event) =>
              setCaseForm((current) => ({
                ...current,
                nextReviewAt: event.currentTarget.value,
              }))
            }
          />
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={caseEditModal.close}>
              取消
            </Button>
            <Button onClick={handleSaveCaseFields}>加入草稿</Button>
          </Group>
        </Stack>
      </Modal>

      <SaveSnapshotModal
        opened={saveOpened}
        changes={pendingChanges}
        defaultNote={defaultSaveNote()}
        saving={isSaving}
        onClose={saveModal.close}
        onSubmit={(payload) => {
          void performSave(payload);
        }}
      />

      <ConflictModal
        opened={conflictOpen}
        conflicts={conflicts}
        autoMerged={autoMerged}
        onChange={handleConflictResolutionChange}
        onClose={() => setConflictOpen(false)}
        onConfirm={() => {
          if (pendingPayload) {
            void handleConfirmOverwrite();
          } else {
            void handleRetryDraft();
          }
        }}
        submitting={isSaving}
      />
    </Stack>
  );
}
