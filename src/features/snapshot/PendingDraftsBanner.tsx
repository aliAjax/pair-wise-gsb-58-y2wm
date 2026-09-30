import {
  Alert,
  Badge,
  Button,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CloudOff, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDiscardDraftMutation,
  useGetPendingDraftsQuery,
  useRetryDraftCommitMutation,
} from "../../services/api";
import type { PendingDraft } from "../../models/snapshot";
import { ConflictResolutionModal } from "./ConflictResolutionModal";

interface PendingDraftsBannerProps {
  caseId: string;
  /** 页面挂载时已存在的草稿才自动重试/弹冲突，运行中新产生的冲突由触发操作的弹窗处理 */
  draftsAtMount: PendingDraft[];
}

/**
 * 保存失败后草稿持久保留在本地：
 * - 下次打开案件时自动重试 stage=failed 的草稿；
 * - 打开时已存在的 stage=conflict 草稿自动弹出冲突项，由调查员确认后覆盖。
 */
export function PendingDraftsBanner({
  caseId,
  draftsAtMount,
}: PendingDraftsBannerProps) {
  const { drafts } = useGetPendingDraftsQuery(caseId, {
    selectFromResult: (result) => ({
      drafts: (result.data ?? []).filter((item) => item.caseId === caseId),
    }),
  });
  const [retry, { isLoading: isRetrying }] = useRetryDraftCommitMutation();
  const [discard] = useDiscardDraftMutation();

  const mountDraftIds = useMemo(
    () => new Set(draftsAtMount.map((item) => item.draftId)),
    // 仅按挂载时的草稿集合初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [conflictDraft, setConflictDraft] = useState<PendingDraft | null>(
    null,
  );
  const autoHandledRef = useRef<Set<string>>(new Set());

  const attemptRetry = async (
    draft: PendingDraft,
    resolvedPaths?: string[],
  ) => {
    try {
      await retry({ draftId: draft.draftId, resolvedPaths }).unwrap();
      notifications.show({
        color: "teal",
        title: "草稿已提交",
        message: `草稿「${draft.request.description}」已合并进最新快照。`,
      });
      setConflictDraft((current) =>
        current?.draftId === draft.draftId ? null : current,
      );
    } catch (error) {
      const apiError = error as {
        conflicts?: PendingDraft["conflicts"];
        autoMerged?: number;
        error?: string;
      };
      if (apiError?.conflicts && apiError.conflicts.length > 0) {
        // 重试时发现另一方已保存：弹出冲突确认
        setConflictDraft({
          ...draft,
          conflicts: apiError.conflicts,
          autoMerged: apiError.autoMerged,
          stage: "conflict",
        });
      } else {
        notifications.show({
          color: "red",
          title: "草稿仍未提交",
          message: apiError?.error ?? "保存仍失败，草稿继续保留，可稍后重试。",
        });
      }
    }
  };

  // 下次打开时自动重试：只处理挂载时就存在的草稿（每个草稿一次）
  useEffect(() => {
    for (const draft of drafts) {
      if (!mountDraftIds.has(draft.draftId)) {
        continue;
      }
      if (autoHandledRef.current.has(draft.draftId)) {
        continue;
      }
      autoHandledRef.current.add(draft.draftId);
      if (draft.stage === "failed") {
        void attemptRetry(draft);
      } else if (draft.stage === "conflict") {
        setConflictDraft(draft);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, mountDraftIds]);

  if (drafts.length === 0) {
    return null;
  }

  // 冲突数据以最新查询结果为准（重试失败后草稿中的冲突清单会刷新）
  const activeConflict =
    conflictDraft &&
    (drafts.find((item) => item.draftId === conflictDraft.draftId) ??
      conflictDraft);

  return (
    <Stack gap="sm">
      {drafts.map((draft) => (
        <Alert
          key={draft.draftId}
          color={draft.stage === "conflict" ? "orange" : "red"}
          icon={
            draft.stage === "conflict" ? (
              <TriangleAlert size={16} />
            ) : (
              <CloudOff size={16} />
            )
          }
          title={
            draft.stage === "conflict"
              ? `存在 ${draft.conflicts?.length ?? 0} 个冲突项，等待确认`
              : "保存失败，草稿已保留"
          }
        >
          <Stack gap="xs">
            <Text size="sm">{draft.reason}</Text>
            <Group gap="xs">
              <Badge variant="light" color="gray">
                {draft.request.description}
              </Badge>
              <Text size="xs" c="dimmed">
                已尝试 {draft.attempts} 次 · 最近{" "}
                {new Date(draft.lastAttemptAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </Text>
            </Group>
            <Group>
              {draft.stage === "conflict" ? (
                <Button
                  size="xs"
                  leftSection={<TriangleAlert size={14} />}
                  loading={isRetrying}
                  onClick={() => setConflictDraft(draft)}
                >
                  逐项确认冲突
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<RotateCw size={14} />}
                  loading={isRetrying}
                  onClick={() => void attemptRetry(draft)}
                >
                  立即重试
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<Trash2 size={14} />}
                onClick={() => {
                  void discard(draft.draftId);
                  autoHandledRef.current.delete(draft.draftId);
                  setConflictDraft((current) =>
                    current?.draftId === draft.draftId ? null : current,
                  );
                }}
              >
                放弃草稿
              </Button>
            </Group>
          </Stack>
        </Alert>
      ))}

      <ConflictResolutionModal
        opened={activeConflict !== null}
        conflicts={activeConflict?.conflicts ?? []}
        autoMergedCount={activeConflict?.autoMerged ?? 0}
        submitting={isRetrying}
        onClose={() => setConflictDraft(null)}
        onResolve={(resolvedPaths) => {
          if (activeConflict) {
            void attemptRetry(activeConflict, resolvedPaths);
          }
        }}
      />
    </Stack>
  );
}
