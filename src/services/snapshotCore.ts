import type {
  CaseBundle,
  CaseEditableField,
  ConclusionVersion,
  Evidence,
  EvidenceChange,
  EvidenceStrength,
  SnapshotSummary,
  WorkspaceConflict,
} from "../models/types";
import { CASE_EDITABLE_FIELDS } from "../models/types";

/* ---------- 稳定序列化与通用比对 ---------- */

export const stableStringify = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === "object") {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

export const sameData = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

/* ---------- 证据指纹与变化 ---------- */

export const evidenceFingerprint = (item: Evidence): string =>
  `${item.id}|${item.title}|${item.source}|${item.strength}|${item.occurredAt}|${item.attachment}`;

export const evidenceSignature = (items: Evidence[]): string[] =>
  items
    .map(evidenceFingerprint)
    .sort((a, b) => a.localeCompare(b));

export const diffEvidence = (
  before: Evidence[],
  after: Evidence[],
): EvidenceChange[] => {
  const beforeMap = new Map(before.map((item) => [item.id, item]));
  const afterMap = new Map(after.map((item) => [item.id, item]));
  const changes: EvidenceChange[] = [];

  afterMap.forEach((item, id) => {
    const old = beforeMap.get(id);
    if (!old) {
      changes.push({
        kind: "added",
        evidenceId: id,
        title: item.title,
        after: item.strength,
      });
    } else if (old.strength !== item.strength) {
      changes.push({
        kind: "strength",
        evidenceId: id,
        title: item.title,
        before: old.strength,
        after: item.strength,
      });
    }
  });

  beforeMap.forEach((item, id) => {
    if (!afterMap.has(id)) {
      changes.push({
        kind: "removed",
        evidenceId: id,
        title: item.title,
        before: item.strength,
      });
    }
  });

  return changes;
};

/* ---------- 失效判定 ---------- */

export const isActiveConclusion = (item: ConclusionVersion): boolean =>
  item.status === "draft" || item.status === "submitted";

/**
 * 台账证据相对结论创建时的锚定指纹发生变化时，返回需要失效的结论。
 * 旧种子结论没有指纹时按“无变化”处理，避免历史数据被误判。
 */
export const findStaleConclusions = (
  conclusions: ConclusionVersion[],
  evidence: Evidence[],
): { conclusion: ConclusionVersion; changes: EvidenceChange[] }[] => {
  const evidenceMap = new Map(evidence.map((item) => [item.id, item]));
  const result: { conclusion: ConclusionVersion; changes: EvidenceChange[] }[] =
    [];

  conclusions.forEach((item) => {
    if (!isActiveConclusion(item) || !item.evidenceSignature) {
      return;
    }
    const changes: EvidenceChange[] = [];
    item.evidenceSignature.forEach((token) => {
      const [id, title, , strength] = token.split("|");
      const current = evidenceMap.get(id);
      if (!current) {
        changes.push({
          kind: "removed",
          evidenceId: id,
          title,
          before: strength as EvidenceStrength,
        });
      } else if (current.strength !== strength) {
        changes.push({
          kind: "strength",
          evidenceId: id,
          title: current.title,
          before: strength as EvidenceStrength,
          after: current.strength,
        });
      }
    });
    evidence.forEach((current) => {
      if (!item.evidenceSignature?.some((token) => token.startsWith(`${current.id}|`))) {
        changes.push({
          kind: "added",
          evidenceId: current.id,
          title: current.title,
          after: current.strength,
        });
      }
    });
    if (changes.length > 0) {
      result.push({ conclusion: item, changes });
    }
  });

  return result;
};

/* ---------- 版本摘要 ---------- */

export const buildSnapshotSummary = (
  base: CaseBundle | undefined,
  next: CaseBundle,
  invalidated: ConclusionVersion[],
  note: string,
): SnapshotSummary => {
  const baseNodeIds = new Set(base?.nodes.map((item) => item.id) ?? []);
  const baseEdgeIds = new Set(base?.edges.map((item) => item.id) ?? []);
  const baseEvidenceIds = new Set(base?.evidence.map((item) => item.id) ?? []);
  const baseAlertIds = new Set(base?.alertIds ?? []);
  const nextNodeIds = new Set(next.nodes.map((item) => item.id));
  const nextEdgeIds = new Set(next.edges.map((item) => item.id));
  const nextEvidenceIds = new Set(next.evidence.map((item) => item.id));
  const nextAlertIds = new Set(next.alertIds);

  const baseEvidenceMap = new Map(
    base?.evidence.map((item) => [item.id, item]) ?? [],
  );

  return {
    note,
    added: {
      nodes: next.nodes.filter((item) => !baseNodeIds.has(item.id)).length,
      edges: next.edges.filter((item) => !baseEdgeIds.has(item.id)).length,
      evidence: next.evidence.filter((item) => !baseEvidenceIds.has(item.id))
        .length,
      alerts: next.alertIds.filter((id) => !baseAlertIds.has(id)).length,
      conclusions:
        (base
          ? next.conclusions.length - base.conclusions.length
          : next.conclusions.length) > 0
          ? next.conclusions.length - (base?.conclusions.length ?? 0)
          : 0,
    },
    removed: {
      nodes: base ? [...baseNodeIds].filter((id) => !nextNodeIds.has(id)).length : 0,
      edges: base ? [...baseEdgeIds].filter((id) => !nextEdgeIds.has(id)).length : 0,
      evidence: base
        ? [...baseEvidenceIds].filter((id) => !nextEvidenceIds.has(id)).length
        : 0,
      alerts: base
        ? [...baseAlertIds].filter((id) => !nextAlertIds.has(id)).length
        : 0,
    },
    strengthChanged: next.evidence.filter(
      (item) =>
        baseEvidenceMap.has(item.id) &&
        baseEvidenceMap.get(item.id)?.strength !== item.strength,
    ).length,
    invalidatedConclusions: invalidated.map((item) => item.id),
  };
};

export const describeSummary = (summary: SnapshotSummary): string[] => {
  const parts: string[] = [];
  const push = (text: string) => parts.push(text);
  if (summary.added.alerts) push(`关联告警 +${summary.added.alerts}`);
  if (summary.removed.alerts) push(`移除告警 -${summary.removed.alerts}`);
  if (summary.added.nodes) push(`图谱节点 +${summary.added.nodes}`);
  if (summary.removed.nodes) push(`移除节点 -${summary.removed.nodes}`);
  if (summary.added.edges) push(`关系 +${summary.added.edges}`);
  if (summary.removed.edges) push(`移除关系 -${summary.removed.edges}`);
  if (summary.added.evidence) push(`证据 +${summary.added.evidence}`);
  if (summary.removed.evidence) push(`移除证据 -${summary.removed.evidence}`);
  if (summary.strengthChanged)
    push(`证据强度调整 ${summary.strengthChanged} 项`);
  if (summary.added.conclusions) push(`新结论 V${"+"}${summary.added.conclusions}`);
  if (summary.invalidatedConclusions.length)
    push(`失效结论 ${summary.invalidatedConclusions.length} 份`);
  return parts;
};

/* ---------- 字段展平与中文标签 ---------- */

type FlatValue = string | number | boolean | null;

export const flattenEntity = (
  value: unknown,
  prefix = "",
): Record<string, FlatValue> => {
  const result: Record<string, FlatValue> = {};
  if (value === null || typeof value !== "object") {
    return result;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) {
      result[path] = raw as FlatValue;
    } else if (typeof raw === "object") {
      Object.assign(result, flattenEntity(raw, path));
    }
  });
  return result;
};

export const fieldLabel = (scope: string, field: string): string => {
  const key = field.split(".").pop() ?? field;
  const maps: Record<string, Record<string, string>> = {
    case: {
      title: "案件标题",
      summary: "案件摘要",
      owner: "负责人",
      riskLevel: "风险等级",
      nextReviewAt: "下次复核时间",
    },
    nodes: {
      label: "节点名称",
      kind: "节点类型",
      riskLevel: "风险等级",
      note: "节点说明",
      evidenceStrength: "证据强度",
      source: "证据来源",
      occurredAt: "发生时间",
      position: "布局位置",
    },
    edges: {
      kind: "关系类型",
      label: "关系名称",
      amount: "关联金额",
      occurredAt: "发生时间",
      explanation: "关系解释",
      source: "起点",
      target: "终点",
    },
    evidence: {
      title: "证据名称",
      source: "证据来源",
      strength: "证据强度",
      occurredAt: "发生时间",
      attachment: "附件标识",
      note: "证据说明",
    },
  };
  return maps[scope]?.[key] ?? field;
};

export const displayValue = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "（空）";
  if (typeof value === "object") return JSON.stringify(value);
  const riskLabels: Record<string, string> = {
    high: "高风险",
    medium: "中风险/中等",
    low: "低风险",
    strong: "强证据",
    weak: "弱证据",
  };
  return riskLabels[String(value)] ?? String(value);
};

/* ---------- 三方合并 ---------- */

interface ReconcileResult {
  merged: CaseBundle;
  conflicts: WorkspaceConflict[];
  autoMerged: WorkspaceConflict[];
}

type CollectionKey = "nodes" | "edges" | "evidence";

interface CollectionItemMap {
  nodes: CaseBundle["nodes"][number];
  edges: CaseBundle["edges"][number];
  evidence: CaseBundle["evidence"][number];
}

const reconcileCaseFields = (
  base: CaseBundle,
  server: CaseBundle,
  local: CaseBundle,
  conflicts: WorkspaceConflict[],
  autoMerged: WorkspaceConflict[],
): CaseBundle["case"] => {
  const mergedCase = { ...server.case };
  CASE_EDITABLE_FIELDS.forEach((field: CaseEditableField) => {
    const b = base.case[field];
    const s = server.case[field];
    const l = local.case[field];
    if (sameData(b, l)) {
      mergedCase[field] = s as never;
    } else if (sameData(b, s) || sameData(s, l)) {
      mergedCase[field] = l as never;
      if (!sameData(b, s) && sameData(s, l)) {
        autoMerged.push({
          scope: "case",
          field,
          label: fieldLabel("case", field),
          kind: "field",
          baseValue: b,
          serverValue: s,
          localValue: l,
        });
      }
    } else {
      conflicts.push({
        scope: "case",
        field,
        label: fieldLabel("case", field),
        kind: "field",
        baseValue: b,
        serverValue: s,
        localValue: l,
      });
    }
  });
  return mergedCase;
};

const reconcileCollection = <K extends CollectionKey>(
  key: K,
  base: CaseBundle,
  server: CaseBundle,
  local: CaseBundle,
  conflicts: WorkspaceConflict[],
  autoMerged: WorkspaceConflict[],
): CollectionItemMap[K][] => {
  const baseList = base[key] as CollectionItemMap[K][];
  const serverList = server[key] as CollectionItemMap[K][];
  const localList = local[key] as CollectionItemMap[K][];
  type Item = CollectionItemMap[K];
  const baseMap = new Map<string, Item>(baseList.map((item) => [item.id, item]));
  const serverMap = new Map<string, Item>(
    serverList.map((item) => [item.id, item]),
  );
  const localMap = new Map<string, Item>(
    localList.map((item) => [item.id, item]),
  );

  const order: string[] = [];
  serverList.forEach((item) => order.push(item.id));
  localList.forEach((item) => {
    if (!order.includes(item.id)) order.push(item.id);
  });

  const merged: Item[] = [];
  order.forEach((id) => {
    const b = baseMap.get(id);
    const s = serverMap.get(id);
    const l = localMap.get(id);

    // 新增实体的三方协调
    if (!b) {
      if (s && l) {
        if (sameData(s, l)) {
          merged.push(s);
        } else {
          // 双方各自新增了同 id 实体：逐字段协调
          const mergedItem = reconcileNewEntity(
            key,
            id,
            s,
            l,
            conflicts,
            autoMerged,
          );
          merged.push(mergedItem);
        }
      } else {
        // 仅一方新增，无冲突直接合并
        merged.push((s ?? l) as Item);
        if (s && !l) {
          autoMerged.push({
            scope: key,
            id,
            field: "*",
            label: `对方新增：${entityName(key, s)}`,
            kind: "field",
            serverValue: entityName(key, s),
          });
        }
      }
      return;
    }

    if (!s && !l) {
      return;
    }
    if (s && !l) {
      merged.push(s);
      return;
    }
    if (!s && l) {
      // 对方删除、本方保留/修改
      const locallyChanged = !sameData(b, l);
      conflicts.push({
        scope: key,
        id,
        field: "*",
        label: entityName(key, l as Item),
        kind: locallyChanged ? "removed-modified" : "removed-added",
        baseValue: entityName(key, b as Item),
        serverValue: "（对方已删除）",
        localValue: locallyChanged ? "（本方已修改并保留）" : "（本方保留）",
      });
      return;
    }

    // 实体在三方都存在：逐字段协调
    const mergedItem = reconcileExistingEntity(
      key,
      id,
      b as Item,
      s as Item,
      l as Item,
      conflicts,
      autoMerged,
    );
    merged.push(mergedItem);
  });

  return merged;
};

const IGNORED_FIELDS = new Set(["id", "caseId"]);

const reconcileExistingEntity = <T extends { id: string }>(
  scope: CollectionKey,
  id: string,
  base: T,
  server: T,
  local: T,
  conflicts: WorkspaceConflict[],
  autoMerged: WorkspaceConflict[],
): T => {
  const flatBase = flattenEntity(base);
  const flatServer = flattenEntity(server);
  const flatLocal = flattenEntity(local);
  const fields = Array.from(
    new Set([
      ...Object.keys(flatBase),
      ...Object.keys(flatServer),
      ...Object.keys(flatLocal),
    ]),
  ).filter((field) => !IGNORED_FIELDS.has(field.split(".")[0]));

  let merged: T = { ...server };

  fields.forEach((field) => {
    const b = flatBase[field];
    const s = flatServer[field];
    const l = flatLocal[field];
    if (stableStringify(b) === stableStringify(l)) {
      return; // 本方未改，沿用服务端
    }
    if (
      stableStringify(b) === stableStringify(s) ||
      stableStringify(s) === stableStringify(l)
    ) {
      merged = setDeepValue(merged, field, l);
      if (stableStringify(b) !== stableStringify(s)) {
        autoMerged.push({
          scope,
          id,
          field,
          label: `${entityName(scope, server)} · ${fieldLabel(scope, field)}`,
          kind: "field",
          baseValue: b,
          serverValue: s,
          localValue: l,
        });
      }
    } else {
      conflicts.push({
        scope,
        id,
        field,
        label: `${entityName(scope, server)} · ${fieldLabel(scope, field)}`,
        kind: "field",
        baseValue: b,
        serverValue: s,
        localValue: l,
      });
    }
  });

  return merged;
};

const reconcileNewEntity = <T extends { id: string }>(
  scope: CollectionKey,
  id: string,
  server: T,
  local: T,
  conflicts: WorkspaceConflict[],
  autoMerged: WorkspaceConflict[],
): T => {
  const flatServer = flattenEntity(server);
  const flatLocal = flattenEntity(local);
  const fields = Array.from(
    new Set([...Object.keys(flatServer), ...Object.keys(flatLocal)]),
  ).filter((field) => !IGNORED_FIELDS.has(field.split(".")[0]));

  let merged: T = { ...server };
  fields.forEach((field) => {
    const s = flatServer[field];
    const l = flatLocal[field];
    if (stableStringify(s) === stableStringify(l)) {
      return;
    }
    conflicts.push({
      scope,
      id,
      field,
      label: `${entityName(scope, server)} · ${fieldLabel(scope, field)}`,
      kind: "field",
      serverValue: s,
      localValue: l,
    });
  });
  void autoMerged;
  return merged;
};

const setDeepValue = <T>(target: T, path: string, value: unknown): T => {
  const keys = path.split(".");
  const clone: Record<string, unknown> = structuredClone(
    target as Record<string, unknown>,
  );
  let cursor = clone;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = { ...(cursor[key] as Record<string, unknown>) };
      cursor = cursor[key] as Record<string, unknown>;
    }
  });
  return clone as T;
};

const getDeepValue = (target: unknown, path: string): unknown => {
  const keys = path.split(".");
  let cursor: unknown = target;
  for (const key of keys) {
    if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cursor;
};

export const entityName = (scope: string, item: unknown): string => {
  if (!item || typeof item !== "object") return scope;
  const record = item as Record<string, unknown>;
  const data = (record.data ?? {}) as Record<string, unknown>;
  if (scope === "nodes") return String(data.label ?? record.id);
  if (scope === "edges") return String(record.label ?? record.id);
  if (scope === "evidence") return String(record.title ?? record.id);
  return String(record.id ?? scope);
};

/**
 * 三方合并：无冲突字段自动合入（包括对方窗口新增的实体），
 * 真正冲突的字段返回供调查员逐项确认。
 * alertIds 采用集合合并，不会覆盖对方刚补的告警关联。
 */
export const reconcileBundles = (
  base: CaseBundle,
  server: CaseBundle,
  local: CaseBundle,
): ReconcileResult => {
  const conflicts: WorkspaceConflict[] = [];
  const autoMerged: WorkspaceConflict[] = [];

  const mergedCase = reconcileCaseFields(
    base,
    server,
    local,
    conflicts,
    autoMerged,
  );
  const nodes = reconcileCollection(
    "nodes",
    base,
    server,
    local,
    conflicts,
    autoMerged,
  );
  const edges = reconcileCollection(
    "edges",
    base,
    server,
    local,
    conflicts,
    autoMerged,
  );
  const evidence = reconcileCollection(
    "evidence",
    base,
    server,
    local,
    conflicts,
    autoMerged,
  );
  const conclusions = [...server.conclusions];

  // 告警关联：双方新增取并集；一方删除而另一方未改动时遵从删除
  const baseAlerts = new Set(base.alertIds);
  const cleanAlertIds: string[] = [];
  server.alertIds.forEach((id) => {
    const locallyRemoved = baseAlerts.has(id) && !local.alertIds.includes(id);
    if (!locallyRemoved) cleanAlertIds.push(id);
  });
  local.alertIds.forEach((id) => {
    if (!cleanAlertIds.includes(id)) cleanAlertIds.push(id);
  });

  const merged: CaseBundle = {
    case: { ...mergedCase, alertIds: cleanAlertIds },
    alertIds: cleanAlertIds,
    nodes,
    edges,
    evidence,
    conclusions,
  };

  return { merged, conflicts, autoMerged };
};

/**
 * 调查员对冲突逐项选择后，按选择重算合并结果。
 * resolution 为 "local" 时用本方值覆盖，"server" 时保留服务端值。
 */
export const applyConflictResolutions = (
  base: CaseBundle,
  server: CaseBundle,
  local: CaseBundle,
  resolved: WorkspaceConflict[],
): { bundle: CaseBundle; unresolved: WorkspaceConflict[] } => {
  const result = reconcileBundles(base, server, local);
  const unresolved = result.conflicts.filter(
    (conflict) =>
      !resolved.some(
        (item) =>
          item.scope === conflict.scope &&
          item.id === conflict.id &&
          item.field === conflict.field,
      ),
  );

  if (unresolved.length > 0) {
    return { bundle: result.merged, unresolved };
  }

  let merged: CaseBundle = structuredClone(result.merged);

  resolved.forEach((resolution) => {
    const choice = resolution.resolution;
    if (resolution.scope === "case") {
      if (choice === "local") {
        const updated = setDeepValue(
          merged.case,
          resolution.field,
          local.case[resolution.field as keyof CaseBundle["case"]],
        );
        merged = { ...merged, case: { ...updated, alertIds: merged.alertIds } };
      }
      return;
    }

    const collectionKey = resolution.scope as CollectionKey;
    const id = resolution.id ?? "";
    const localEntity = local[collectionKey].find((item) => item.id === id);
    const serverEntity = server[collectionKey].find((item) => item.id === id);

    if (resolution.field === "*") {
      // 删除/保留类冲突
      const list = merged[collectionKey];
      const exists = list.some((item) => item.id === id);
      if (choice === "local") {
        if (!exists && localEntity) {
          (list as { id: string }[]).push(localEntity as { id: string });
        }
      } else if (exists) {
        merged = {
          ...merged,
          [collectionKey]: list.filter((item) => item.id !== id),
        } as CaseBundle;
      }
      return;
    }

    const source = choice === "local" ? localEntity : serverEntity;
    if (!source) return;
    merged = {
      ...merged,
      [collectionKey]: merged[collectionKey].map((item) =>
        item.id === id
          ? setDeepValue(item, resolution.field, getDeepValue(source, resolution.field))
          : item,
      ),
    } as CaseBundle;
  });

  return { bundle: merged, unresolved: [] };
};
