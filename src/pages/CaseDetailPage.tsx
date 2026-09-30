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
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useDisclosure } from "@mantine/hooks";
import {
  ArrowLeft,
  Check,
  FilePlus2,
  FlaskConical,
  GitBranchPlus,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
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
import { ConflictResolutionModal } from "../features/snapshot/ConflictResolutionModal";
import { EvidenceChangeSummary } from "../features/snapshot/EvidenceChangeSummary";
import { PendingDraftsBanner } from "../features/snapshot/PendingDraftsBanner";
import { SnapshotHistoryPanel } from "../features/snapshot/SnapshotHistoryPanel";
import type {
  CaseDisposition,
  Evidence,
  EvidenceStrength,
  NodeKind,
  RiskLevel,
} from "../models/types";
import type { FieldConflict } from "../models/snapshot";
import {
  deterministicId,
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useChangeEvidenceStrengthMutation,
  useGetCaseWorkspaceQuery,
  useRemoveEvidenceMutation,
  useRetryDraftCommitMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useSetFailureSimulationMutation,
  useTransitionCaseMutation,
  useUpdateGraphNodeMutation,
  useGetPendingDraftsQuery,
} from "../services/api";
import { getSimulateFailure } from "../services/mockStorage";
import type { CommitSnapshotSuccess, PendingDraft } from "../models/snapshot";

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

const strengthOptions = [
  { value: "strong", label: "强证据" },
  { value: "medium", label: "中等证据" },
  { value: "weak", label: "弱证据" },
];

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请检查输入后重试。";
};

const isCommitError = (
  error: unknown,
): error is {
  error: string;
  conflicts?: FieldConflict[];
  autoMerged?: number;
  draftId?: string;
} =>
  typeof error === "object" &&
  error !== null &&
  "error" in error &&
  typeof (error as { error?: unknown }).error === "string";

interface ConflictState {
  draftId: string;
  conflicts: FieldConflict[];
  autoMerged: number;
}

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
  const { data: draftsOnOpen } = useGetPendingDraftsQuery(caseId);
  // 只捕获打开案件那一刻已存在的草稿：之后新产生的冲突由当前操作的弹窗处理
  const draftsAtMountRef = useRef<PendingDraft[] | null>(null);
  if (draftsAtMountRef.current === null && draftsOnOpen) {
    draftsAtMountRef.current = draftsOnOpen;
  }
  const draftsAtMount = draftsAtMountRef.current ?? [];
  const [addNode] = useAddGraphNodeMutation();
  const [updateNode] = useUpdateGraphNodeMutation();
  const [addEvidence, { isLoading: isAddingEvidence }] =
    useAddEvidenceMutation();
  const [changeStrength] = useChangeEvidenceStrengthMutation();
  const [removeEvidence] = useRemoveEvidenceMutation();
  const [saveConclusion, { isLoading: isSavingConclusion }] =
    useSaveConclusionMutation();
  const [transitionCase, { isLoading: isTransitioning }] =
    useTransitionCaseMutation();
  const [reviewConclusion, { isLoading: isReviewing }] =
    useReviewConclusionMutation();
  const [retryCommit, { isLoading: isRetryingConflict }] =
    useRetryDraftCommitMutation();
  const [setFailureMode] = useSetFailureSimulationMutation();
  const [failureSimOn, setFailureSimOn] = useState<boolean>(() =>
    getSimulateFailure(),
  );

  const [nodeOpened, nodeModal] = useDisclosure(false);
  const [evidenceOpened, evidenceModal] = useDisclosure(false);
  const [conclusionOpened, conclusionModal] = useDisclosure(false);
  const [reviewNote, setReviewNote] = useState("");
  const [conflictState, setConflictState] = useState<ConflictState | null>(
    null,
  );
  const [nodeForm, setNodeForm] = useState({
    sourceId: "",
    kind: "account" as NodeKind,
    label: "",
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "2026-09-29T09:00",
    note: "",
    relationLabel: "",
    relationExplanation: "",
    amount: 0,
  });
  const [evidenceForm, setEvidenceForm] = useState({
    title: "",
    source: "",
    strength: "medium" as EvidenceStrength,
    occurredAt: "2026-09-29T09:00",
    attachment: "",
    note: "",
  });
  const [conclusionForm, setConclusionForm] = useState({
    disposition: "observe" as CaseDisposition,
    rationale: "",
    riskControls: "",
  });

  const latestConclusion = data?.conclusions[0];

  const openConclusionModal = () => {
    // 旧结论失效后新建版本：沿用处置建议与措施草稿，结论依据必须基于新证据重算
    if (latestConclusion?.status === "invalidated") {
      setConclusionForm({
        disposition: latestConclusion.disposition,
        rationale: "",
        riskControls: latestConclusion.riskControls.join("\n"),
      });
    }
    conclusionModal.open();
  };

  /** 保存成功后按版本摘要提示；冲突错误交给确认弹窗 */
  const handleCommitOutcome = (
    caught: unknown,
    failTitle: string,
  ): "conflict" | "failed" => {
    if (isCommitError(caught) && caught.conflicts && caught.draftId) {
      setConflictState({
        draftId: caught.draftId,
        conflicts: caught.conflicts,
        autoMerged: caught.autoMerged ?? 0,
      });
      notifications.show({
        color: "orange",
        title: "与另一窗口的保存冲突",
        message: "无冲突字段已自动合并，请确认冲突项后覆盖。",
      });
      return "conflict";
    }
    notifications.show({
      color: "red",
      title: failTitle,
      message: errorMessage(caught),
    });
    return "failed";
  };

  const notifySnapshotSaved = (
    result: CommitSnapshotSuccess,
    title: string,
  ): void => {
    notifications.show({
      color: "teal",
      title: `${title} · 快照 V${result.revision}`,
      message:
        result.invalidatedConclusionIds.length > 0
          ? `已保存并带版本摘要；${result.invalidatedConclusionIds.length} 份旧结论因证据变化失效，需要重算。`
          : result.autoMerged > 0
            ? `已保存；另一个窗口的 ${result.autoMerged} 项无冲突更新已自动合并。`
            : "告警、案件、图谱、证据与结论已写入同一份可恢复快照。",
    });
  };

  const resolveConflict = async (resolvedPaths: string[]) => {
    if (!conflictState) {
      return;
    }
    try {
      const result = await retryCommit({
        draftId: conflictState.draftId,
        resolvedPaths,
      }).unwrap();
      setConflictState(null);
      notifySnapshotSaved(result, "冲突已解决");
    } catch (caught) {
      if (isCommitError(caught) && caught.conflicts && caught.draftId) {
        setConflictState({
          draftId: caught.draftId,
          conflicts: caught.conflicts,
          autoMerged: caught.autoMerged ?? 0,
        });
        notifications.show({
          color: "orange",
          title: "仍有未解决的冲突项",
          message: "另一窗口又有新的保存，请继续逐项确认。",
        });
      } else {
        notifications.show({
          color: "red",
          title: "保存失败",
          message: "草稿已保留，可稍后重试。",
        });
      }
    }
  };

  if (isLoading) {
    return <Text>正在加载案件工作区...</Text>;
  }

  if (error || !data) {
    return (
      <Alert color="red" title="案件加载失败">
        {errorMessage(error)}
      </Alert>
    );
  }

  const caseAlerts = data.alerts;
  const selectedNode = data.nodes.find((item) => item.id === selectedNodeId);
  const invalidatedConclusions = data.conclusions.filter(
    (item) => item.status === "invalidated",
  );

  const handleTimelineFocus = (event?: TimelineEvent) => {
    dispatch(focusTimeline(event?.id));
    dispatch(focusEvidence(event?.source === "evidence" ? event.id : undefined));
    if (event?.source === "transaction") {
      const edge = data.edges.find((item) => item.id === event.id);
      if (edge) {
        dispatch(selectNode(edge.target));
      }
    }
  };

  const handleAddNode = async () => {
    if (!nodeForm.sourceId || !nodeForm.label.trim() || !nodeForm.source.trim()) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "关系源节点、节点名称和证据来源均为必填项。",
      });
      return;
    }
    try {
      const result = await addNode({
        caseId,
        node: {
          id: deterministicId("NODE"),
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
        },
        relation: {
          sourceId: nodeForm.sourceId,
          kind: "transfer",
          label: nodeForm.relationLabel.trim() || "已登记关系",
          explanation:
            nodeForm.relationExplanation.trim() ||
            "关系来自调查员登记，需结合来源材料复核。",
          amount: nodeForm.amount || undefined,
        },
      }).unwrap();
      notifySnapshotSaved(result, "节点已加入");
      nodeModal.close();
      setNodeForm((current) => ({
        ...current,
        label: "",
        source: "",
        note: "",
      }));
    } catch (caught) {
      handleCommitOutcome(caught, "加入失败");
    }
  };

  const handleAddEvidence = async () => {
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
    try {
      const result = await addEvidence({
        caseId,
        title: evidenceForm.title.trim(),
        source: evidenceForm.source.trim(),
        strength: evidenceForm.strength,
        occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
        attachment: evidenceForm.attachment.trim(),
        note: evidenceForm.note.trim() || "未补充说明。",
      }).unwrap();
      notifySnapshotSaved(result, "证据已登记");
      evidenceModal.close();
      setEvidenceForm((current) => ({
        ...current,
        title: "",
        source: "",
        attachment: "",
        note: "",
      }));
    } catch (caught) {
      handleCommitOutcome(caught, "证据登记失败");
    }
  };

  const handleStrengthChange = async (
    evidence: Evidence,
    strength: EvidenceStrength,
  ) => {
    if (strength === evidence.strength) {
      return;
    }
    try {
      const result = await changeStrength({
        caseId,
        evidenceId: evidence.id,
        strength,
      }).unwrap();
      notifySnapshotSaved(result, "证据强度已调整");
    } catch (caught) {
      handleCommitOutcome(caught, "强度调整失败");
    }
  };

  const handleRemoveEvidence = async (evidence: Evidence) => {
    try {
      const result = await removeEvidence({
        caseId,
        evidenceId: evidence.id,
        evidenceTitle: evidence.title,
      }).unwrap();
      notifySnapshotSaved(result, "证据已移除");
    } catch (caught) {
      handleCommitOutcome(caught, "证据移除失败");
    }
  };

  const handleSaveConclusion = async (submit: boolean) => {
    if (conclusionForm.rationale.trim().length < 12) {
      notifications.show({
        color: "red",
        title: "结论依据不足",
        message: "结论说明至少需要 12 个字符。",
      });
      return;
    }
    try {
      const result = await saveConclusion({
        caseId,
        disposition: conclusionForm.disposition,
        rationale: conclusionForm.rationale.trim(),
        riskControls: conclusionForm.riskControls
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        submit,
      }).unwrap();
      notifySnapshotSaved(result, submit ? "已提交复核" : "草稿已保存");
      conclusionModal.close();
      setConclusionForm({
        disposition: "observe",
        rationale: "",
        riskControls: "",
      });
    } catch (caught) {
      handleCommitOutcome(caught, "结论保存失败");
    }
  };

  const handleTransition = async (
    status: "investigating" | "pending_review" | "supplement" | "closed",
  ) => {
    try {
      const result = await transitionCase({ caseId, status }).unwrap();
      notifySnapshotSaved(result, "状态已更新");
    } catch (caught) {
      handleCommitOutcome(caught, "状态流转失败");
    }
  };

  const handleReview = async (decision: "approve" | "return") => {
    if (!latestConclusion) {
      return;
    }
    if (latestConclusion.status === "invalidated") {
      notifications.show({
        color: "red",
        title: "该结论已失效",
        message: "证据已发生变化，请先基于最新证据重算并提交新结论。",
      });
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
      const result = await reviewConclusion({
        caseId,
        conclusionId: latestConclusion.id,
        decision,
        reviewerNote: reviewNote.trim(),
      }).unwrap();
      notifySnapshotSaved(
        result,
        decision === "approve" ? "复核通过" : "已退回补证",
      );
      setReviewNote("");
    } catch (caught) {
      handleCommitOutcome(caught, "复核失败");
    }
  };

  const toggleFailureSimulation = (enabled: boolean) => {
    setFailureSimOn(enabled);
    setFailureMode(enabled);
    notifications.show({
      color: enabled ? "orange" : "gray",
      title: enabled ? "已开启保存失败模拟" : "已关闭保存失败模拟",
      message: enabled
        ? "之后的保存会失败并保留草稿，可在关闭后由横幅自动重试。"
        : "保存恢复正常，待提交草稿将自动重试。",
    });
  };

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
              <Title order={2}>{data.case.title}</Title>
              <RiskBadge value={data.case.riskLevel} />
              <CaseStatusBadge value={data.case.status} />
              <Tooltip label="告警、案件、图谱、证据、结论共用同一份快照版本">
                <Badge variant="outline" color="grape">
                  快照 V{data.revision}
                </Badge>
              </Tooltip>
            </Group>
            <Text c="dimmed" size="sm" mt={5}>
              {data.case.id} · 负责人 {data.case.owner} · 更新于{" "}
              {new Date(data.case.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </Text>
          </div>
        </Group>
        <Group>
          <Tooltip label="演示用：开启后所有保存会失败并保留草稿，用于验证重试流程">
            <Switch
              size="sm"
              color="orange"
              label={
                <Group gap={4} wrap="nowrap">
                  <FlaskConical size={14} />
                  <Text size="xs">模拟保存失败</Text>
                </Group>
              }
              checked={failureSimOn}
              onChange={(event) =>
                toggleFailureSimulation(event.currentTarget.checked)
              }
            />
          </Tooltip>
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
          <Button
            leftSection={<Send size={16} />}
            onClick={openConclusionModal}
          >
            新建结论版本
          </Button>
        </Group>
      </Group>

      <PendingDraftsBanner caseId={caseId} draftsAtMount={draftsAtMount} />

      {invalidatedConclusions.length > 0 ? (
        <Alert color="red" title="存在证据变化后失效的旧结论，需要重算">
          <Stack gap="sm">
            <Text size="sm">
              证据台账已变化，以下结论的判断基线过期，不能继续沿用；可通过"新建结论版本"基于当前证据重新计算。
              重启浏览器后这些失效版本依然可见。
            </Text>
            {invalidatedConclusions.map((item) => (
              <Paper key={item.id} withBorder p="sm" bg="var(--mantine-color-red-0)">
                <Group justify="space-between" mb={6}>
                  <Group gap="xs">
                    <Text size="sm" fw={700}>
                      V{item.version}
                    </Text>
                    <ConclusionStatusBadge value={item.status} />
                    <Text size="xs" c="dimmed">
                      失效于{" "}
                      {item.invalidatedAt
                        ? new Date(item.invalidatedAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })
                        : "—"}
                    </Text>
                  </Group>
                  <Button
                    size="compact-xs"
                    onClick={() => {
                      openConclusionModal();
                    }}
                  >
                    基于新证据重算
                  </Button>
                </Group>
                {item.invalidation ? (
                  <EvidenceChangeSummary changeSet={item.invalidation} compact />
                ) : null}
              </Paper>
            ))}
          </Stack>
        </Alert>
      ) : null}

      <Paper withBorder p="md">
        <Group justify="space-between">
          <div>
            <Text size="sm" fw={600}>
              案件摘要
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {data.case.summary}
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
          <Tabs.Tab value="history">快照版本</Tabs.Tab>
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
                      拖动节点可调整布局；关联关系必须结合解释和证据复核。
                    </Text>
                  </div>
                  <Badge variant="light" color="gray">
                    {data.nodes.length} 节点 / {data.edges.length} 关系
                  </Badge>
                </Group>
                <Divider />
                <InvestigationGraph
                  nodes={data.nodes}
                  edges={data.edges}
                  selectedNodeId={selectedNodeId}
                  focusedTimelineId={focusedTimelineId}
                  onSelectNode={(nodeId) => dispatch(selectNode(nodeId))}
                  onNodePositionChange={(nodeId, position) => {
                    const node = data.nodes.find((item) => item.id === nodeId);
                    if (node) {
                      void updateNode({
                        caseId,
                        node: { ...node, position },
                      });
                    }
                  }}
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
                    <EvidenceStrengthBadge
                      value={selectedNode.data.evidenceStrength}
                    />
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
                    edges={data.edges}
                    evidence={data.evidence}
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
                  每份证据记录来源、发生时间、提交时间和证据强度；新增、移除或调整强度都会令旧结论失效并进入快照版本摘要。
                </Text>
              </div>
              <Button
                leftSection={<FilePlus2 size={16} />}
                onClick={evidenceModal.open}
              >
                登记证据
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={1080}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>证据名称</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>强度</Table.Th>
                    <Table.Th>发生时间</Table.Th>
                    <Table.Th>提交记录</Table.Th>
                    <Table.Th>附件标识</Table.Th>
                    <Table.Th>说明</Table.Th>
                    <Table.Th>操作</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.evidence.map((item) => (
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
                          variant="unstyled"
                          value={item.strength}
                          data={strengthOptions}
                          allowDeselect={false}
                          onChange={(value) => {
                            if (value) {
                              void handleStrengthChange(
                                item,
                                value as EvidenceStrength,
                              );
                            }
                          }}
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
                        <Tooltip label="移除后旧结论将失效，可通过快照恢复">
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="red"
                            leftSection={<Trash2 size={13} />}
                            onClick={() => void handleRemoveEvidence(item)}
                          >
                            移除
                          </Button>
                        </Tooltip>
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
                    <Text fw={600}>结论版本</Text>
                    <Text size="sm" c="dimmed">
                      证据变化后旧结论自动失效并列出差异；已通过版本不可覆盖，任何修改都产生新版本。
                    </Text>
                  </div>
                  <Button onClick={openConclusionModal}>新建版本</Button>
                </Group>
                <Stack gap={0}>
                  {data.conclusions.map((item, index) => (
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
                            <Text size="xs" c="dimmed" ff="monospace">
                              基于快照 V{item.baseRevision}
                            </Text>
                          </Group>
                          <Text size="xs" c="dimmed">
                            {item.createdBy} ·{" "}
                            {new Date(item.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </Text>
                        </Group>
                        {item.status === "invalidated" ? (
                          <Alert color="red" title="证据变化，该结论已失效，请重算">
                            {item.invalidation ? (
                              <EvidenceChangeSummary
                                changeSet={item.invalidation}
                                compact
                              />
                            ) : null}
                          </Alert>
                        ) : null}
                        <Text
                          size="sm"
                          td={
                            item.status === "invalidated" ? "line-through" : undefined
                          }
                          c={
                            item.status === "invalidated" ? "dimmed" : undefined
                          }
                        >
                          {item.rationale}
                        </Text>
                        <Group gap="xs">
                          {item.riskControls.map((control) => (
                            <Badge key={control} variant="outline" color="gray">
                              {control}
                            </Badge>
                          ))}
                        </Group>
                        {item.reviewerNote ? (
                          <Alert
                            color={
                              item.status === "approved" ? "teal" : "orange"
                            }
                            title={`复核意见 · ${item.reviewer}`}
                          >
                            {item.reviewerNote}
                          </Alert>
                        ) : null}
                      </Stack>
                    </div>
                  ))}
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
                      <Alert color="red" mt="md">
                        当前最新结论已因证据变化失效，不能复核或沿用。请先基于新增/移除/强度变化后的证据重算并提交新版本。
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
            <Table.ScrollContainer minWidth={820}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>告警编号</Table.Th>
                    <Table.Th>标题</Table.Th>
                    <Table.Th>账户</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>金额</Table.Th>
                    <Table.Th>检测时间</Table.Th>
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
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="history" pt="md">
          <SnapshotHistoryPanel
            caseId={caseId}
            currentRevision={data.revision}
            history={data.history}
          />
        </Tabs.Panel>
      </Tabs>

      <Modal
        opened={nodeOpened}
        onClose={nodeModal.close}
        title="加入案件图谱节点"
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
            data={data.nodes.map((item) => ({
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
            data={strengthOptions}
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
          <Button onClick={handleAddNode}>加入图谱</Button>
        </Group>
      </Modal>

      <Modal
        opened={evidenceOpened}
        onClose={evidenceModal.close}
        title="登记案件证据"
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
            data={strengthOptions}
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
          <Button loading={isAddingEvidence} onClick={handleAddEvidence}>
            登记证据
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={conclusionOpened}
        onClose={conclusionModal.close}
        title="新建结论版本"
        size="lg"
      >
        {latestConclusion?.status === "invalidated" ? (
          <Alert color="red" mb="md">
            上一版结论依据的证据已变化。处置建议和风控措施已预填，但结论依据必须结合下方差异重新撰写，不得沿用旧结论。
          </Alert>
        ) : null}
        <Select
          label="处置建议"
          value={conclusionForm.disposition}
          onChange={(value) =>
            setConclusionForm((current) => ({
              ...current,
              disposition: (value as CaseDisposition) ?? "observe",
            }))
          }
          data={[
            { value: "freeze", label: "建议冻结" },
            { value: "release", label: "建议放行" },
            { value: "observe", label: "继续观察" },
          ]}
        />
        <Textarea
          label="结论依据"
          description="至少 12 个字符；说明关联事实、证据限制与判断边界"
          minRows={5}
          mt="md"
          value={conclusionForm.rationale}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              rationale: event.currentTarget.value,
            }))
          }
        />
        <Textarea
          label="风险控制措施"
          description="每行一项"
          minRows={4}
          mt="md"
          value={conclusionForm.riskControls}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              riskControls: event.currentTarget.value,
            }))
          }
        />
        <Alert color="gray" mt="md">
          保存草稿不会触发复核；提交后生成独立版本并进入待复核状态。新版本会锁定当前证据指纹，证据再变化时自动失效。
        </Alert>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={conclusionModal.close}>
            取消
          </Button>
          <Button
            variant="light"
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(false)}
          >
            保存草稿
          </Button>
          <Button
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(true)}
          >
            提交复核
          </Button>
        </Group>
      </Modal>

      <ConflictResolutionModal
        opened={conflictState !== null}
        conflicts={conflictState?.conflicts ?? []}
        autoMergedCount={conflictState?.autoMerged ?? 0}
        submitting={isRetryingConflict}
        onClose={() => setConflictState(null)}
        onResolve={resolveConflict}
      />
    </Stack>
  );
}
