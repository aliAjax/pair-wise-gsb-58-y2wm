import type { PendingDraft } from "../models/types";
import { createId, nowIso } from "./mockStorage";

const DRAFT_KEY = "bank-fraud-investigation-pending-drafts-v1";

type Listener = (drafts: PendingDraft[]) => void;
const listeners = new Set<Listener>();

const readAll = (): PendingDraft[] => {
  if (typeof window === "undefined") {
    return [];
  }
  const stored = window.localStorage.getItem(DRAFT_KEY);
  if (!stored) {
    return [];
  }
  try {
    return JSON.parse(stored) as PendingDraft[];
  } catch {
    return [];
  }
};

const writeAll = (drafts: PendingDraft[]): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  listeners.forEach((listener) => listener(drafts));
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === DRAFT_KEY) {
      listeners.forEach((listener) => listener(readAll()));
    }
  });
}

export const listPendingDrafts = (): PendingDraft[] => readAll();

export const getPendingDraft = (caseId: string): PendingDraft | undefined =>
  readAll().find((item) => item.caseId === caseId);

export const savePendingDraft = (
  draft: Omit<PendingDraft, "id" | "savedAt" | "attempts"> & {
    id?: string;
  },
): PendingDraft => {
  const drafts = readAll();
  const existingIndex = drafts.findIndex(
    (item) => item.caseId === draft.caseId,
  );
  const record: PendingDraft = {
    id: draft.id ?? drafts[existingIndex]?.id ?? createId("DRAFT"),
    savedAt: drafts[existingIndex]?.savedAt ?? nowIso(),
    attempts: drafts[existingIndex]?.attempts ?? 0,
    caseId: draft.caseId,
    caseTitle: draft.caseTitle,
    reason: draft.reason,
    baseRevision: draft.baseRevision,
    bundle: draft.bundle,
    summaryNote: draft.summaryNote,
    actor: draft.actor,
    conclusion: draft.conclusion,
    conflicts: draft.conflicts,
    lastError: draft.lastError,
  };
  if (existingIndex >= 0) {
    drafts[existingIndex] = record;
  } else {
    drafts.unshift(record);
  }
  writeAll(drafts);
  return record;
};

export const bumpDraftAttempt = (caseId: string): void => {
  const drafts = readAll();
  const index = drafts.findIndex((item) => item.caseId === caseId);
  if (index >= 0) {
    drafts[index] = { ...drafts[index], attempts: drafts[index].attempts + 1 };
    writeAll(drafts);
  }
};

export const removePendingDraft = (caseId: string): void => {
  writeAll(readAll().filter((item) => item.caseId !== caseId));
};

export const subscribePendingDrafts = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
