# Installing PoGo Buddy

There are two ways to run PoGo Buddy: sideloaded on Android, or as a native
desktop app. Both are fully local — no accounts, no cloud sync, nothing leaves
your device either way. Pick whichever fits you; you can use both and move
data between them (see "Moving data between phone and desktop" below).

## Android (sideloaded app)

This app is sideloaded, not installed from the Play Store — that's normal
for a small local-only tracker like this, not a sign anything's wrong.

### First install

1. You'll be given an `.apk` file directly (not a store link).
2. Tapping it will show an "unknown sources" or "install unknown apps"
   prompt the first time — allow it for whichever app you used to open the
   file (Files, Chrome, etc.). This is Android's normal gate for anything
   not from the Play Store, not specific to this app.
3. You may also see a Play Protect warning ("this app wasn't scanned" or
   similar) — this is expected for a small sideloaded app with no Play
   Store listing. Choose install anyway.

### Updating to a new version

Every release is signed with the same dedicated release key, so installing a
new APK over an old one should preserve your data going forward — a
signing-key mismatch is the one thing that would silently block an in-place
update, and this key isn't changing again (it's backed up outside the
project; see [features.md#5-data-safety-net](features.md#5-data-safety-net)).

**Export before every update anyway.** A stable signing key rules out one
failure mode, not all of them — a botched migration or a corrupted database
doesn't care whether the key matches. Exporting takes a few seconds; treat
it as habit, not a one-time precaution.

If a signing key mismatch happens, the install appears to succeed but your
phone silently keeps the old version — no error will appear. Before updating,
check the version in **Settings → About**. After reopening the app, check it
again — if it's unchanged, message the owner immediately. **Don't uninstall**
— that's the only thing that actually erases your data.

### If something goes wrong

If the app fails to open (a "couldn't open the database" message or
similar), the app itself should offer a one-time "export personal data"
option on that failure screen — use it before doing anything else. If for
any reason that doesn't appear, **don't uninstall — message the owner
before doing anything else**, since uninstalling erases the app's data
permanently. This is exactly why exporting regularly matters more than it
might seem.

## Desktop

The same app also runs as a native desktop app, built with Tauri — no phone
required.

> **Heads up:** running this from source now requires more than just
> Node.js. `npm run dev` launches the full Tauri desktop app (`cargo tauri
> dev` under the hood), which needs the same Rust/native toolchain as
> building the Android app — this is a materially heavier setup than the
> old plain-Vite dev server this guide used to describe, and this guide
> doesn't currently walk through installing that toolchain. A packaged,
> ready-to-run desktop build (no toolchain needed) is planned but not yet
> decided/built — see docs/roadmap.md's "Desktop packaging/distribution
> format" entry. Until then, running from source is a developer-level task;
> ask the owner if you just want to try the desktop version.

### First run

1. Install [Node.js](https://nodejs.org) if you don't already have it
   (v18.19+ or v20+), plus the Rust toolchain and platform build
   dependencies Tauri requires (see
   [docs/commands.md](./commands.md) and
   [docs/architecture.md](./architecture.md)).
2. In a terminal:
   ```sh
   git clone <this repo>
   cd GoBuddy
   npm install
   npm run dev
   ```
   If you downloaded this as a ZIP instead of using `git clone`, `npm
   install` will print a git error (from a setup step that needs a `.git`
   folder) — that's safe to ignore, `npm run dev` still works fine without
   it.
3. The app opens in its own native window automatically — there's no URL
   to open in a browser.

All data is stored locally on disk in a real SQLite file — nothing leaves
your computer, same guarantee as the phone app.

### Updating

Pull the latest code (`git pull`, or re-download and replace if you're on a
ZIP) and run `npm install` again in case dependencies changed, then
`npm run dev` as before. **Export from Settings before updating**, same
habit as the Android side — a desktop-side migration issue is just as
capable of needing a fallback as an Android one.

## Back up your data

**Your Pokédex progress lives only on this device — there is no cloud sync,
by design.** Exporting is your only backup, on either platform:

- Open **Settings → Export** and save the file somewhere you'll find it
  again (email it to yourself, save to Drive, etc.).
- Do this after any real play session where you've caught something worth
  keeping a record of, not just once.

## Moving data between phone and desktop

There's no sync between the two — by design, per the no-network-calls
constraint. Instead:

- **Export** on one (phone or desktop) writes a JSON snapshot of your
  personal data (catch/achievement state, not reference data). On both
  Android and desktop it's handed to the native save/share dialog.
- **Import** on the other reads that file back in, overwriting matching
  entries (anything not in the file is left alone). A schema-version
  mismatch between the file and the running app triggers a warning before
  it proceeds.

The same file format works in both directions, so you can export from your
phone, edit on desktop, and import back — or the reverse.
