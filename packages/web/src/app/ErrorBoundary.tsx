/**
 * One throwing view must not take the page down (M11.6).
 *
 * The dashboard is a single long-lived page: before there was a boundary, an exception left the
 * last frame on screen with no sign anything had gone wrong. A 404 on a `/v1/` route almost always
 * means the running daemon is older than the page it is serving, so that case is named — it is a
 * restart, not a bug.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { ApiError } from "../api/client";

interface Props {
  /** Remounts the boundary when it changes, so switching views clears a failure. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("view failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const skew = error instanceof ApiError && error.status === 404;
    return (
      <div className="empty">
        <b>This view stopped.</b>
        <br />
        {skew
          ? "The daemon is older than this page — it is mid-upgrade. Reload once it has restarted."
          : error.message}
        <br />
        <button type="button" className="link" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
