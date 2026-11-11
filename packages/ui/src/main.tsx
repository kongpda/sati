import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

// The live stream already refetches the snapshot after each change. Refetching on every window
// focus as well is wasted work, and three retries leave "Loading…" up for seconds when the
// server is gone (review WP3.5).
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

/**
 * One record the board cannot draw must not leave a white page with no way out. The data is
 * safe in the store; this says so and offers the reload.
 */
class Crash extends Component<{ children: ReactNode }, { message: string | null }> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(err: unknown) {
    return { message: err instanceof Error ? err.message : String(err) };
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="crash" role="alert">
        <h1>The board hit an error</h1>
        <p>Nothing was lost: your tasks and notes are saved. Reload to carry on.</p>
        <p className="hint">{this.state.message}</p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Crash>
        <App />
      </Crash>
    </QueryClientProvider>
  </StrictMode>,
);
