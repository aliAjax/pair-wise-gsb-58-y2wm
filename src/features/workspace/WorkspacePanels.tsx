import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Radio,
  ScrollArea,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  History,
  RotateCcw,
  Save,
  WifiOff,
} from "lucide-react";
import type {
  CaseBundle,
  CaseSnapshot,
  EvidenceChange,
  PendingDraft,
  SnapshotSummary,
  WorkspaceConflict,
} from "../../models/types";
import {
  describeSummary,
  diffEvidence,
  displayValue,
} from "../../services/snapshotCore";

/* ---------- 改动统计 ---------- */

export interface PendingChanges {
  addedAlerts: number;
  removedAlerts: number;
  addedNodes: number;
  removedNodes: number;
  addedEdges: number;
  removedEdges: number;
  addedEvidence: number;
  removedEvidence: number;
  strengthChanged: number;
  caseFields: number;
  hasConclusion: boolean;
}

export const computePendingChanges = (
  server: CaseBundle,
  local: CaseBundle,
  hasConclusion: boolean,
): PendingChanges => {
  const sid = new Set(server.nodes.map((item) => item.id));
  const lid = new Set(local.nodes.map((item) => item.id));
  const sie = new Set(server.edges.map((item) => item.id));
  const lie = new Set(local.edges.map((item) => item.id));
  const sev = new Set(server.evidence.map((item) => item.id));
  const lev = new Set(local.evidence.map((item) => item.id));
  const sia = new Set(server.alertIds);
  const lia = new Set(local.alertIds);
  const serverEvidenceMap = new Map(
    server.evidence.map((item) => [item.id, item]),
  );

  const caseFields = ["title", "summary", "owner", "riskLevel", "nextReviewAt"]
    .filter(
      (field) =>
        JSON.stringify(
          server.case[field as keyof CaseBundle["case"]],
        ) !==
        JSON.stringify(local.case[field as keyof CaseBundle["case"]]),
    ).length;

  return {
    addedAlerts: local.alertIds.filter((id) => !sia.has(id)).length,
    removedAlerts: server.alertIds.filter((id) => !lia.has(id)).length,
    addedNodes: local.nodes.filter((item) => !sid.has(item.id)).length,
    removedNodes: server.nodes.filter((item) => !lid.has(item.id)).length,
    addedEdges: local.edges.filter((item) => !sie.has(item.id)).length,
    removedEdges: server.edges.filter((item) => !lie.has(item.id)).length,
    addedEvidence: local.evidence.filter((item) => !sev.has(item.id)).length,
    removedEvidence: server.evidence.filter((item) => !lev.has(item.id)).length,
    strengthChanged: local.evidence.filter(
      (item) =>
        serverEvidenceMap.has(item.id) &&
        serverEvidenceMap.get(item.id)?.strength !== item.strength,
    ).length,
    caseFields,
    hasConclusion,
  };
};

export const ChangeChips = ({ changes }: { changes: PendingChanges }) => {
  const chips: string[] = [];
  if (changes.caseFields) chips.push(`案件字段 ×${changes.caseFields}`);
  if (changes.addedAlerts) chips.push(`新增告警 ×${changes.addedAlerts}`);
  if (changes.removedAlerts) chips.push(`移除告警 ×${changes.removedAlerts}`);
  if (changes.addedNodes) chips.push(`新增节点 ×${changes.addedNodes}`);
  if (changes.removedNodes) chips.push(`移除节点 ×${changes.removedNodes}`);
  if (changes.addedEdges) chips.push(`新增关系 ×${changes.addedEdges}`);
  if (changes.removedEdges) chips.push(`移除关系 ×${changes.removedEdges}`);
  if (changes.addedEvidence) chips.push(`新增证据 ×${changes.addedEvidence}`);
  if (changes.removedEvidence) chips.push(`移除证据 ×${changes.removedEvidence}`);
  if (changes.strengthChanged)
    chips.push(`强度调整 ×${changes.strengthChanged}`);
  if (changes.hasConclusion) chips.push("含新结论版本");
  if (chips.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        暂无改动
      </Text>
    );
  }
  return (
    <Group gap={6}>
      {chips.map((chip) => (
        <Badge key={chip} variant="light" color="blue">
          {chip}
        </Badge>
      ))}
    </Group>
  );
};

/* ---------- 顶部保存条 ---------- */

interface SaveBarProps {
  revision: number;
  changes: PendingChanges;
  dirty: boolean;
  saving: boolean;
  draft?: PendingDraft;
  onOpenSave: () => void;
  onDiscard: () => void;
  onRetryDraft: () => void;
  onOpenConflicts: () => void;
  onDiscardDraft: () => void;
}

export const SaveBar = ({
  revision,
  changes,
  dirty,
  saving,
  draft,
  onOpenSave,
  onDiscard,
  onRetryDraft,
  onOpenConflicts,
  onDiscardDraft,
}: SaveBarProps) => {
  if (!dirty && !draft) {
    return (
      <Paper withBorder p="sm" radius="md">
        <Group justify="space-between">
          <Group gap="xs">
            <ThemeIcon size="sm" color="teal" variant="light">
              <CheckCircle2 size={14} />
            </ThemeIcon>
            <Text size="sm">工作区已与快照 R{revision} 同步，无未保存改动。</Text>
          </Group>
          <Text size="xs" c="dimmed">
            所有模块共用同一份可恢复快照
          </Text>
        </Group>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="sm" radius="md" style={{ borderColor: "#f59f00" }}>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Stack gap={6}>
            {draft ? (
              <Group gap="xs">
                <ThemeIcon size="sm" color="red" variant="light">
                  <WifiOff size={14} />
                </ThemeIcon>
                <Text size="sm" fw={600}>
                  {draft.reason === "conflict"
                    ? "存在未决冲突的保存草稿"
                    : "上次保存失败，草稿已保留"}
                </Text>
                <Badge variant="dot" color="red">
                  重启后仍会保留 · 已尝试 {draft.attempts} 次
                </Badge>
              </Group>
            ) : (
              <Group gap="xs">
                <ThemeIcon size="sm" color="orange" variant="light">
                  <CloudUpload size={14} />
                </ThemeIcon>
                <Text size="sm" fw={600}>
                  有未保存的本地改动（基于 R{revision}）
                </Text>
              </Group>
            )}
            {dirty ? <ChangeChips changes={changes} /> : null}
            {draft && !dirty ? (
              <Text size="xs" c="dimmed">
                草稿说明：{draft.summaryNote}
              </Text>
            ) : null}
          </Stack>
          <Group>
            {draft ? (
              <>
                {draft.conflicts.length > 0 ? (
                  <Button
                    size="xs"
                    color="orange"
                    leftSection={<AlertTriangle size={14} />}
                    onClick={onOpenConflicts}
                  >
                    处理 {draft.conflicts.length} 项冲突
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    leftSection={<RotateCcw size={14} />}
                    loading={saving}
                    onClick={onRetryDraft}
                  >
                    立即重试
                  </Button>
                )}
                <Button size="xs" variant="subtle" color="red" onClick={onDiscardDraft}>
                  丢弃草稿
                </Button>
              </>
            ) : (
              <>
                <Button size="xs" variant="default" onClick={onDiscard}>
                  放弃改动
                </Button>
                <Button
                  size="xs"
                  leftSection={<Save size={14} />}
                  loading={saving}
                  onClick={onOpenSave}
                >
                  保存快照
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
};

/* ---------- 冲突解决 ---------- */

interface ConflictModalProps {
  opened: boolean;
  conflicts: WorkspaceConflict[];
  autoMerged: WorkspaceConflict[];
  onChange: (index: number, resolution: "local" | "server") => void;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}

export const ConflictModal = ({
  opened,
  conflicts,
  autoMerged,
  onChange,
  onClose,
  onConfirm,
  submitting,
}: ConflictModalProps) => {
  const unresolved = conflicts.filter((item) => !item.resolution).length;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="并发保存冲突：请确认后覆盖"
      size="xl"
      closeOnClickOutside={false}
    >
      <Stack gap="md">
        <Alert color="teal" variant="light" title="无冲突改动已自动合并">
          对方窗口新增的实体、双方各自修改的不同字段等 {autoMerged.length}{" "}
          项无冲突改动已自动并入。以下 {conflicts.length}
          项为双方修改了同一字段，需要你逐项确认。
        </Alert>
        <ScrollArea.Autosize mah={420}>
          <Stack gap="sm">
            {conflicts.map((conflict, index) => (
              <Paper
                key={`${conflict.scope}-${conflict.id ?? ""}-${conflict.field}-${index}`}
                withBorder
                p="sm"
              >
                <Group justify="space-between" mb={6}>
                  <Text size="sm" fw={600}>
                    {conflict.label}
                  </Text>
                  <Badge
                    variant="light"
                    color={
                      conflict.kind === "field" ? "orange" : "red"
                    }
                  >
                    {conflict.kind === "field"
                      ? "字段冲突"
                      : "删除/保留冲突"}
                  </Badge>
                </Group>
                <Radio.Group
                  value={conflict.resolution ?? ""}
                  onChange={(value) =>
                    onChange(index, value as "local" | "server")
                  }
                >
                  <Group grow align="flex-start">
                    <Radio
                      value="server"
                      label={
                        <Stack gap={2}>
                          <Text size="xs" fw={600}>
                            采用对方（服务端最新版本）
                          </Text>
                          <Text size="xs" c="dimmed">
                            {displayValue(conflict.serverValue)}
                          </Text>
                        </Stack>
                      }
                    />
                    <Radio
                      value="local"
                      label={
                        <Stack gap={2}>
                          <Text size="xs" fw={600} c="blue">
                            用我的覆盖
                          </Text>
                          <Text size="xs" c="dimmed">
                            {displayValue(conflict.localValue)}
                          </Text>
                        </Stack>
                      }
                    />
                  </Group>
                </Radio.Group>
              </Paper>
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="space-between">
          <Text size="xs" c={unresolved ? "red" : "teal"}>
            {unresolved ? `还有 ${unresolved} 项未确认` : "全部冲突项已确认"}
          </Text>
          <Group>
            <Button variant="default" onClick={onClose}>
              稍后处理（草稿保留）
            </Button>
            <Button
              disabled={unresolved > 0}
              loading={submitting}
              onClick={onConfirm}
            >
              确认后覆盖保存
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
};

/* ---------- 证据变化明细 ---------- */

const changeMeta: Record<
  EvidenceChange["kind"],
  { label: string; color: string }
> = {
  added: { label: "新增", color: "teal" },
  removed: { label: "移除", color: "red" },
  strength: { label: "强度差异", color: "orange" },
};

export const EvidenceChangeList = ({
  changes,
}: {
  changes: EvidenceChange[];
}) => (
  <Group gap={6}>
    {changes.map((change, index) => {
      const meta = changeMeta[change.kind];
      return (
        <Badge key={`${change.evidenceId}-${index}`} variant="light" color={meta.color}>
          {meta.label} · {change.title}
          {change.kind === "strength"
            ? `（${displayValue(change.before)} → ${displayValue(change.after)}）`
            : ""}
        </Badge>
      );
    })}
  </Group>
);

export const summarizeEvidenceDiff = (
  before: CaseBundle["evidence"],
  after: CaseBundle["evidence"],
) => diffEvidence(before, after);

/* ---------- 快照历史 ---------- */

const formatTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

export const SnapshotHistoryPanel = ({
  snapshots,
  currentRevision,
  restoring,
  onRestore,
}: {
  snapshots: CaseSnapshot[];
  currentRevision: number;
  restoring: boolean;
  onRestore: (snapshotId: string, revision: number) => void;
}) => {
  const summaryText = (summary: SnapshotSummary) =>
    describeSummary(summary).join("，");

  return (
    <Paper withBorder>
      <Group justify="space-between" p="md">
        <div>
          <Group gap={6}>
            <History size={16} />
          </Group>
          <Text fw={600} mt={4}>
            可恢复快照版本
          </Text>
          <Text size="sm" c="dimmed">
            每次保存都会把告警、案件、图谱、证据与结论固化成同一份快照，可随时恢复。
          </Text>
        </div>
      </Group>
      <Table.ScrollContainer minWidth={760}>
        <Table highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>版本</Table.Th>
              <Table.Th>保存时间 / 操作人</Table.Th>
              <Table.Th>版本摘要</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {snapshots.map((snapshot) => (
              <Table.Tr key={snapshot.id}>
                <Table.Td>
                  <Group gap={6}>
                    <Text fw={700}>R{snapshot.revision}</Text>
                    {snapshot.revision === currentRevision ? (
                      <Badge variant="light" color="teal">
                        当前
                      </Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {snapshot.source}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{formatTime(snapshot.savedAt)}</Text>
                  <Text size="xs" c="dimmed">
                    {snapshot.savedBy}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{snapshot.summary.note}</Text>
                  {summaryText(snapshot.summary) ? (
                    <Text size="xs" c="blue" mt={3}>
                      {summaryText(snapshot.summary)}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<RotateCcw size={13} />}
                    disabled={snapshot.revision === currentRevision || restoring}
                    onClick={() =>
                      onRestore(snapshot.id, snapshot.revision)
                    }
                  >
                    恢复
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
};
