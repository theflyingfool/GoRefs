// Manual cross-device transfer of personal data — deliberately not a live
// sync. Export writes a file the user
// places wherever they like (Drive, email, USB — the app never talks to any
// cloud service directly); import reads one back in. The platform-specific
// file I/O is shared (src/shared/file-download.ts); the format itself comes
// from Repository.exportPersonalData/importPersonalData, defined once in
// src/data/in-memory-store.ts so both backends get it for free.

import { CURRENT_PERSONAL_SCHEMA_VERSION } from "../../db/schema";
import type { ExportBundle, PersonalDataExport, Repository } from "../../data/repository";
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

/** Reads and validates a picked ExportBundle file; the caller (Settings UI) handles reconciliation (planTrainerImport/applyTrainerImport) and confirmation. */
export async function readExportBundleFile(file: File): Promise<{ bundle: ExportBundle; schemaMismatch: boolean }> {
  const text = await file.text();
  const bundle = JSON.parse(text) as ExportBundle;
  if (typeof bundle.schemaVersion !== "number" || !Array.isArray(bundle.trainers)) {
    throw new Error("This doesn't look like a GoBuddy trainer-export bundle.");
  }
  return { bundle, schemaMismatch: bundle.schemaVersion !== CURRENT_PERSONAL_SCHEMA_VERSION };
}
