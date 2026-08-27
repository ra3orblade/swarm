/**
 * What a worktree changed (M11.11): the file list, and the patch for whichever file you pick.
 *
 * The patch is fetched per file rather than all at once. A branch's whole diff is routinely
 * hundreds of kilobytes, and the question is almost always about one file.
 *
 * Colouring is done by splitting into lines and rendering elements — never by building an HTML
 * string. A patch is the one payload in the dashboard that is *entirely* attacker-influenced text,
 * and it is the last place to be interpolating markup.
 */
import type { DiffFile } from "@swarm/core/forge";
import { useEffect, useState } from "react";
import { get, query } from "../../api/client";
import { Modal } from "../../components/Modal";
import { Badge } from "../../components/ui";
import { shortPath } from "../../lib/format";
import { icon } from "../../lib/icon";

interface DiffResponse {
  worktree: string;
  baseRef: string | null;
  commits: string[];
  files: DiffFile[];
  dirty: boolean;
  patch?: string;
  error?: string;
}

/** Which class a patch line takes: file header, hunk header, addition, deletion, or context. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return "m";
  if (line.startsWith("@@")) return "h";
  if (line.startsWith("+")) return "a";
  if (line.startsWith("-")) return "d";
  return "";
}

function Patch({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const cls = lineClass(line);
        return (
          <span
            // A patch has no per-line identity, and it is replaced wholesale when the file changes.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional lines of one immutable patch
            key={i}
            className={cls || undefined}
          >
            {line}
            {"\n"}
          </span>
        );
      })}
    </>
  );
}

/** The first few commits on the branch; the rest are counted rather than listed. */
function Commits({ commits }: { commits: string[] }) {
  if (commits.length === 0) return null;
  return (
    <div className="dim df-commits">
      {commits.slice(0, 8).map((c) => (
        <div key={c}>{c}</div>
      ))}
      {commits.length > 8 && <div>… {commits.length - 8} more</div>}
    </div>
  );
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="df-files">
      {files.map((f) => (
        <button
          type="button"
          key={f.path}
          className={selected === f.path ? "on" : undefined}
          onClick={() => onSelect(f.path)}
        >
          <span className="st">{f.status}</span>
          <span className="pa" title={f.path}>
            {f.path}
          </span>
          {f.added >= 0 ? (
            <>
              <span className="pl">+{f.added}</span>
              <span className="mi">−{f.deleted}</span>
            </>
          ) : (
            <span className="dim">bin</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Nothing picked, loading, empty, or the patch itself. */
function PatchPane({ file, patch }: { file: string | null; patch: string | null }) {
  if (file === null) return <span className="m">select a file — or view everything below</span>;
  if (patch === null) return <span className="m">loading…</span>;
  return patch ? <Patch text={patch} /> : <span className="m">(empty)</span>;
}

export interface DiffDrawerProps {
  projectId: string;
  worktree: string;
  onClose: () => void;
}

export function DiffDrawer({ projectId, worktree, onClose }: DiffDrawerProps) {
  const [data, setData] = useState<DiffResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** null = nothing picked; "" = the whole diff. */
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void get<DiffResponse>(
      `/v1/worktrees/diff${query({ project: projectId, worktree })}`,
      controller.signal,
    )
      .then((d) => (d.error ? setFailed(d.error) : setData(d)))
      .catch((e: Error) => setFailed(e.message));
    return () => controller.abort();
  }, [projectId, worktree]);

  useEffect(() => {
    if (file === null) return;
    const controller = new AbortController();
    setPatch(null);
    void get<DiffResponse>(
      `/v1/worktrees/diff${query({ project: projectId, worktree, file: file || null, patch: file ? null : 1 })}`,
      controller.signal,
    )
      .then((d) => setPatch(d.patch ?? ""))
      .catch(() => setPatch(""));
    return () => controller.abort();
  }, [file, projectId, worktree]);

  const subtitle = data ? (
    <>
      {shortPath(data.worktree)} · vs {data.baseRef ?? "HEAD"} · {data.commits.length} commit
      {data.commits.length === 1 ? "" : "s"} · {data.files.length} file
      {data.files.length === 1 ? "" : "s"}
      {data.dirty && (
        <>
          {" · "}
          <Badge tone="warn">dirty</Badge>
        </>
      )}
    </>
  ) : (
    shortPath(worktree)
  );

  return (
    <Modal
      title="Diff"
      glyph="folders"
      size="wide"
      subtitle={subtitle}
      onClose={onClose}
      footer={
        data && data.files.length > 0 ? (
          <button type="button" className="nav" onClick={() => setFile("")}>
            {icon("folders", 12)} Whole diff
          </button>
        ) : undefined
      }
    >
      {failed ? (
        <div className="empty">{failed}</div>
      ) : data ? (
        <>
          <Commits commits={data.commits} />
          {data.files.length === 0 ? (
            <div className="empty">Nothing changed.</div>
          ) : (
            <>
              <FileList files={data.files} selected={file} onSelect={setFile} />
              <pre className="df-patch">
                <PatchPane file={file} patch={patch} />
              </pre>
            </>
          )}
        </>
      ) : (
        <div className="empty">Loading…</div>
      )}
    </Modal>
  );
}
