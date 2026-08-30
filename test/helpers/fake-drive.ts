// In-memory stand-in for the Google Drive v3 REST surface the Drive adapter
// uses: files.list (q= by name / parent / mimeType, and `fullText contains`
// grepped over stored bytes), files.create (JSON folder + multipart upload),
// files.get (metadata + alt=media), files.update (rename / addParents /
// removeParents / trashed). Enforces the shared-drive rule that an item has
// exactly one parent (403 teamDrivesParentLimit), and lets a test simulate
// search-index lag (a freshly created folder that files.list does not return
// yet) via `lagSearchesFor`.
import { createHash } from "node:crypto";

export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  createdTime: string;
  content: Buffer;
}

const FOLDER = "application/vnd.google-apps.folder";

export class FakeDrive {
  readonly rootId = "ROOT";
  readonly files = new Map<string, FakeDriveFile>();
  readonly requests: Array<{ method: string; url: string }> = [];
  private seq = 0;
  private clock = 0;
  private lag = new Map<string, number>();

  constructor() {
    this.files.set(this.rootId, {
      id: this.rootId, name: "root", mimeType: FOLDER, parents: [], trashed: false,
      createdTime: this.tick(), content: Buffer.alloc(0),
    });
  }

  private tick(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(4, "0")}`;
  }

  // The next `n` files.list searches for `name` return nothing, whatever is
  // actually stored -- a folder another process just created, or Drive's
  // own index lag after a create.
  lagSearchesFor(name: string, n: number): void {
    this.lag.set(name, n);
  }

  addFolder(name: string, parentId: string): string {
    const id = this.nextId("F");
    this.files.set(id, {
      id, name, mimeType: FOLDER, parents: [parentId], trashed: false,
      createdTime: this.tick(), content: Buffer.alloc(0),
    });
    return id;
  }

  addFile(name: string, parentId: string, content: string | Buffer): string {
    const id = this.nextId("X");
    this.files.set(id, {
      id, name, mimeType: "application/octet-stream", parents: [parentId], trashed: false,
      createdTime: this.tick(), content: Buffer.from(content),
    });
    return id;
  }

  live(): FakeDriveFile[] {
    return Array.from(this.files.values()).filter((f) => !f.trashed);
  }

  foldersNamed(name: string, parentId?: string): FakeDriveFile[] {
    return this.live().filter(
      (f) => f.mimeType === FOLDER && f.name === name && (parentId === undefined || f.parents.includes(parentId)),
    );
  }

  filesNamed(name: string): FakeDriveFile[] {
    return this.live().filter((f) => f.mimeType !== FOLDER && f.name === name);
  }

  private meta(f: FakeDriveFile): Record<string, unknown> {
    return {
      id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents,
      size: String(f.content.length), createdTime: f.createdTime, modifiedTime: f.createdTime,
      md5Checksum: f.mimeType === FOLDER ? undefined : createHash("md5").update(f.content).digest("hex"),
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private list(q: string, orderBy: string | null): Response {
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'") ?? null;
    const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? null;
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1] ?? null;
    const fullText =
      /fullText contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'").toLowerCase() ?? null;
    if (name !== null) {
      const remaining = this.lag.get(name) ?? 0;
      if (remaining > 0) {
        this.lag.set(name, remaining - 1);
        return this.json({ files: [] });
      }
    }
    let hits = this.live().filter(
      (f) =>
        (name === null || f.name === name) &&
        (parent === null || f.parents.includes(parent)) &&
        (mime === null || f.mimeType === mime) &&
        (fullText === null ||
          (f.mimeType !== FOLDER && f.content.toString("utf8").toLowerCase().includes(fullText))),
    );
    if (orderBy === "createdTime") hits = hits.slice().sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return this.json({ files: hits.map((f) => this.meta(f)) });
  }

  private update(id: string, params: URLSearchParams, body: Record<string, unknown>): Response {
    const f = this.files.get(id);
    if (!f) return this.json({ error: { message: "File not found" } }, 404);
    const add = params.get("addParents")?.split(",").filter(Boolean) ?? [];
    const remove = params.get("removeParents")?.split(",").filter(Boolean) ?? [];
    const parents = f.parents.filter((p) => !remove.includes(p));
    for (const p of add) if (!parents.includes(p)) parents.push(p);
    if (parents.length !== 1) {
      return this.json(
        {
          error: {
            code: 403,
            message: "A shared drive item must have exactly one parent.",
            errors: [{ domain: "global", reason: "teamDrivesParentLimit", message: "A shared drive item must have exactly one parent." }],
          },
        },
        403,
      );
    }
    f.parents = parents;
    if (typeof body.name === "string") f.name = body.name;
    if (typeof body.trashed === "boolean") f.trashed = body.trashed;
    return this.json(this.meta(f));
  }

  private async multipart(req: RequestInit): Promise<{ metadata: Record<string, unknown>; content: Buffer }> {
    const headers = new Headers(req.headers as HeadersInit);
    const boundary = /boundary=(.+)$/.exec(headers.get("Content-Type") ?? "")?.[1];
    if (!boundary) throw new Error("fake drive: multipart without boundary");
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as unknown as Uint8Array);
    const marker = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];
    let pos = raw.indexOf(marker);
    while (pos !== -1) {
      const start = pos + marker.length;
      const next = raw.indexOf(marker, start);
      if (next === -1) break;
      parts.push(raw.subarray(start, next));
      pos = next;
    }
    const bodyOf = (p: Buffer): Buffer => {
      const sep = p.indexOf("\r\n\r\n");
      const b = p.subarray(sep + 4);
      return b.subarray(0, b.length - 2); // trailing CRLF before the next boundary
    };
    return { metadata: JSON.parse(bodyOf(parts[0]).toString("utf8")), content: bodyOf(parts[1]) };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push({ method, url: url.toString() });
    if (url.hostname === "oauth2.googleapis.com") {
      return this.json({ access_token: "A", expires_in: 3600 });
    }
    const p = url.pathname;
    if (p === "/upload/drive/v3/files" && method === "POST") {
      const { metadata, content } = await this.multipart(init ?? {});
      const parents = (metadata.parents as string[] | undefined) ?? [this.rootId];
      const id = this.nextId("X");
      this.files.set(id, {
        id, name: metadata.name as string, mimeType: "application/octet-stream", parents,
        trashed: false, createdTime: this.tick(), content,
      });
      return this.json(this.meta(this.files.get(id)!));
    }
    const upload = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (upload && method === "PATCH") {
      const f = this.files.get(upload[1]);
      if (!f) return this.json({ error: { message: "File not found" } }, 404);
      const { metadata, content } = await this.multipart(init ?? {});
      if (typeof metadata.name === "string") f.name = metadata.name;
      f.content = content;
      return this.json(this.meta(f));
    }
    if (p === "/drive/v3/files" && method === "GET") {
      return this.list(url.searchParams.get("q") ?? "", url.searchParams.get("orderBy"));
    }
    if (p === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const id = this.nextId("F");
      this.files.set(id, {
        id, name: body.name as string, mimeType: (body.mimeType as string) ?? "application/octet-stream",
        parents: (body.parents as string[] | undefined) ?? [this.rootId], trashed: false,
        createdTime: this.tick(), content: Buffer.alloc(0),
      });
      return this.json(this.meta(this.files.get(id)!));
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (one && method === "GET") {
      const f = this.files.get(one[1]);
      if (!f || f.trashed) return this.json({ error: { message: "File not found" } }, 404);
      if (url.searchParams.get("alt") === "media") return new Response(f.content);
      return this.json(this.meta(f));
    }
    if (one && method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return this.update(one[1], url.searchParams, body);
    }
    return this.json({ error: { message: `fake drive: unhandled ${method} ${p}` } }, 500);
  };
}
