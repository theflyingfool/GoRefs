// Generic "hand the user a file" flow, shared by any feature that needs to
// let the user save a file for later use outside the app (Settings' personal
// data export, Coverage Report's per-gap CSV export).
//
// One mechanism on every platform this app now ships on (desktop, Android):
// plugin-dialog's save() opens a native save dialog and returns the path the
// user picked. On Android this is backed by the Storage Access Framework, so
// "Save to Drive" (or any other app registered as a document provider) is one
// of the destinations the user can pick — no dedicated share-sheet plugin
// needed (Tauri doesn't ship one; confirmed against the full official plugin
// list during Sub-project 6's design). plugin-fs's writeTextFile() then
// writes the content to that path.
//
// Scope note: plugin-dialog's save() command itself calls the fs plugin's
// scope API (`allow_file`) on the path the user picked, at runtime, as long
// as both plugins are registered (see src-tauri/src/lib.rs) — there is no
// Cargo feature that does this (verified against tauri-plugin-fs 2.5.1's
// source/manifest; no "dialog" feature exists on that crate in any 2.x
// release). Separately, the fs plugin's command-level ACL still has to be
// granted explicitly: "fs:default" only covers the app's own data
// directories, not write_text_file, so
// src-tauri/capabilities/default.json also grants "fs:allow-write-text-file".

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export interface SaveTextFileOptions {
  suggestedName: string;
  mimeType: string;
  /** Shown as the save dialog's title. */
  description: string;
}

export async function downloadTextFile(content: string, options: SaveTextFileOptions): Promise<void> {
  const path = await save({
    title: options.description,
    defaultPath: options.suggestedName,
  });
  if (path === null) {
    return; // user cancelled
  }
  await writeTextFile(path, content);
}
