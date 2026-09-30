import { useEffect, type Dispatch } from "react";
import type { UnknownAction } from "@reduxjs/toolkit";
import { bankApi } from "./api";
import { DATABASE_STORAGE_KEY, DRAFTS_STORAGE_KEY } from "./storageKeys";

/**
 * 调查员常开两个窗口处理同一案件。一个窗口保存（写 localStorage）后，
 * 另一个窗口通过 storage 事件实时刷新快照与草稿，避免在旧版本上继续编辑。
 */
export const setupCrossTabSync = (
  dispatch: Dispatch<UnknownAction>,
): void => {
  if (typeof window === "undefined") {
    return;
  }

  const onStorage = (event: StorageEvent): void => {
    if (!event.key) {
      return;
    }
    if (event.key === DATABASE_STORAGE_KEY) {
      dispatch(
        bankApi.util.invalidateTags([
          "Alerts",
          "Cases",
          "Case",
          "Audit",
          "Dashboard",
        ]),
      );
    } else if (event.key === DRAFTS_STORAGE_KEY) {
      dispatch(bankApi.util.invalidateTags(["Drafts"]));
    }
  };

  window.addEventListener("storage", onStorage);
};

export const useCrossTabSync = (
  dispatch: Dispatch<UnknownAction>,
): void => {
  useEffect(() => {
    setupCrossTabSync(dispatch);
  }, [dispatch]);
};
