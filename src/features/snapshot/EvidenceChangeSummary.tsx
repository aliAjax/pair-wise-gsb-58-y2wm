import { Badge, Group, List, Stack, Text } from "@mantine/core";
import { MinusCircle, PlusCircle, RefreshCw } from "lucide-react";
import type { EvidenceChangeSet } from "../../models/types";
import { EvidenceStrengthBadge } from "../../components/Badges";

interface EvidenceChangeSummaryProps {
  changeSet: EvidenceChangeSet;
  compact?: boolean;
}

/** 旧结论失效时列出新增、移除和强度差异，供调查员重算结论 */
export function EvidenceChangeSummary({
  changeSet,
  compact,
}: EvidenceChangeSummaryProps) {
  const { added, removed, changed } = changeSet;
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        证据台账与该版本基线一致。
      </Text>
    );
  }

  return (
    <Stack gap={compact ? 4 : "xs"}>
      {added.length > 0 ? (
        <div>
          <Group gap={6}>
            <PlusCircle size={14} color="var(--mantine-color-teal-7)" />
            <Text size="xs" fw={700} c="teal">
              新增证据 {added.length}
            </Text>
          </Group>
          <List size="xs" pl={22} mt={2}>
            {added.map((item) => (
              <List.Item key={item.id}>
                <Group gap={6}>
                  <Text span>{item.title}</Text>
                  <EvidenceStrengthBadge value={item.strength} />
                </Group>
              </List.Item>
            ))}
          </List>
        </div>
      ) : null}

      {removed.length > 0 ? (
        <div>
          <Group gap={6}>
            <MinusCircle size={14} color="var(--mantine-color-red-7)" />
            <Text size="xs" fw={700} c="red">
              移除证据 {removed.length}
            </Text>
          </Group>
          <List size="xs" pl={22} mt={2}>
            {removed.map((item) => (
              <List.Item key={item.id}>
                <Group gap={6}>
                  <Text span td="line-through" c="dimmed">
                    {item.title}
                  </Text>
                  <Badge variant="light" color="gray">
                    原 {item.strength === "strong" ? "强" : item.strength === "medium" ? "中" : "弱"}
                  </Badge>
                </Group>
              </List.Item>
            ))}
          </List>
        </div>
      ) : null}

      {changed.length > 0 ? (
        <div>
          <Group gap={6}>
            <RefreshCw size={14} color="var(--mantine-color-orange-7)" />
            <Text size="xs" fw={700} c="orange">
              强度差异 {changed.length}
            </Text>
          </Group>
          <List size="xs" pl={22} mt={2}>
            {changed.map((item) => (
              <List.Item key={item.id}>
                <Group gap={6}>
                  <Text span>{item.title}：</Text>
                  <EvidenceStrengthBadge value={item.before} />
                  <Text span c="dimmed">
                    →
                  </Text>
                  <EvidenceStrengthBadge value={item.after} />
                </Group>
              </List.Item>
            ))}
          </List>
        </div>
      ) : null}
    </Stack>
  );
}
