# Release Checklist

This document is the **canonical owner** for the release workflow. Use this checklist when prepared to ship a new version of the app to friends or staging.

---

## 1. Run Tests & Validation

Ensure the app is fully functional and regression-free before initiating a release:

* Run unit tests (migrations, sync, round-trips):
  ```sh
  npm run test
  ```
* Run static analysis and lint checks:
  ```sh
  npm run lint
  ```

---

## 2. Version Bump & Changelog

Always bump the app version on master. 

* Choose the bump type:
  * **`minor`** for feature releases (e.g. new tracking options, stats lenses).
  * **`patch`** for bug fixes or pure data corrections.
* Run the version bump script:
  ```sh
  npm run version:bump -- minor  # or patch
  ```
  *(Add `--dry-run` to preview changes without writing them.)*
  
  > [!NOTE]
  > This updates `package.json` semver and `android/app/build.gradle` `versionName` together, and increments `versionCode` by exactly 1.

* Update [CHANGELOG.md](file:///home/nick/Repos/GoBuddy/CHANGELOG.md):
  * Create a new version header matching the bumped semver.
  * Move Unreleased changes under that header with the current date.
* Update feature specifications:
  * Update [features.md](features.md) if any shipped feature scope or planned items changed with this release.

---

## 3. Generate Release Build

The production APK **is not signed automatically**. `npm run android:release`
(`cargo tauri android build`) produces an unsigned APK — Tauri's generated
`src-tauri/gen/android/app/build.gradle.kts` has no `signingConfigs` block
wired to a keystore (unlike the old Capacitor-era Gradle setup, which read
`~/.android-keystores/keystore.properties` automatically). This is a known
gap tracked in [docs/roadmap.md](roadmap.md)'s "Android release APK is
unsigned" entry — wiring up an automatic Gradle signing config is the
long-term fix; manual signing below is the interim process.

* Set the environment variables:
  ```sh
  export JAVA_HOME=/opt/android-studio/jbr   # or wherever JDK 21+ lives
  export ANDROID_HOME=$HOME/Android/Sdk
  ```
* Build the release APK:
  ```sh
  npm run android:release
  ```
  This produces an **unsigned** APK at:
  `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`
* Manually sign it with the existing stable key before distributing (needed
  for in-place upgrades to work) using `zipalign` + `apksigner` from the
  Android SDK build-tools, against the keystore at
  `~/.android-keystores/pogobuddy-release.jks`:
  ```sh
  zipalign -p 4 app-universal-release-unsigned.apk app-universal-release-aligned.apk
  apksigner sign --ks ~/.android-keystores/pogobuddy-release.jks app-universal-release-aligned.apk
  ```
  Adjust the keystore alias/password flags for your actual keystore setup —
  see `~/.android-keystores/` for the exact key details. The signed output
  (`app-universal-release-aligned.apk`) is the file to distribute.

---

## 4. Manual Upgrade Verification

Perform a manual upgrade-install check on a physical Android device before distribution to ensure no data-loss or boot-brick bugs were introduced:

1. **Back up current device state:** In the current installed app, go to **Settings → Export** and save a personal data JSON snapshot.
2. **Install new APK over existing:** Sideload the freshly-built release APK.
3. **Verify data survival:** Open the app and verify that:
   * The app boots successfully without DB error screens.
   * All previously-tracked Pokémon achievements and settings are preserved.
   * **Settings → About** shows the updated release version.

---

## 5. Publish & Git Tag

Commit changes and tag the release in git:

* Commit the version bump and changelog:
  ```sh
  git add package.json package-lock.json android/app/build.gradle CHANGELOG.md docs/features.md docs/roadmap.md
  git commit -m "Bump version to X.Y.Z"
  ```
* Create and push git tag:
  ```sh
  git tag -a vX.Y.Z -m "Release vX.Y.Z"
  git push origin master --tags
  ```

---

## 6. Distribute

* Deliver the `.apk` file directly to friends.
* **Important Reminder:** Remind users to **export a backup** from Settings before installing the update, as a habit to safeguard personal data.
