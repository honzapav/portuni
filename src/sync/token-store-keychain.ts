import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import type { TokenStore } from "./token-store.js";
import type { DeviceToken } from "./types.js";

const execFileP = promisify(execFile);

const SERVICE_PREFIX = "portuni-sync";
function serviceName(remoteName: string): string {
  return `${SERVICE_PREFIX}-${remoteName}`;
}

const plat = platform();

async function macosRead(remoteName: string): Promise<string | null> {
  const svc = serviceName(remoteName);
  try {
    const { stdout } = await execFileP("security", [
      "find-generic-password",
      "-s",
      svc,
      "-a",
      "portuni",
      "-w",
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}
async function macosWrite(remoteName: string, value: string): Promise<void> {
  const svc = serviceName(remoteName);
  // -U updates if already present.
  await execFileP("security", [
    "add-generic-password",
    "-s",
    svc,
    "-a",
    "portuni",
    "-w",
    value,
    "-U",
  ]);
}
async function macosDelete(remoteName: string): Promise<void> {
  const svc = serviceName(remoteName);
  try {
    await execFileP("security", [
      "delete-generic-password",
      "-s",
      svc,
      "-a",
      "portuni",
    ]);
  } catch {
    /* may not exist */
  }
}

async function linuxRead(remoteName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("secret-tool", [
      "lookup",
      "service",
      serviceName(remoteName),
      "account",
      "portuni",
    ]);
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}
async function linuxWrite(remoteName: string, value: string): Promise<void> {
  // secret-tool store reads password from stdin; we use spawn for stdin piping.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const p = spawn("secret-tool", [
      "store",
      "--label",
      `Portuni ${remoteName}`,
      "service",
      serviceName(remoteName),
      "account",
      "portuni",
    ]);
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
    });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`secret-tool store failed: ${err}`)),
    );
    p.on("error", reject);
    p.stdin.write(value);
    p.stdin.end();
  });
}
async function linuxDelete(remoteName: string): Promise<void> {
  try {
    await execFileP("secret-tool", [
      "clear",
      "service",
      serviceName(remoteName),
      "account",
      "portuni",
    ]);
  } catch {
    /* ok */
  }
}

// Windows: cmdkey has limited readback. Document as experimental.
async function windowsRead(_remoteName: string): Promise<string | null> {
  // cmdkey does not support reading passwords back. Returning null signals the caller.
  return null;
}
async function windowsWrite(remoteName: string, value: string): Promise<void> {
  await execFileP("cmdkey", [
    `/generic:${serviceName(remoteName)}`,
    "/user:portuni",
    `/pass:${value}`,
  ]);
}
async function windowsDelete(remoteName: string): Promise<void> {
  try {
    await execFileP("cmdkey", [`/delete:${serviceName(remoteName)}`]);
  } catch {
    /* ok */
  }
}

export function createKeychainTokenStore(): TokenStore {
  return {
    async read(name) {
      let raw: string | null;
      if (plat === "darwin") raw = await macosRead(name);
      else if (plat === "linux") raw = await linuxRead(name);
      else if (plat === "win32") raw = await windowsRead(name);
      else raw = null;
      if (!raw) return null;
      try {
        return JSON.parse(raw) as DeviceToken;
      } catch {
        return null;
      }
    },
    async write(name, token) {
      const value = JSON.stringify(token);
      if (plat === "darwin") await macosWrite(name, value);
      else if (plat === "linux") await linuxWrite(name, value);
      else if (plat === "win32") await windowsWrite(name, value);
      else throw new Error(`KeychainTokenStore: unsupported platform '${plat}'`);
    },
    async delete(name) {
      if (plat === "darwin") await macosDelete(name);
      else if (plat === "linux") await linuxDelete(name);
      else if (plat === "win32") await windowsDelete(name);
    },
  };
}
