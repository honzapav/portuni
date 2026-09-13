// Shared by the Claude adapter's close()/interrupt() safety net and the
// run-sweep boot cleanup: `kill(pid, 0)` sends no signal, just probes
// whether the process still exists (throws ESRCH/EPERM otherwise).
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
