<!--
  Trainer/Profile page — profile identity, level/XP (player_progress_personal,
  already modeled), and per-medal progress (medal_progress_personal, new this
  pass — see docs/vue-migration-plan.md). Friendship/buddy tracking is
  explicitly NOT here: that's the separate "Best Buddy Tracker" roadmap item,
  and there's no current-buddy concept anywhere yet to build on.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Repository } from "../../data/repository";

const props = defineProps<{ repo: Repository }>();

const profiles = ref(props.repo.listProfiles());
const currentProfile = ref(props.repo.getCurrentProfile());
// Which profile's identity fields the edit form below is showing/editing —
// defaults to the current profile, but a "Rename" click on any row (Step 3
// below) repoints this without switching which profile is actually current.
const editingProfileId = ref(currentProfile.value.id);
const editingProfile = computed(() => profiles.value.find((p) => p.id === editingProfileId.value)!);
const usernameInput = ref(editingProfile.value.username);
const friendCodeInput = ref(editingProfile.value.friendCode ?? "");

function startEditing(profileId: string) {
  editingProfileId.value = profileId;
  const target = profiles.value.find((p) => p.id === profileId)!;
  usernameInput.value = target.username;
  friendCodeInput.value = target.friendCode ?? "";
}

async function saveProfile() {
  await props.repo.renameProfile(editingProfileId.value, usernameInput.value.trim() || "Trainer", friendCodeInput.value.trim() || null);
  profiles.value = props.repo.listProfiles();
  if (editingProfileId.value === currentProfile.value.id) currentProfile.value = props.repo.getCurrentProfile();
}

const newProfileUsername = ref("");
async function createNewProfile() {
  const name = newProfileUsername.value.trim();
  if (!name) return;
  await props.repo.createProfile(name, null);
  newProfileUsername.value = "";
  profiles.value = props.repo.listProfiles();
}

function switchTo(profileId: string) {
  if (profileId === currentProfile.value.id) return;
  props.repo.switchProfile(profileId);
  currentProfile.value = props.repo.getCurrentProfile();
  editingProfileId.value = currentProfile.value.id;
  usernameInput.value = currentProfile.value.username;
  friendCodeInput.value = currentProfile.value.friendCode ?? "";
  // Every other page's data (Collection, Dex grid, Stats, Tags) reads
  // through the same repo instance's cache, which switchProfile just
  // repointed — those pages re-render correctly on their own next
  // interaction/mount, same as any other in-memory-cache mutation elsewhere
  // in this app. No extra reload needed here.
}

async function deleteProfileRow(profileId: string) {
  if (profiles.value.length <= 1) return; // delete button is hidden in this case anyway, this guard is defense-in-depth
  if (!confirm(`Delete this profile? All of its Dex progress, collection, and tags will be permanently removed.`)) return;
  await props.repo.deleteProfile(profileId);
  profiles.value = props.repo.listProfiles();
  currentProfile.value = props.repo.getCurrentProfile();
  editingProfileId.value = currentProfile.value.id;
  usernameInput.value = currentProfile.value.username;
  friendCodeInput.value = currentProfile.value.friendCode ?? "";
}

const progress = ref(props.repo.getPlayerProgress());
const levelInput = ref(progress.value?.currentLevel ?? "");
const xpInput = ref(progress.value?.totalXp ?? "");

function saveProgress() {
  const level = levelInput.value === "" ? null : Number(levelInput.value);
  const xp = xpInput.value === "" ? null : Number(xpInput.value);
  props.repo.setPlayerProgress(level, xp);
  progress.value = props.repo.getPlayerProgress();
}

const medalProgress = ref(props.repo.listMedalProgress());
// Sort event medals last, then alphabetically — event medals are one-off
// completion badges, standard medals are the ones worth seeing progress on
// first.
const sortedMedals = computed(() =>
  [...medalProgress.value].sort((a, b) => {
    if (a.medal.isEventMedal !== b.medal.isEventMedal) return a.medal.isEventMedal ? 1 : -1;
    return a.medal.name.localeCompare(b.medal.name);
  }),
);

function nextTarget(tiers: { rank: number; target: number | null }[], currentRank: number): number | null {
  const next = tiers.find((t) => t.rank === currentRank + 1);
  return next ? next.target : null;
}

function updateCount(medalSlug: string, tiers: { rank: number; target: number | null }[], currentRank: number, count: number) {
  // Advance rank automatically once the count clears the next tier's
  // target — mirrors how the game itself promotes a medal's tier the
  // instant its threshold is crossed, not on a separate manual step.
  let rank = currentRank;
  for (const tier of [...tiers].sort((a, b) => a.rank - b.rank)) {
    if (tier.target !== null && count >= tier.target) rank = tier.rank;
  }
  props.repo.setMedalProgress(medalSlug, rank, count);
  medalProgress.value = props.repo.listMedalProgress();
}
</script>

<template>
  <h2>Trainer</h2>

  <fieldset>
    <legend>Profiles</legend>
    <ul class="profile-list">
      <li v-for="p in profiles" :key="p.id" class="profile-row">
        <span class="profile-row-name">
          {{ p.username }}
          <strong v-if="p.id === currentProfile.id">(current)</strong>
        </span>
        <div class="profile-row-actions">
          <button type="button" :disabled="p.id === currentProfile.id" @click="switchTo(p.id)">Switch to</button>
          <button type="button" @click="startEditing(p.id)">Rename</button>
          <button type="button" v-if="profiles.length > 1" @click="deleteProfileRow(p.id)">Delete</button>
        </div>
      </li>
    </ul>
    <div class="input-grid">
      <label class="field">
        New profile name
        <input type="text" maxlength="20" v-model="newProfileUsername" @keydown.enter="createNewProfile" />
      </label>
      <button type="button" @click="createNewProfile">+ New profile</button>
    </div>
  </fieldset>

  <fieldset>
    <legend>Identity — editing {{ editingProfile.username }}</legend>
    <div class="input-grid">
      <label class="field">
        Trainer name
        <input type="text" maxlength="20" v-model="usernameInput" @change="saveProfile" />
      </label>
      <label class="field">
        Friend code
        <input type="text" placeholder="0000 0000 0000" v-model="friendCodeInput" @change="saveProfile" />
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>Level &amp; XP</legend>
    <div class="input-grid">
      <label class="field">
        Level
        <input type="number" min="1" max="50" v-model="levelInput" @change="saveProgress" />
      </label>
      <label class="field">
        Total XP
        <input type="number" min="0" v-model="xpInput" @change="saveProgress" />
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>Medals ({{ sortedMedals.filter((m) => m.progress.currentCount > 0).length }} / {{ sortedMedals.length }} started)</legend>
    <div class="medal-grid">
      <div v-for="entry in sortedMedals" :key="entry.medal.slug" class="medal-tile">
        <strong class="medal-tile-name">{{ entry.medal.name }}</strong>
        <span class="gap-note">{{ entry.medal.description }}</span>
        <div class="medal-progress">
          <label>
            Count
            <input
              type="number"
              min="0"
              :value="entry.progress.currentCount"
              @change="updateCount(entry.medal.slug, entry.tiers, entry.progress.currentRank, Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </div>
        <span class="medal-tile-tier" v-if="nextTarget(entry.tiers, entry.progress.currentRank) !== null">
          Tier {{ entry.progress.currentRank }} → next at {{ nextTarget(entry.tiers, entry.progress.currentRank) }}
        </span>
        <span class="medal-tile-tier" v-else-if="entry.progress.currentRank > 0"> Tier {{ entry.progress.currentRank }} (max) </span>
      </div>
    </div>
  </fieldset>
</template>

<!-- .medal-grid/.medal-tile/.medal-progress are styled globally in src/style.css. -->
