// Shared FNV-1a string hash: not cryptographic, just needs to change
// whenever its input content does. Used both by
// scripts/ingest/write/reference-json.ts (to bake a version marker into
// src/data/reference-version.ts at build time) and, historically, by
// reference-sync.ts's own runtime check — see that file's comment for why
// the runtime side no longer calls this directly.
export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
