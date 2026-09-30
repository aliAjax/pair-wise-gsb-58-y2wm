import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { History, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { SnapshotSaveKind } from "../../models/types";
import type { SnapshotHistoryEntry } from "../../models/snapshot";
import {
  summarizeKinds,
  useRestoreSnapshotRevisionMutation,
} from "../../services/api";

const kindColors: Record<SnapshotSaveKind, string> = {
  graph: "cyan",
  evidence: "teal",
  conclusion: "violet",
  alerts: "blue",
  case: "gray",
  review: "orange",
  restore: "grape",
};

interface SnapshotHistoryPanelProps {
  caseId: string;
  currentRevision: number;
  history: SnapshotHistoryEntry[];
}

export function SnapshotHistoryPanel({
  caseId,
  currentRevision,
  history,
}: SnapshotHistoryPanelProps) {
  const [restore, { isLoading }] = useRestoreSnapshotRevisionMutation();
  const [target, setTarget] = useState<SnapshotHistoryEntry | null>(null);

  const handleRestore = async () => {
    if (!target) {
      return;
    }
    try {
      await restore({ caseId, revision: target.revision }).unwrap();
      notifications.show({
        color: "grape",
        title: "快照已恢复",
        message: `已基于 V${target.revision} 生成新版本，告警、图谱、证据与结论一并回退，原历史仍保留。`,
      });
      setTarget(null);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "恢复失败",
        message:
          typeof error === "object" && error && "error" in error
            ? String(error.error)
            : "恢复失败，请重试。",
      });
    }
  };

  return (
    <Paper withBorder>
      <Group justify="space-between" p="md">
        <div>
          <Text fw={600}>可恢复快照</Text>
          <Text size="sm" c="dimmed">
            每次保存都带版本摘要，旧版本在重启后仍可查看并恢复。
          </Text>
        </div>
        <Badge variant="light" color="grape" size="lg">
          当前 V{currentRevision}
        </Badge>
      </Group>
      <Divider />
      <ScrollArea.Autosize mah={420}>
        <Stack gap={0}>
          {history.map((entry, index) => (
            <div key={entry.revision}>
              {index > 0 ? <Divider /> : null}
              <Stack gap={6} p="md">
                <Group justify="space-between">
                  <Group gap="xs">
                    <History size={15} />
                    <Text fw={700}>V{entry.revision}</Text>
                    {entry.revision === currentRevision ? (
                      <Badge variant="light" color="teal">
                        当前版本
                      </Badge>
                    ) : (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="grape"
                        leftSection={<RotateCcw size={12} />}
                        loading={isLoading && target?.revision === entry.revision}
                        onClick={() => setTarget(entry)}
                      >
                        恢复此版本
                      </Button>
                    )}
                    {entry.restoredFromRevision !== undefined ? (
                      <Badge variant="outline" color="grape">
                        恢复自 V{entry.restoredFromRevision}
                      </Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {entry.actor} ·{" "}
                    {new Date(entry.at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </Text>
                </Group>
                <Group gap={6}>
                  {entry.kinds.map((kind) => (
                    <Badge key={kind} variant="dot" color={kindColors[kind]}>
                      {summarizeKinds([kind])}
                    </Badge>
                  ))}
                </Group>
                <Text size="sm">{entry.label}</Text>
                <Group gap={6}>
                  {entry.stats.nodesAdded > 0 && (
                    <Badge variant="light" color="gray">
                      节点 +{entry.stats.nodesAdded}
                    </Badge>
                  )}
                  {entry.stats.edgesAdded > 0 && (
                    <Badge variant="light" color="gray">
                      关系 +{entry.stats.edgesAdded}
                    </Badge>
                  )}
                  {entry.stats.evidenceAdded > 0 && (
                    <Badge variant="light" color="teal">
                      证据 +{entry.stats.evidenceAdded}
                    </Badge>
                  )}
                  {entry.stats.evidenceRemoved > 0 && (
                    <Badge variant="light" color="red">
                      证据 -{entry.stats.evidenceRemoved}
                    </Badge>
                  )}
                  {entry.stats.evidenceChanged > 0 && (
                    <Badge variant="light" color="orange">
                      强度调整 {entry.stats.evidenceChanged}
                    </Badge>
                  )}
                  {entry.stats.conclusionsAdded > 0 && (
                    <Badge variant="light" color="violet">
                      结论 +{entry.stats.conclusionsAdded}
                    </Badge>
                  )}
                  {entry.stats.alertsLinked > 0 && (
                    <Badge variant="light" color="blue">
                      告警 +{entry.stats.alertsLinked}
                    </Badge>
                  )}
                  {entry.stats.conclusionsInvalidated > 0 && (
                    <Badge variant="light" color="red">
                      旧结论失效 {entry.stats.conclusionsInvalidated}
                    </Badge>
                  )}
                  {entry.stats.autoMerged > 0 && (
                    <Badge variant="light" color="cyan">
                      自动合入 {entry.stats.autoMerged}
                    </Badge>
                  )}
                  {entry.stats.conflictsResolved > 0 && (
                    <Badge variant="light" color="grape">
                      冲突覆盖 {entry.stats.conflictsResolved}
                    </Badge>
                  )}
                </Group>
              </Stack>
            </div>
          ))}
        </Stack>
      </ScrollArea.Autosize>

      <Modal
        opened={target !== null}
        onClose={() => setTarget(null)}
        title="恢复案件快照"
      >
        <Stack gap="md">
          <Alert color="grape">
            将以 V{target?.revision}（{target?.label}
            ）为内容生成一个新版本，告警、案件信息、关系图谱、证据台账和结论版本会一并回退到该快照；历史版本不会被删除。
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button color="grape" loading={isLoading} onClick={handleRestore}>
              确认恢复
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
