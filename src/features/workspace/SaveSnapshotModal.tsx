import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@mantine/core";
import { FileWarning, Save, Send } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  CaseDisposition,
  PendingConclusion,
} from "../../models/types";
import type { PendingChanges } from "./WorkspacePanels";
import { ChangeChips } from "./WorkspacePanels";

interface SaveSnapshotModalProps {
  opened: boolean;
  changes: PendingChanges;
  defaultNote: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: (params: {
    note: string;
    conclusion?: PendingConclusion;
    simulateFailure: boolean;
  }) => void;
}

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

export const SaveSnapshotModal = ({
  opened,
  changes,
  defaultNote,
  saving,
  onClose,
  onSubmit,
}: SaveSnapshotModalProps) => {
  const [note, setNote] = useState(defaultNote);
  const [withConclusion, setWithConclusion] = useState(false);
  const [submit, setSubmit] = useState(false);
  const [disposition, setDisposition] = useState<CaseDisposition>("observe");
  const [rationale, setRationale] = useState("");
  const [riskControls, setRiskControls] = useState("");
  const [simulateFailure, setSimulateFailure] = useState(false);

  useEffect(() => {
    if (opened) {
      setNote(defaultNote);
      setWithConclusion(false);
      setSubmit(false);
      setDisposition("observe");
      setRationale("");
      setRiskControls("");
      setSimulateFailure(false);
    }
  }, [opened, defaultNote]);

  const rationaleValid = rationale.trim().length >= 12;
  const canSave =
    note.trim().length >= 4 && (!withConclusion || rationaleValid);

  const handleSubmit = () => {
    if (!canSave) {
      return;
    }
    onSubmit({
      note: note.trim(),
      conclusion: withConclusion
        ? {
            disposition,
            rationale: rationale.trim(),
            riskControls: riskControls
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
            submit,
          }
        : undefined,
      simulateFailure,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="保存统一快照（带版本摘要）"
      size="lg"
      closeOnClickOutside={false}
    >
      <Stack gap="md">
        <div>
          <Text size="xs" c="dimmed" mb={6}>
            本次将写入同一份快照的改动：
          </Text>
          <ChangeChips changes={changes} />
        </div>

        <Textarea
          label="版本摘要"
          description="随快照保存并进入审计，说明本次调查补录与调整"
          required
          minRows={2}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Checkbox
          label="本次保存同时重算并生成新的结论版本"
          checked={withConclusion}
          onChange={(event) => setWithConclusion(event.currentTarget.checked)}
        />

        {withConclusion ? (
          <Stack gap="sm">
            <Alert color="orange" variant="light" icon={<FileWarning size={16} />}>
              新结论会锚定当前台账证据；之后证据新增、移除或强度变化，该版本将自动失效并标记差异。
            </Alert>
            <Select
              label="处置建议"
              value={disposition}
              onChange={(value) =>
                setDisposition((value as CaseDisposition) ?? "observe")
              }
              data={Object.entries(dispositionLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Textarea
              label="结论依据"
              required
              description="至少 12 个字符"
              minRows={4}
              value={rationale}
              onChange={(event) => setRationale(event.currentTarget.value)}
            />
            <Textarea
              label="风险控制措施"
              description="每行一项"
              minRows={3}
              value={riskControls}
              onChange={(event) => setRiskControls(event.currentTarget.value)}
            />
            <Switch
              label="保存后直接提交复核（否则保存为草稿）"
              checked={submit}
              onChange={(event) => setSubmit(event.currentTarget.checked)}
            />
          </Stack>
        ) : null}

        <Switch
          label="演示：模拟本次保存失败（验证草稿保留与重试）"
          color="red"
          checked={simulateFailure}
          onChange={(event) => setSimulateFailure(event.currentTarget.checked)}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant={withConclusion && submit ? "filled" : "light"}
            leftSection={withConclusion && submit ? <Send size={16} /> : <Save size={16} />}
            loading={saving}
            disabled={!canSave}
            onClick={handleSubmit}
          >
            {withConclusion ? (submit ? "保存并提交复核" : "保存结论草稿") : "保存快照"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
