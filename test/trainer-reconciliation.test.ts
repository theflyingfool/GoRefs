import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileTrainer } from "../src/data/trainer-reconciliation";
import type { Profile, ReferencedTrainer } from "../src/db/types";

const localProfiles: Profile[] = [
  { id: "p1", username: "Ash", friendCode: "111111111111", createdAt: 0 },
  { id: "p2", username: "Misty", friendCode: null, createdAt: 0 },
];
const localReferencedTrainers: ReferencedTrainer[] = [
  { uuid: "p1", name: "Ash", friendCode: "111111111111" },
  { uuid: "p2", name: "Misty", friendCode: null },
  { uuid: "placeholder-1", name: "Steve", friendCode: null },
];

test("matching friend code auto-merges regardless of name", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Ash the Great", friendCode: "111111111111" }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "auto-merge", localProfileId: "p1" });
});

test("different friend codes with the same name are definitely separate, no prompt", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Ash", friendCode: "222222222222" }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "definitely-separate" });
});

test("name match against a placeholder promotes it", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Steve", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "promote", placeholderUuid: "placeholder-1" });
});

test("name match against a real profile with no friend code signal asks the user", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Misty", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "ask-merge-or-separate", localProfileId: "p2" });
});

test("no name or friend code match is a brand new trainer", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Brock", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "new" });
});

// Refinement: `referenced_trainer` allows duplicate names (its PK is uuid,
// not name), so a real profile and an unrelated placeholder can share a
// name -- e.g. a real profile named "Steve" and an independently-created
// placeholder also named "Steve". Whichever one a plain unordered `.find()`
// happened to return first would decide the outcome; the placeholder must
// always win so it actually gets promoted rather than silently ignored.
test("when a real profile and a placeholder share a name, the placeholder is selected for promotion", () => {
  const profilesWithSharedName: Profile[] = [...localProfiles, { id: "p3", username: "SharedName", friendCode: null, createdAt: 0 }];
  const referencedTrainersWithSharedName: ReferencedTrainer[] = [
    ...localReferencedTrainers,
    { uuid: "p3", name: "SharedName", friendCode: null },
    { uuid: "placeholder-shared", name: "SharedName", friendCode: null },
  ];
  const decision = reconcileTrainer({ uuid: "incoming", name: "SharedName", friendCode: null }, profilesWithSharedName, referencedTrainersWithSharedName);
  assert.deepEqual(decision, { kind: "promote", placeholderUuid: "placeholder-shared" });
});
