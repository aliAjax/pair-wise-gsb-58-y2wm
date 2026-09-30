import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Radio,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { FieldConflict } from "../../models/snapshot";

interface ConflictResolutionModalProps {
  opened: boolean;
  conflicts: FieldConflict[];
  /** 无冲突字段已自动合并的数量 */
  autoMergedCount: number;
  submitting?: boolean;
  onClose: () => void;
  /**
   * resolvedPaths：调查员确认后选择"以我的修改覆盖"的字段；
   * 未勾选的冲突字段将保留另一窗口的保存结果。
   */
  onResolve: (resolvedPaths: string[]) => void;
}

const formatValue = (value: string | number | boolean | null): string => {
  if (value === null || value === "") {
    return "（空）";
  }
  return String(value);
};

export function ConflictResolutionModal({
  opened,
  conflicts,
  autoMergedCount,
  submitting,
  onClose,
  onResolve,
}: ConflictResolutionModalProps) {
  const [overwritePaths, setOverwritePaths] = useState<string[]>([]);

  const togglePath = (path: string, overwrite: boolean) => {
    setOverwritePaths((current) =>
      overwrite
        ? Array.from(new Set([...current, path]))
        : current.filter((item) => item !== path),
    );
  };

  const handleConfirm = () => {
    onResolve(overwritePaths);
    setOverwritePaths([]);
  };

  const handleClose = () => {
    setOverwritePaths([]);
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="保存冲突：请调查员确认后覆盖"
      size="xl"
      closeOnClickOutside={false}
    >
      <Stack gap="md">
        <Alert color="orange" icon={<TriangleAlert size={16} />}>
          另一窗口已经保存过该案件。无冲突字段（
          {autoMergedCount}
          项）已自动合并；以下字段双方都修改且取值不同，请逐项选择保留哪一方。草稿已保留，确认后才会提交。
        </Alert>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>冲突项</Table.Th>
                <Table.Th>共同基线</Table.Th>
                <Table.Th>另一窗口（已保存）</Table.Th>
                <Table.Th>本窗口（我的修改）</Table.Th>
                <Table.Th w={220}>保留</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {conflicts.map((conflict) => (
                <Table.Tr key={conflict.path}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {conflict.label}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {conflict.path}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color="gray">
                      {formatValue(conflict.base)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatValue(conflict.theirs)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {formatValue(conflict.mine)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Radio.Group
                      value={
                        overwritePaths.includes(conflict.path) ? "mine" : "theirs"
                      }
                      onChange={(value) =>
                        togglePath(conflict.path, value === "mine")
                      }
                    >
                      <Stack gap={4}>
                        <Radio value="theirs" label="保留对方" size="xs" />
                        <Radio value="mine" label="以我的覆盖" size="xs" />
                      </Stack>
                    </Radio.Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose}>
            稍后处理（保留草稿）
          </Button>
          <Button loading={submitting} onClick={handleConfirm}>
            按选择完成保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
