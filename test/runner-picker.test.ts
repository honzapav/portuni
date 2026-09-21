import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeRunnerChoice,
  decodeRunnerChoice,
  runnerPickerGroups,
  runnerChoiceLabel,
} from "../apps/web/src/lib/runner-picker.js";

describe("runner picker", () => {
  it("encodes and decodes a runner + optional instance", () => {
    assert.deepEqual(decodeRunnerChoice(encodeRunnerChoice("claude", "01A")), { runner: "claude", instanceId: "01A" });
    assert.deepEqual(decodeRunnerChoice(encodeRunnerChoice("claude", null)), { runner: "claude", instanceId: null });
  });

  it("groups instances under their runner, the runner's own default first, the draft's own choice marked", () => {
    const groups = runnerPickerGroups(
      [{ id: "claude" }, { id: "codex" }],
      [
        { id: "01A", name: "Work", runner: "claude" },
        { id: "01B", name: "Home", runner: "claude" },
      ],
      { runner: "claude", instanceId: "01B" },
    );
    assert.deepEqual(
      groups.map((g) => g.runner),
      ["claude", "codex"],
    );
    assert.deepEqual(
      groups[0].options.map((o) => [o.label, o.isDefault]),
      [
        ["výchozí instance", false],
        ["Work", false],
        ["Home", true],
      ],
    );
    assert.deepEqual(
      groups[1].options.map((o) => o.label),
      ["výchozí instance"],
    );
  });

  it("labels the fixed choice, or says no runner is logged in", () => {
    const instances = [{ id: "01A", name: "Work" }];
    assert.equal(runnerChoiceLabel({ runner: "claude", instance_id: "01A" }, instances), "claude · Work");
    assert.equal(runnerChoiceLabel({ runner: "claude", instance_id: null }, instances), "claude");
    assert.equal(runnerChoiceLabel({ runner: "claude", instance_id: "01Z" }, instances), "claude · 01Z");
    assert.equal(runnerChoiceLabel({ runner: null, instance_id: null }, instances), "Žádný runner není přihlášený");
  });
});
