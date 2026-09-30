import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "reactflow/dist/style.css";
import { Notifications } from "@mantine/notifications";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider, useDispatch } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { store } from "./app/store";
import { useCrossTabSync } from "./services/crossTab";
import "./styles.css";

function CrossTabSyncBridge() {
  const dispatch = useDispatch();
  useCrossTabSync(dispatch);
  return null;
}

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
  fontFamily:
    '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  headings: {
    fontFamily:
      '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <MantineProvider theme={theme}>
        <Notifications position="top-right" />
        <BrowserRouter>
          <CrossTabSyncBridge />
          <App />
        </BrowserRouter>
      </MantineProvider>
    </Provider>
  </StrictMode>,
);
