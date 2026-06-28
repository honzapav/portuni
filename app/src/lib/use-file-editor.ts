// Shared load/save/conflict state for the editor shells (pane + fullscreen).
// Save is local-only (PUT writes the mirror; the user pushes via Synchronizovat).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFileContent, saveFileContent, FileConflictError } from "../api";

export type EditorStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

export type ConflictState = { theirVersion: string } | null;

export function useFileEditor(nodeId: string | null, relPath: string | null) {
  const [status, setStatus] = useState<EditorStatus>({ kind: "loading" });
  const [content, setContent] = useState("");
  const [version, setVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [externalChange, setExternalChange] = useState(false);
  const versionRef = useRef(version);
  useEffect(() => { versionRef.current = version; }, [version]);

  // Load on (nodeId, relPath) change. When no file is open (either arg
  // null) the hook is inert: no fetch, callbacks no-op. This lets App own
  // a single instance and call the hook unconditionally (hooks rule).
  useEffect(() => {
    let cancelled = false;
    if (nodeId == null || relPath == null) return;
    setStatus({ kind: "loading" });
    setConflict(null);
    fetchFileContent(nodeId, relPath)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setVersion(r.version);
        setDirty(false);
        setStatus({ kind: "ready" });
        setExternalChange(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, relPath]);

  const onChange = useCallback((next: string) => {
    setContent(next);
    setDirty(true);
  }, []);

  const doSave = useCallback(
    async (opts?: { force?: boolean; value?: string }) => {
      if (nodeId == null || relPath == null) return;
      setSaving(true);
      try {
        const body = {
          content: opts?.value ?? content,
          baseVersion: version ?? undefined,
          force: opts?.force,
        };
        const r = await saveFileContent(nodeId, relPath, body);
        setVersion(r.version);
        setDirty(false);
        setConflict(null);
        setExternalChange(false);
      } catch (e) {
        if (e instanceof FileConflictError) {
          setConflict({ theirVersion: e.currentVersion });
        } else {
          setStatus({ kind: "error", message: String(e) });
        }
      } finally {
        setSaving(false);
      }
    },
    [nodeId, relPath, content, version],
  );

  // Conflict resolution: keep mine (force) or reload theirs (re-fetch).
  const keepMine = useCallback(() => doSave({ force: true }), [doSave]);
  const reloadTheirs = useCallback(async () => {
    if (nodeId == null || relPath == null) return;
    const r = await fetchFileContent(nodeId, relPath);
    setContent(r.content);
    setVersion(r.version);
    setDirty(false);
    setConflict(null);
    setExternalChange(false);
  }, [nodeId, relPath]);

  // Poll the on-disk version while a file is open. The backend's GET
  // returns the sha256 `version`; if it moved past what we loaded, the
  // file changed underneath us (an agent edit, a sync pull). We only
  // FLAG it -- never silently swap content -- mirroring the save-time
  // conflict UX. Paused when the tab is hidden. 5 s matches App's
  // node-detail poll (App.tsx:492-509).
  useEffect(() => {
    if (nodeId == null || relPath == null || version == null) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      fetchFileContent(nodeId, relPath)
        .then((r) => {
          if (r.version !== versionRef.current) setExternalChange(true);
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [nodeId, relPath, version]);

  return {
    status,
    content,
    onChange,
    save: (value?: string) => doSave({ value }),
    saving,
    dirty,
    conflict,
    externalChange,
    keepMine,
    reloadTheirs,
  };
}

export type FileEditor = ReturnType<typeof useFileEditor>;
