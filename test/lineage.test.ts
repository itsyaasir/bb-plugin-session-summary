import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByParent, lineageTree, type ThreadRef } from "../contract.ts";
import { readAncestors, readDescendants, type ListThreads } from "../summary.ts";

interface Fake {
  id: string;
  parent: string | null;
  archived?: boolean;
}

/** A thread list that filters a fixed set of threads the way bb does. */
function fakeList(threads: Fake[]): ListThreads {
  return async (args) => {
    const rows = threads
      .filter((thread) => (thread.archived ?? false) === (args?.archived ?? false))
      .filter((thread) => args?.parentThreadId === undefined || thread.parent === args.parentThreadId)
      .filter((thread) => args?.threadIds === undefined || args.threadIds.includes(thread.id))
      .map((thread, index) => ({
        id: thread.id,
        parentThreadId: thread.parent,
        environmentId: null,
        title: thread.id,
        titleFallback: null,
        providerId: "claude-code",
        status: "idle",
        archivedAt: thread.archived ? 1 : null,
        originKind: null,
        createdAt: index,
      }));
    return rows as never;
  };
}

test("descendants come from every level, archived ones too", async () => {
  const list = fakeList([
    { id: "a", parent: "root" },
    { id: "b", parent: "root", archived: true },
    { id: "a1", parent: "a" },
    { id: "a2", parent: "a", archived: true },
    { id: "a1x", parent: "a1" },
    { id: "other", parent: null },
  ]);
  const { descendants, truncated } = await readDescendants(list, "root");
  assert.equal(truncated, false);
  const byParent = groupByParent(descendants);
  assert.deepEqual(byParent.get("root")?.map((thread) => thread.id).sort(), ["a", "b"]);
  assert.deepEqual(byParent.get("a")?.map((thread) => thread.id).sort(), ["a1", "a2"]);
  assert.deepEqual(byParent.get("a1")?.map((thread) => thread.id), ["a1x"]);
  assert.equal(descendants.length, 5);
});

test("a deep or wide tree stops at the limit and says so", async () => {
  const chain = Array.from({ length: 10 }, (_, index) => ({ id: `t${index + 1}`, parent: index === 0 ? "root" : `t${index}` }));
  const deep = await readDescendants(fakeList(chain), "root");
  assert.equal(deep.descendants.length, 6);
  assert.equal(deep.truncated, true);
  const wide = Array.from({ length: 250 }, (_, index) => ({ id: `w${index}`, parent: "root" }));
  const many = await readDescendants(fakeList(wide), "root");
  assert.equal(many.descendants.length, 200);
  assert.equal(many.truncated, true);
});

test("ancestors run from the root to the direct parent and stop at a loop", async () => {
  const list = fakeList([
    { id: "root", parent: null },
    { id: "mid", parent: "root", archived: true },
    { id: "me", parent: "mid" },
  ]);
  assert.deepEqual((await readAncestors(list, "me", "mid")).map((thread) => thread.id), ["root", "mid"]);
  const loop = fakeList([
    { id: "x", parent: "y" },
    { id: "y", parent: "x" },
  ]);
  assert.deepEqual((await readAncestors(loop, "me", "x")).map((thread) => thread.id), ["y", "x"]);
});

function ref(id: string, parentId: string, environmentId: string | null, createdAt: number): ThreadRef {
  return { id, parentId, environmentId, title: id, providerId: "codex", status: "idle", archived: false, fork: false, createdAt };
}

test("a later sibling in the same folder sits under the earlier one", () => {
  const tree = lineageTree(
    [
      ref("work-288", "root", "env-a", 1),
      ref("work-265", "root", "env-b", 2),
      ref("review-288", "root", "env-a", 3),
      ref("helper", "root", "env-root", 4),
      ref("helper-2", "root", "env-root", 5),
      ref("re-review-288", "root", "env-a", 6),
      ref("spawned-by-288", "work-288", "env-c", 7),
      ref("no-folder", "root", null, 8),
    ],
    "root",
    "env-root",
  );
  const ids = (id: string) => tree.get(id)?.map((thread) => thread.id);
  assert.deepEqual(ids("root"), ["work-288", "work-265", "helper", "helper-2", "no-folder"]);
  assert.deepEqual(ids("work-288"), ["review-288", "re-review-288", "spawned-by-288"]);
  assert.equal(tree.get("work-265"), undefined);
});
