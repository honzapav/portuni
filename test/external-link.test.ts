// Guards the "link opens twice" bug in the desktop app: tauri-plugin-shell's
// injected init script opens every clicked <a target="_blank"> through
// `plugin:shell|open` on its own, so an anchor that also routes its click
// through the native `open_external` command must not carry target="_blank"
// inside the Tauri webview. In the browser build the opposite holds -- a
// plain target="_blank" anchor with no click handler.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { externalLinkProps } from "../apps/web/src/lib/external-link";

const URL = "https://example.com/doc";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("externalLinkProps", () => {
  it("browser: native target=_blank anchor, no click handler", () => {
    const props = externalLinkProps(URL);
    assert.equal(props.href, URL);
    assert.equal(props.target, "_blank");
    assert.match(props.rel, /noopener/);
    assert.equal(props.onClick, undefined);
  });

  it("tauri: no target attribute, click goes through open_external exactly once", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
        },
      },
    };
    const props = externalLinkProps(URL);
    assert.equal(props.href, URL);
    assert.equal(props.target, undefined, "target=_blank would trigger the shell plugin's own opener");
    assert.equal(typeof props.onClick, "function");

    let prevented = 0;
    props.onClick?.({ preventDefault: () => { prevented += 1; } } as never);
    // openExternal awaits a dynamic import before invoking; let it settle.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(prevented, 1);
    assert.deepEqual(calls, [{ cmd: "open_external", args: { url: URL } }]);
  });

  it("caller onClick runs first in both builds", async () => {
    let order: string[] = [];
    const browser = externalLinkProps(URL, { onClick: () => order.push("caller") });
    assert.equal(browser.target, "_blank");
    browser.onClick?.({ preventDefault: () => order.push("prevent") } as never);
    assert.deepEqual(order, ["caller"]);

    order = [];
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: { invoke: async () => { order.push("invoke"); } },
    };
    const tauri = externalLinkProps(URL, { onClick: () => order.push("caller") });
    assert.equal(tauri.target, undefined);
    tauri.onClick?.({ preventDefault: () => order.push("prevent") } as never);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(order, ["caller", "prevent", "invoke"]);
  });
});
