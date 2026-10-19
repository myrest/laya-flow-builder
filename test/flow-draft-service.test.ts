import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Laya } from "../../laya/src/index.js";
import { FlowDraftService } from "../flow-draft-service.js";
import { DecisionStore } from "../decision-store.js";

test("draft preview ignores parser-only optional fields but reports real graph changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laya-draft-preview-"));
  try {
    const store = await DecisionStore.open(path.join(directory, "flows.json"));
    const live = await store.createFlow("Preview source");
    const draft = await store.createDraft(live.id);
    const service = new FlowDraftService(store, {
      async systemOne() {
        throw new Error("Inference is not used by preview.");
      },
    } satisfies Pick<Laya, "systemOne">);

    const normalized = await store.updateDraft(draft.id, draft.revision, { flow: draft.flow });
    assert.deepEqual(service.preview(normalized.id).changes, []);

    const firstNode = normalized.flow.nodes[0];
    assert.ok(firstNode);
    const edited = await store.updateDraft(normalized.id, normalized.revision, {
      flow: {
        ...normalized.flow,
        nodes: normalized.flow.nodes.map((node) => node.id === firstNode.id
          ? { ...node, data: { ...node.data, label: "Reviewed label" } }
          : node),
      },
    });
    const changes = service.preview(edited.id).changes;
    assert.deepEqual(changes.map((change) => change.path), [`/flow/nodes[${firstNode.id}]/data/label`]);
    const review = await store.setDraftStatus(edited.id, edited.revision, "review");
    await store.applyDraft(review.id, review.revision, true);
    assert.equal(service.preview(review.id).conflict, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
