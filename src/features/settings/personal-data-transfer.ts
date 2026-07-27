// Manual cross-device transfer of personal data — deliberately not a live
// sync. Export writes a file the user
// places wherever they like (Drive, email, USB — the app never talks to any
// cloud service directly); import reads one back in. The platform-specific
// file I/O is shared (src/shared/file-download.ts); the format itself comes
// from Repository.exportPersonalData/importPersonalData, defined once in
// src/data/in-memory-store.ts so both backends get it for free.

import { CURRENT_PERSONAL_SCHEMA_VERSION } from "../../db/schema";
import type { ExportBundle, PersonalDataExport, Repository, TrainerImportSummary } from "../../data/repository";
import { downloadTextFile } from "../../shared/file-download";

export { downloadTextFile };

function fileName(): string {
  return `gobuddy-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

export async function exportPersonalData(repo: Repository): Promise<void> {
  const data = repo.exportPersonalData();
  const json = JSON.stringify(data, null, 2);
  await downloadTextFile(json, {
    suggestedName: fileName(),
    mimeType: "application/json",
    description: "GoBuddy export",
  });
}

// Schema version 7 switched every personal-table timestamp from an ISO-8601
// TEXT string to epoch-ms (see schema.ts's CURRENT_PERSONAL_SCHEMA_VERSION
// comment). An export file from before that (schemaVersion < 7) still has
// string timestamps — merging those straight into importPersonalData's
// number-typed updatedAt/recordedAt fields would compare a number against a
// string (always false/NaN) and corrupt the column the moment it's written
// back to SQLite's INTEGER-affinity column. Converting here, once, up front,
// means importPersonalData never has to know about the old format.
function isoToEpochMs(value: string): number {
  return new Date(value).getTime();
}

function convertLegacyTimestamps(data: PersonalDataExport): PersonalDataExport {
  return {
    ...data,
    speciesPersonal: Object.fromEntries(
      Object.entries(data.speciesPersonal).map(([slug, row]) => [slug, { ...row, updatedAt: isoToEpochMs(row.updatedAt as unknown as string) }]),
    ),
    formPersonal: Object.fromEntries(
      Object.entries(data.formPersonal).map(([slug, row]) => [slug, { ...row, updatedAt: isoToEpochMs(row.updatedAt as unknown as string) }]),
    ),
    megaPersonal: data.megaPersonal
      ? Object.fromEntries(
          Object.entries(data.megaPersonal).map(([slug, row]) => [slug, { ...row, updatedAt: isoToEpochMs(row.updatedAt as unknown as string) }]),
        )
      : data.megaPersonal,
    formBackgroundPersonal: data.formBackgroundPersonal?.map((row) => ({ ...row, updatedAt: isoToEpochMs(row.updatedAt as unknown as string) })),
    medalProgress: data.medalProgress
      ? Object.fromEntries(
          Object.entries(data.medalProgress).map(([slug, row]) => [slug, { ...row, updatedAt: isoToEpochMs(row.updatedAt as unknown as string) }]),
        )
      : data.medalProgress,
    pokemonInstances: data.pokemonInstances?.map((row) => ({
      ...row,
      recordedAt: isoToEpochMs(row.recordedAt as unknown as string),
      caughtAt: row.caughtAt ? isoToEpochMs(row.caughtAt as unknown as string) : null,
      updatedAt: isoToEpochMs(row.updatedAt as unknown as string),
    })),
    playerProgress: data.playerProgress ? { ...data.playerProgress, updatedAt: isoToEpochMs(data.playerProgress.updatedAt as unknown as string) } : data.playerProgress,
    playerProgressLog: data.playerProgressLog?.map((row) => ({ ...row, recordedAt: isoToEpochMs(row.recordedAt as unknown as string) })),
  };
}

/** Reads and validates a picked file; the caller (Settings UI) handles confirmation and the actual importPersonalData call. */
export async function readPersonalDataFile(file: File): Promise<{ data: PersonalDataExport; schemaMismatch: boolean }> {
  const text = await file.text();
  let data = JSON.parse(text) as PersonalDataExport;
  if (typeof data.schemaVersion !== "number" || !data.speciesPersonal || !data.formPersonal || !data.appSettings) {
    throw new Error("This doesn't look like a GoBuddy export file.");
  }
  if (data.schemaVersion < 7) data = convertLegacyTimestamps(data);
  return { data, schemaMismatch: data.schemaVersion !== CURRENT_PERSONAL_SCHEMA_VERSION };
}

// Builds the file format written by both "Export current" and "Export all
// trainers" (see design doc §5 -- one export function, called once per
// trainer, wrapped into one bundle regardless of how many profileIds are
// passed). The device's full referenced_trainer registry is fetched ONCE via
// the real Repository.listReferencedTrainers() method (not re-derived per
// trainer) and attached to every TrainerExport in the bundle.
export function buildExportBundle(repo: Repository, profileIds: string[]): ExportBundle {
  const referencedTrainers = repo.listReferencedTrainers();
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
    trainers: profileIds.map((id) => ({ ...repo.exportTrainer(id), referencedTrainers })),
    tags: repo.listTags().map((t) => ({ name: t.name })),
  };
}

// Old (pre-7b) export files are a bare PersonalDataExport -- no `.trainers`
// array, no trainer-identity concept at all. Detecting that shape here
// (rather than only accepting the new ExportBundle wrapper) is what keeps
// those old backups importable after this app updates -- see this module's
// readExportBundleFile doc comment and CLAUDE.md's backward-compatibility
// invariant.
function isBarePersonalDataExport(data: unknown): data is PersonalDataExport {
  const candidate = data as PersonalDataExport;
  return (
    typeof candidate?.schemaVersion === "number" &&
    !Array.isArray((candidate as unknown as ExportBundle).trainers) &&
    !!candidate.speciesPersonal &&
    !!candidate.formPersonal &&
    !!candidate.appSettings
  );
}

// Wraps a legacy bare PersonalDataExport as a single-trainer ExportBundle so
// it can flow through the same planTrainerImport/applyTrainerImport
// machinery as every other import, rather than needing a second, parallel
// import code path. The synthetic trainer's uuid/name/friendCode are set to
// match the CURRENT profile on THIS device exactly (not anything from the
// file, which never carried trainer identity) -- that guarantees
// reconcileTrainer resolves it to "auto-merge" against the current profile,
// reproducing the pre-7b behavior of importPersonalData always merging into
// whatever profile was current, with no trainer-identity concept.
function wrapLegacyExportAsBundle(data: PersonalDataExport, currentProfile: { id: string; username: string; friendCode: string | null }): ExportBundle {
  return {
    exportedAt: data.exportedAt,
    schemaVersion: data.schemaVersion,
    trainers: [
      {
        ...data,
        trainerUuid: currentProfile.id,
        trainerName: currentProfile.username,
        trainerFriendCode: currentProfile.friendCode,
        referencedTrainers: [],
      },
    ],
    tags: data.tags ?? [],
  };
}

/**
 * Reads and validates a picked import file; the caller (Settings UI) handles
 * reconciliation (planTrainerImport/applyTrainerImport) and confirmation.
 * Accepts both the current ExportBundle format and a pre-7b bare
 * PersonalDataExport file (synthesized into a single-trainer bundle that
 * merges into `repo`'s current profile -- see wrapLegacyExportAsBundle).
 */
export async function readExportBundleFile(file: File, repo: Repository): Promise<{ bundle: ExportBundle; schemaMismatch: boolean }> {
  const text = await file.text();
  const data = JSON.parse(text) as ExportBundle | PersonalDataExport;
  let bundle: ExportBundle;
  if (typeof data.schemaVersion === "number" && Array.isArray((data as ExportBundle).trainers)) {
    bundle = data as ExportBundle;
  } else if (isBarePersonalDataExport(data)) {
    bundle = wrapLegacyExportAsBundle(data.schemaVersion < 7 ? convertLegacyTimestamps(data) : data, repo.getCurrentProfile());
  } else {
    throw new Error("This doesn't look like a GoBuddy trainer-export bundle.");
  }
  return { bundle, schemaMismatch: bundle.schemaVersion !== CURRENT_PERSONAL_SCHEMA_VERSION };
}

/**
 * Reads a picked file, runs 7b's reconciliation flow (prompting the user via
 * window.confirm for any trainer that matched an existing local profile by
 * name only -- see planTrainerImport/applyTrainerImport), and applies the
 * import. Shared by Settings' "Import personal data" and the compare view's
 * "Import a trainer" button (Sub-project 7c) -- one import code path
 * regardless of caller, per design spec section 2.
 */
export async function importTrainerBundleFile(repo: Repository, file: File): Promise<TrainerImportSummary> {
  const { bundle, schemaMismatch } = await readExportBundleFile(file, repo);
  if (schemaMismatch) {
    const proceed = window.confirm(
      `This export is from schema version ${bundle.schemaVersion}, but this app is on version ${CURRENT_PERSONAL_SCHEMA_VERSION}. Some fields may not match. Import anyway?`,
    );
    if (!proceed) throw new Error("Import cancelled.");
  }

  const plan = await repo.planTrainerImport(bundle);
  const resolutions: Record<string, "merge" | "separate"> = {};
  for (const entry of plan.entries) {
    if (entry.decision.kind !== "ask-merge-or-separate") continue;
    const merge = window.confirm(
      `"${entry.trainerName}" matches an existing local trainer with the same name. Merge them as one trainer? (Cancel treats them as two separate trainers.)`,
    );
    resolutions[entry.trainerUuid] = merge ? "merge" : "separate";
  }

  return repo.applyTrainerImport(bundle, resolutions);
}
