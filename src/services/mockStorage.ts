import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../data/seed";
import type {
  Alert,
  AuditLog,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
} from "../models/types";
import type {
  CaseRecordMap,
  CaseSnapshot,
  PendingDraft,
} from "../models/snapshot";
import {
  DATABASE_STORAGE_KEY,
  DRAFTS_STORAGE_KEY,
  FAIL_FLAG_STORAGE_KEY,
  LEGACY_DATABASE_STORAGE_KEY,
} from "./storageKeys";

export interface MockDatabase {
  /** 全局告警台账（告警中心页面仍按全量读取） */
  alerts: Alert[];
  /** 案件级可恢复快照：告警/案件/图谱/证据/结论全部在内 */
  snapshots: CaseRecordMap;
  auditLogs: AuditLog[];
}

const STORAGE_KEY = DATABASE_STORAGE_KEY;
const LEGACY_STORAGE_KEY = LEGACY_DATABASE_STORAGE_KEY;

const evidenceFingerprint = (evidence: Evidence[]) =>
  evidence
    .map((item) => ({
      id: item.id,
      title: item.title,
      strength: item.strength,
      version: item.version,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

const buildSnapshotForCase = (
  investigationCase: InvestigationCase,
  all: {
    alerts: Alert[];
    nodes: CaseSnapshot["nodes"];
    edges: CaseSnapshot["edges"];
    evidence: Evidence[];
    conclusions: ConclusionVersion[];
  },
): CaseSnapshot => ({
  case: investigationCase,
  nodes: all.nodes.filter((item) => item.caseId === investigationCase.id),
  edges: all.edges.filter((item) => item.caseId === investigationCase.id),
  evidence: all.evidence.filter((item) => item.caseId === investigationCase.id),
  conclusions: all.conclusions
    .filter((item) => item.caseId === investigationCase.id)
    .sort((a, b) => b.version - a.version),
  alerts: all.alerts.filter((item) => item.caseId === investigationCase.id),
});

/** 种子结论缺少指纹字段，首次迁移时按当时证据补齐 */
const withFingerprint = (
  conclusions: ConclusionVersion[],
  evidence: Evidence[],
): ConclusionVersion[] =>
  conclusions.map((item) => ({
    ...item,
    evidenceFingerprint:
      item.evidenceFingerprint ??
      evidenceFingerprint(
        evidence.filter((entry) => entry.caseId === item.caseId),
      ),
    baseRevision: item.baseRevision ?? 1,
  }));

const createSeedDatabase = (): MockDatabase => {
  const alerts = structuredClone(seedAlerts);
  const cases = structuredClone(seedCases);
  const nodes = structuredClone(seedNodes);
  const edges = structuredClone(seedEdges);
  const evidence = structuredClone(seedEvidence);
  const conclusions = withFingerprint(
    structuredClone(seedConclusions),
    evidence,
  );

  const snapshots: CaseRecordMap = {};
  for (const investigationCase of cases) {
    const initialSnapshot = buildSnapshotForCase(investigationCase, {
      alerts,
      nodes,
      edges,
      evidence,
      conclusions,
    });
    snapshots[investigationCase.id] = {
      caseId: investigationCase.id,
      revision: 1,
      snapshot: structuredClone(initialSnapshot),
      history: [
        {
          revision: 1,
          at: investigationCase.updatedAt,
          actor: "系统",
          kinds: ["case"],
          label: "初始快照：案件建立并写入演示数据",
          description: "告警、关系图谱、证据台账与结论基线已纳入同一份快照。",
          snapshot: initialSnapshot,
          stats: {
            nodesAdded: nodes.filter((item) => item.caseId === investigationCase.id)
              .length,
            edgesAdded: edges.filter((item) => item.caseId === investigationCase.id)
              .length,
            evidenceAdded: evidence.filter(
              (item) => item.caseId === investigationCase.id,
            ).length,
            evidenceChanged: 0,
            evidenceRemoved: 0,
            conclusionsAdded: conclusions.filter(
              (item) => item.caseId === investigationCase.id,
            ).length,
            alertsLinked: alerts.filter(
              (item) => item.caseId === investigationCase.id,
            ).length,
            autoMerged: 0,
            conflictsResolved: 0,
            conclusionsInvalidated: 0,
          },
        },
      ],
    };
  }

  return {
    alerts,
    snapshots,
    auditLogs: structuredClone(seedAuditLogs),
  };
};

interface LegacyDatabase {
  alerts?: Alert[];
  cases?: InvestigationCase[];
  nodes?: CaseSnapshot["nodes"];
  edges?: CaseSnapshot["edges"];
  evidence?: Evidence[];
  conclusions?: ConclusionVersion[];
  auditLogs?: AuditLog[];
}

const migrateLegacyDatabase = (legacy: LegacyDatabase): MockDatabase => {
  const alerts = legacy.alerts ?? [];
  const cases = legacy.cases ?? [];
  const nodes = legacy.nodes ?? [];
  const edges = legacy.edges ?? [];
  const evidence = legacy.evidence ?? [];
  const conclusions = withFingerprint(legacy.conclusions ?? [], evidence);

  const snapshots: CaseRecordMap = {};
  for (const investigationCase of cases) {
    const migratedSnapshot = buildSnapshotForCase(investigationCase, {
      alerts,
      nodes,
      edges,
      evidence,
      conclusions,
    });
    snapshots[investigationCase.id] = {
      caseId: investigationCase.id,
      revision: 1,
      snapshot: structuredClone(migratedSnapshot),
      history: [
        {
          revision: 1,
          at: investigationCase.updatedAt,
          actor: "系统",
          kinds: ["case"],
          label: "迁移快照：旧版数据已合并为可恢复快照",
          description: "从单一存储升级为按案件版本化的统一快照。",
          snapshot: migratedSnapshot,
          stats: {
            nodesAdded: 0,
            edgesAdded: 0,
            evidenceAdded: 0,
            evidenceChanged: 0,
            evidenceRemoved: 0,
            conclusionsAdded: 0,
            alertsLinked: 0,
            autoMerged: 0,
            conflictsResolved: 0,
            conclusionsInvalidated: 0,
          },
        },
      ],
    };
  }

  return {
    alerts,
    snapshots,
    auditLogs: legacy.auditLogs ?? [],
  };
};

const parseDatabase = (raw: string): MockDatabase | null => {
  try {
    const parsed = JSON.parse(raw) as LegacyDatabase & Partial<MockDatabase>;
    if (parsed.snapshots) {
      return parsed as unknown as MockDatabase;
    }
    // v1 结构：cases / nodes / edges ... 平铺
    if (Array.isArray(parsed.cases)) {
      return migrateLegacyDatabase(parsed as LegacyDatabase);
    }
    return null;
  } catch {
    return null;
  }
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = parseDatabase(stored);
    if (parsed) {
      return parsed;
    }
  }

  // 首次升级：尝试迁移 v1 数据
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    const parsedLegacy = parseDatabase(legacy);
    if (parsedLegacy) {
      writeDatabase(parsedLegacy);
      return parsedLegacy;
    }
  }

  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  return seeded;
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }
};

export const resetDatabase = (): MockDatabase => {
  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  clearPendingDrafts();
  setSimulateFailure(false);
  return seeded;
};

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

export const appendAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at">,
): void => {
  database.auditLogs.unshift({
    id: createId("LOG"),
    at: nowIso(),
    ...log,
  });
};

/* ------------------------------- 失败草稿 ------------------------------- */

export const readPendingDrafts = (): PendingDraft[] => {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    return raw ? ((JSON.parse(raw) as PendingDraft[]) ?? []) : [];
  } catch {
    return [];
  }
};

export const writePendingDrafts = (drafts: PendingDraft[]): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
};

export const upsertPendingDraft = (draft: PendingDraft): void => {
  const drafts = readPendingDrafts().filter(
    (item) => item.draftId !== draft.draftId,
  );
  drafts.unshift(draft);
  writePendingDrafts(drafts.slice(0, 30));
};

export const removePendingDraft = (draftId: string): void => {
  writePendingDrafts(
    readPendingDrafts().filter((item) => item.draftId !== draftId),
  );
};

export const clearPendingDrafts = (): void => {
  writePendingDrafts([]);
};

/* ----------------------------- 保存失败模拟开关 ----------------------------- */

export const getSimulateFailure = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(FAIL_FLAG_STORAGE_KEY) === "1";
};

export const setSimulateFailure = (enabled: boolean): void => {
  if (typeof window === "undefined") {
    return;
  }
  if (enabled) {
    window.localStorage.setItem(FAIL_FLAG_STORAGE_KEY, "1");
  } else {
    window.localStorage.removeItem(FAIL_FLAG_STORAGE_KEY);
  }
};
