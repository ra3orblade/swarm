/**
 * Session replay (M4.1, ported in M11.11): step through what a session actually did, one tool call
 * at a time, with the full input and the paired output.
 *
 * The stream on the session page shows a one-line summary per call, which is enough to follow along
 * and never enough to answer "what exactly did it pass?". The full payloads are too large to keep
 * in the stream, so they are fetched per step from `/v1/events/:seq` and cached — stepping back and
 * forth costs one request per step, once.
 */
import type { SwarmEvent } from "@swarm/core/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get } from "../../api/client";
import { Modal } from "../../components/Modal";
import { hhmm } from "../../lib/format";
import { icon } from "../../lib/icon";

interface Step {
  seq: number;
  tool: string;
  summary: string;
}

interface Detail {
  input: unknown;
  output: unknown;
  ts: string | null;
}

/** Payloads are objects or strings; a string is already the readable form. */
function render(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** A tool response can be enormous; past a few thousand characters nobody is reading anyway. */
const OUTPUT_LIMIT = 4000;

export interface ReplayProps {
  events: SwarmEvent[];
  onClose: () => void;
}

export function Replay({ events, onClose }: ReplayProps) {
  const steps = useMemo<Step[]>(
    () =>
      events
        .filter((e) => e.type === "tool.requested")
        .map((e) => {
          const payload = e.payload as { tool?: string; summary?: string } | undefined;
          return {
            seq: e.seq ?? 0,
            tool: payload?.tool ?? "tool",
            summary: payload?.summary ?? "",
          };
        }),
    [events],
  );

  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const cache = useRef(new Map<number, Detail>());

  const step = steps[index];

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(steps.length - 1, i + delta))),
    [steps.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go]);

  useEffect(() => {
    if (!step) return;
    const cached = cache.current.get(step.seq);
    if (cached) {
      setDetail(cached);
      return;
    }
    setDetail(null);
    const controller = new AbortController();
    void (async () => {
      // The request event carries the full input; its result is the next `tool.completed` with the
      // same summary — the pair is matched on summary because a call has no id of its own.
      const request = await get<SwarmEvent>(`/v1/events/${step.seq}`, controller.signal).catch(
        () => null,
      );
      const completion = events.find(
        (e) =>
          e.type === "tool.completed" &&
          (e.seq ?? 0) > step.seq &&
          (e.payload as { summary?: string } | undefined)?.summary === step.summary,
      );
      const result = completion?.seq
        ? await get<SwarmEvent>(`/v1/events/${completion.seq}`, controller.signal).catch(() => null)
        : null;
      if (controller.signal.aborted) return;
      const next: Detail = {
        input: (request?.payload as { toolInput?: unknown } | undefined)?.toolInput ?? null,
        output: (result?.payload as { toolResponse?: unknown } | undefined)?.toolResponse ?? null,
        ts: request?.ts ?? null,
      };
      cache.current.set(step.seq, next);
      setDetail(next);
    })();
    return () => controller.abort();
  }, [step, events]);

  if (!step) {
    return (
      <Modal title="Replay" glyph="play" onClose={onClose}>
        <div className="empty">No tool calls in this session yet.</div>
      </Modal>
    );
  }

  const output = render(detail?.output);

  return (
    <Modal
      title="Replay"
      glyph="play"
      size="wn rp"
      subtitle={
        <>
          {step.tool}
          <span className="grow" />
          {index + 1} / {steps.length}
          {detail?.ts ? ` · ${hhmm(detail.ts)}` : ""}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" disabled={index === 0} onClick={() => go(-1)}>
            {icon("arrow-left", 12)} Prev
          </button>
          <input
            type="range"
            className="rp-range"
            min={0}
            max={steps.length - 1}
            value={index}
            aria-label="Step"
            onChange={(e) => setIndex(Number(e.target.value))}
          />
          <button
            type="button"
            className="primary"
            disabled={index >= steps.length - 1}
            onClick={() => go(1)}
          >
            Next {icon("arrow-right", 12)}
          </button>
        </>
      }
    >
      <div className="dim now rp-summary">{step.summary}</div>
      <h4>input</h4>
      <pre className="snip">{render(detail?.input) || "—"}</pre>
      <h4>output</h4>
      <pre className="snip">
        {detail === null
          ? "loading…"
          : detail.output == null
            ? "(no result captured)"
            : output.slice(0, OUTPUT_LIMIT)}
      </pre>
    </Modal>
  );
}
