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
  CaseBundle,
  CaseSnapshot,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
} from "../models/types";
import { buildSnapshotSummary, evidenceSignature } from "./snapshotCore";

export interface MockDatabase {
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  auditLogs: AuditLog[];
  snapshots: CaseSnapshot[];
}

const STORAGE_KEY = "bank-fraud-investigation-db-v2";
const LEGACY_STORAGE_KEY = "bank-fraud-investigation-db-v1";

const createSeedDatabase = (): MockDatabase => {
  const cases = structuredClone(seedCases).map((item) => ({
    ...item,
    revision: 1,
  }));
  const alerts = structuredClone(seedAlerts);
  const nodes = structuredClone(seedNodes);
  const edges = structuredClone(seedEdges);
  const evidence = structuredClone(seedEvidence);
  const conclusions = structuredClone(seedConclusions).map((item) => ({
    ...item,
    evidenceSignature: evidenceSignature(
      evidence.filter((ev) => ev.caseId === item.caseId),
    ),
  }));

  const database: MockDatabase = {
    alerts,
    cases,
    nodes,
    edges,
    evidence,
    conclusions,
    auditLogs: structuredClone(seedAuditLogs),
    snapshots: [],
  };

  // 为每个案件建立 R1 基准快照
  database.snapshots = cases.map((investigationCase) =>
    buildSnapshotRecord(database, investigationCase.id, {
      revision: 1,
      savedAt: investigationCase.updatedAt,
      savedBy: "系统",
      source: "初始快照",
      note: "案件建立时的基准快照",
    }),
  );

  return database;
};

/** 从旧版（v1）数据迁移：补齐 revision、证据指纹与基准快照 */
const normalizeDatabase = (raw: Partial<MockDatabase>): MockDatabase => {
  const database: MockDatabase = {
    alerts: raw.alerts ?? [],
    cases: (raw.cases ?? []).map((item) => ({
      ...item,
      revision: typeof item.revision === "number" ? item.revision : 1,
    })),
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
    evidence: raw.evidence ?? [],
    conclusions: raw.conclusions ?? [],
    auditLogs: raw.auditLogs ?? [],
    snapshots: raw.snapshots ?? [],
  };

  database.conclusions = database.conclusions.map((item) =>
    item.evidenceSignature
      ? item
      : {
          ...item,
          evidenceSignature: evidenceSignature(
            database.evidence.filter((ev) => ev.caseId === item.caseId),
          ),
        },
  );

  database.cases.forEach((investigationCase) => {
    const hasSnapshot = database.snapshots.some(
      (snapshot) => snapshot.caseId === investigationCase.id,
    );
    if (!hasSnapshot) {
      database.snapshots.push(
        buildSnapshotRecord(database, investigationCase.id, {
          revision: investigationCase.revision,
          savedAt: investigationCase.updatedAt,
          savedBy: "系统",
          source: "迁移补建",
          note: "升级到可恢复快照后补建的基准版本",
        }),
      );
    }
  });

  return database;
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    // 从旧版 v1 本地库迁移，避免调查员既有数据被重置
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      try {
        const normalized = normalizeDatabase(
          JSON.parse(legacy) as Partial<MockDatabase>,
        );
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
        return normalized;
      } catch {
        // 旧库损坏时回落到种子数据
      }
    }
    const seeded = createSeedDatabase();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }

  try {
    const normalized = normalizeDatabase(
      JSON.parse(stored) as Partial<MockDatabase>,
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    const seeded = createSeedDatabase();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }
};

export const resetDatabase = (): MockDatabase => {
  const seeded = createSeedDatabase();
  writeDatabase(seeded);
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

/* ---------- 案件快照 ---------- */

export const getCaseBundle = (
  database: MockDatabase,
  caseId: string,
): CaseBundle | undefined => {
  const investigationCase = database.cases.find(
    (item) => item.id === caseId,
  );
  if (!investigationCase) {
    return undefined;
  }
  return {
    case: structuredClone(investigationCase),
    alertIds: structuredClone(investigationCase.alertIds),
    nodes: database.nodes
      .filter((item) => item.caseId === caseId)
      .map((item) => structuredClone(item)),
    edges: database.edges
      .filter((item) => item.caseId === caseId)
      .map((item) => structuredClone(item)),
    evidence: database.evidence
      .filter((item) => item.caseId === caseId)
      .map((item) => structuredClone(item)),
    conclusions: database.conclusions
      .filter((item) => item.caseId === caseId)
      .map((item) => structuredClone(item)),
  };
};

const SNAPSHOT_LIMIT = 30;

interface SnapshotRecordOptions {
  revision?: number;
  savedAt?: string;
  savedBy?: string;
  source?: string;
  note: string;
  previous?: CaseBundle;
  invalidated?: ConclusionVersion[];
}

/** 将当前案件状态固化为一条可恢复快照，并维护快照链长度 */
export const buildSnapshotRecord = (
  database: MockDatabase,
  caseId: string,
  options: SnapshotRecordOptions,
): CaseSnapshot => {
  const bundle = getCaseBundle(database, caseId);
  if (!bundle) {
    throw new Error("案件不存在");
  }
  const revision = options.revision ?? bundle.case.revision;
  bundle.case.revision = revision;
  const summary = buildSnapshotSummary(
    options.previous,
    bundle,
    options.invalidated ?? [],
    options.note,
  );
  const record: CaseSnapshot = {
    id: createId("SNAP"),
    caseId,
    revision,
    savedAt: options.savedAt ?? nowIso(),
    savedBy: options.savedBy ?? "林澜",
    source: options.source ?? "案件保存",
    summary,
    bundle,
  };

  const sameCase = database.snapshots
    .filter((item) => item.caseId === caseId)
    .sort((a, b) => b.revision - a.revision);
  const others = database.snapshots.filter((item) => item.caseId !== caseId);
  const kept = sameCase.slice(0, SNAPSHOT_LIMIT - 1);
  database.snapshots = [...others, record, ...kept];

  return record;
};

export const getLatestSnapshot = (
  database: MockDatabase,
  caseId: string,
): CaseSnapshot | undefined =>
  database.snapshots
    .filter((item) => item.caseId === caseId)
    .sort((a, b) => b.revision - a.revision)[0];

export const getSnapshotAtRevision = (
  database: MockDatabase,
  caseId: string,
  revision: number,
): CaseSnapshot | undefined =>
  database.snapshots.find(
    (item) => item.caseId === caseId && item.revision === revision,
  );
