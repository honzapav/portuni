// Pid files for live runs (spec: "session-runtime.ts writes <dataDir>/runs/
// <runId>.pid ... when a run starts and removes it on run_ended"). The boot
// sweep (boot/run-sweep.ts) is the only reader; a leftover file after a
// crash is exactly what it's there to notice.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PidFileContent {
  pid: number;
  started_at: string;
}

function runsDir(dataDir: string): string {
  return join(dataDir, "runs");
}

function pidFilePath(dataDir: string, runId: string): string {
  return join(runsDir(dataDir), `${runId}.pid`);
}

export async function writePidFile(dataDir: string, runId: string, pid: number): Promise<void> {
  await mkdir(runsDir(dataDir), { recursive: true });
  const content: PidFileContent = { pid, started_at: new Date().toISOString() };
  await writeFile(pidFilePath(dataDir, runId), JSON.stringify(content), "utf8");
}

export async function removePidFile(dataDir: string, runId: string): Promise<void> {
  await removePidFileAt(pidFilePath(dataDir, runId));
}

export async function removePidFileAt(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function readPidFile(path: string): Promise<PidFileContent | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PidFileContent>;
    if (typeof parsed.pid !== "number" || typeof parsed.started_at !== "string") return null;
    return { pid: parsed.pid, started_at: parsed.started_at };
  } catch {
    return null;
  }
}

export interface PidFileEntry {
  runId: string;
  path: string;
}

// Every *.pid file under <dataDir>/runs/, decoded back to its run id.
// Empty (not missing runs dir yet) when nothing has ever run here.
export async function listPidFiles(dataDir: string): Promise<PidFileEntry[]> {
  let names: string[];
  try {
    names = await readdir(runsDir(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((name) => name.endsWith(".pid"))
    .map((name) => ({ runId: name.slice(0, -".pid".length), path: join(runsDir(dataDir), name) }));
}
