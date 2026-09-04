# kiosk-electron changes for node-printer prebuild removal

**Repo:** `casechek/kiosk-electron`
**Companion plan:** [`remove-prebuilds-node-printer.md`](./remove-prebuilds-node-printer.md) — land that one and tag `v1.3.0` first.

## Context

`@casechek/node-printer` is dropping its prebuilt-binary pipeline (`prebuild` / `prebuild-install`, both deprecated) and will be compiled from source at install time. See the companion plan for the full rationale.

**Nothing about how the shipped binary is produced actually changes.** kiosk-electron has been compiling this addon from source in production all along:

- `package.json` pins `"@casechek/node-printer": "github:casechek/node-printer#v1.1.0"`, and the published `v1.1.0` release has **zero assets** — the 6 binaries are stranded in a duplicate draft release, and drafts aren't downloadable. So `prebuild-install` 404s on every install and falls through to `node-gyp rebuild`.
- The binary that actually ships comes from electron-forge's `prePackage` hook → the webpack plugin → `@electron/rebuild@3.7.2` → `@electron/node-gyp@10.2.0-electron.1`, running on this repo's runners. That has never involved a prebuild.
- Both runners already carry the full toolchain: `windows-2022` (pinned on `develop`, with the VS-2026 comment) and `macos-latest` with `actions/setup-python@v5` 3.11.

So the changes below are mostly **fixing pre-existing bugs that this work surfaces**, not adapting to a new dependency shape.

### What this repo gains

- Faster `npm ci`. Today `node-printer` has a `scripts.install`, which forces pacote's clone-side `npm install` (all its devDeps: jest, prebuild, node-gyp) *plus* a compile inside a throwaway git clone, before packing and compiling again in `node_modules`. Removing that script deletes the whole stage. Windows `npm ci` is **5m07s** today; expect **1–2 min back**. macOS `npm ci` is 42s → ~30–35s.
- ~12 fewer files code-signed and notarized per arch pass.
- No more `prebuild-install` in the lockfile — and with it, no `tar-fs` / `tar-stream` / `simple-get` / `tunnel-agent` in the tree of a package whose install script runs on the machine that signs production installers.

---

## Changes

### 1. Bump the dependency ref

```json
"@casechek/node-printer": "github:casechek/node-printer#v1.3.0",
```

### 2. `forge.config.ts` — `rebuildConfig`

Currently `rebuildConfig: {}`.

```ts
rebuildConfig: {
  // node-printer ships no prebuilds; always compile against these Electron headers.
  buildFromSource: true,
  // Stop @electron/rebuild littering bin/<platform>-<arch>-<abi>/, which
  // otherwise leaks a stale arm64 .node into the x64 package.
  disablePreGypCopy: true,
},
```

Notes on what is and isn't required:

- **`buildFromSource: true` is not strictly required** — `PrebuildInstall.usesTool()` reads `dependencies`, and `prebuild-install` is leaving that list, so it returns false anyway. Set it to document intent and to stay correct regardless of what a future dependency drags in.
- **`force: true` is *not* needed.** `alreadyBuiltByRebuild()` compares `build/Release/.forge-meta` against `` `${arch}--${ABI}` ``, so the arm64 pass writes `arm64--133`, the x64 pass reads it, mismatches, and rebuilds. Both passes already log `Preparing native dependencies for <arch>` today. Turning `force` on would defeat the skip in `electron-forge start` for no benefit.
- **`disablePreGypCopy: true` fixes an existing bug.** `@electron/rebuild`'s `replaceExistingNativeModule()` writes `bin/<platform>-<arch>-<ABI>/node-printer.node` and never cleans it. In the current CI logs the **x64** pass copies and code-signs *both* `bin/darwin-arm64-133/node-printer.node` and `bin/darwin-x64-133/node-printer.node` into the x64 installer. Harmless at runtime (only `lib/node_printer.node` is loaded) but the x64 DMG ships a stale arm64 binary and pays notarization on it.

### 3. `forge.config.ts` — replace the `afterCopy` recursive copy with an allowlist that throws

**This is the most important change here.** Two independent problems with the current hook:

**(a) It ships build artifacts.** It recursively copies the *entire* `node_modules/@casechek/node-printer` directory. From a recent CI run, these get signed and notarized inside `app.asar.unpacked/node_modules/@casechek/node-printer/`:

```
build/Release/obj.target/node_printer/src/node_printer.o
build/Release/obj.target/node_printer/src/node_printer_posix.o
build/Release/node_printer.node
bin/darwin-arm64-133/node-printer.node
bin/darwin-x64-133/node-printer.node      <- in BOTH the arm64 and x64 apps
lib/node_printer.node
examples/test.pdf
...
```

13 of the run's 471 signed files. On Windows the same hook copies `build/Release/*.obj`, `.pdb`, `node_printer.lib` and `.exp`.

**(b) It fails green.** The hook currently `console.error`s and calls `callback()` on failure, so a missing addon produces a **successful build and an app that crashes on launch** — the import is eager (`src/index.ts` → `services/ipc-main-events.service` → top-level `import printer from '@casechek/node-printer'`). For a kiosk fleet, silent-green is the worst possible outcome.

Use an allowlist so new junk can't creep in, and make a missing addon fatal:

```ts
afterCopy: [
  (buildPath, _electronVersion, _platform, _arch, callback) => {
    const src = path.resolve(__dirname, 'node_modules', '@casechek', 'node-printer');
    const dest = path.join(buildPath, 'node_modules', '@casechek', 'node-printer');

    // Runtime needs only the loader, the compiled addon, and the manifest.
    // Everything else (build/, bin/, src/, examples/, test/, tools/) is build
    // output or dev material: it inflates the bundle and, on macOS, is
    // individually code-signed and notarized for no reason.
    const files = [
      'package.json',
      'printer.js',
      path.join('lib', 'index.js'),
      path.join('lib', 'printer.js'),
      path.join('lib', 'node_printer.node'),
    ];

    try {
      for (const rel of files) {
        const from = path.join(src, rel);
        const to = path.join(dest, rel);
        if (!fs.existsSync(from)) {
          // Fail loudly: a missing addon here means @electron/rebuild did not run.
          throw new Error(`node-printer: expected ${rel} at ${from}`);
        }
        fs.mkdirSync(path.dirname(to), {recursive: true});
        fs.copyFileSync(from, to);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  },
],
```

This also replaces ~25 lines of hand-rolled recursion.

### 4. `.github/workflows/build-and-deploy.yml` — converge the Windows runner on `main`

`develop` pins `runs-on: windows-2022`; **`main` is still on `windows-latest`**, which resolves to the `windows-2025-vs2026` image (Visual Studio Enterprise 2026, MSVC v145). So production releases currently compile this NAN addon with a toolset it has never shipped against, while the pin added to prevent that sits unmerged.

Land `windows-2022` on `main`. Until then node-printer's CI — which mirrors `windows-2022` by design — gives no coverage for what production actually builds on.

### 5. `.github/workflows/build-and-deploy.yml` — assert the arch slice per pass

The macOS job runs on `macos-latest` (arm64) and publishes **both** `--arch=arm64` and `--arch=x64`. Cross-arch compilation is proven to work — the `darwin-x64` prebuild asset from `v1.3.0-pr21` was built on an arm64 runner and is `Mach-O 64-bit bundle x86_64`, `@electron/rebuild` guards on *platform* only (`if (this.rebuilder.platform !== process.platform) throw`) and passes arch straight through, and `cups-config --libs` is just `-lcups` with the SDK `libcups.2.tbd` carrying both slices.

But if it ever *did* break, it would break as a build error during the **second** publish — after the arm64 DMG has already gone to S3. Half-published release. Assert it:

```bash
APP=out/CasechekKiosk-darwin-$ARCH/CasechekKiosk.app
NODE=$APP/Contents/Resources/app.asar.unpacked/node_modules/@casechek/node-printer/lib/node_printer.node
file "$NODE"
case "$ARCH" in
  arm64) file "$NODE" | grep -q 'arm64'  || { echo "wrong slice"; exit 1; } ;;
  x64)   file "$NODE" | grep -q 'x86_64' || { echo "wrong slice"; exit 1; } ;;
esac
codesign -dv --verbose=2 "$NODE"
```

### 6. Unchanged — do not touch

- **`packagerConfig.asar.unpack: '**/node_modules/@casechek/node-printer/**'`** — still correct.
- **`osxSign.optionsForFile`** — still keys on `basename === 'node_printer.node'`, which still exists under this approach. (It would *not* under prebuildify, where the file is named `electron.abi133.armv8.node` — the `--force` re-sign would have silently stopped applying. Another reason from-source is the safer path here.) It now signs *one* `.node` instead of four.
- **`runs-on: windows-2022`** — must stay, and must also land on `main`. `@electron/rebuild@3.7.2` is pinned to the `@electron/node-gyp@10.2.0-electron.1` fork, which tops out at VS 2022, and `@electron-forge/core` requires `^3.7.0` even at 7.11.2 — so a forge bump alone won't lift it. See the follow-up below.
- **`actions/setup-python@v5`** on the mac job — keep it. It becomes unnecessary once node-printer's `python` shell-out is gone, but it's cheap insurance.

### 7. Optional cleanup

`electron-rebuild ^3.2.9` in `devDependencies` is the deprecated package name and dead weight — `@electron-forge/core` pulls `@electron/rebuild` itself. Remove it.

---

## Verification

**Phase 0 — baseline, before touching anything.** On a clean checkout:

```bash
npm ci
npm run package -- --arch=arm64
file out/CasechekKiosk-darwin-arm64/CasechekKiosk.app/Contents/Resources/app.asar.unpacked/node_modules/@casechek/node-printer/lib/node_printer.node
cat node_modules/@casechek/node-printer/build/Release/.forge-meta   # expect arm64--133
find out -path '*@casechek/node-printer*' -type f | sort > /tmp/before.txt
```

**Phase 1 — branch build, non-prod env.**

```bash
npm ci
grep -c 'prebuild-install' package-lock.json     # expect 0
npm run publish -- --target=@electron-forge/publisher-s3 --arch=arm64
npm run publish -- --target=@electron-forge/publisher-s3 --arch=x64
```

Assertions on the log and artifacts:

- `Preparing native dependencies for arm64` and `... for x64` both appear, each ~6s.
- No `prebuild-install` lines, no requests to `github.com/casechek/node-printer/releases/...`.
- The arch slice assertion (change 4) passes for both passes.
- `find … /node-printer -type f | sort` shows exactly **5 files** — no `build/`, no `bin/`, no `examples/`. Diff against `/tmp/before.txt`.
- Signed-file count drops by ~12 per arch.
- Record Windows `npm ci` wall-clock and compare against the 5m07s baseline.

**Phase 2 — negative tests.** These catch the silent failures:

```bash
# The afterCopy hook must now FAIL, not warn, when the addon is missing.
rm node_modules/@casechek/node-printer/lib/node_printer.node
npx electron-forge package --arch=arm64        # must exit non-zero

# Reproduce the stale-artifact hazard and confirm build/ never ships.
npx electron-forge package --arch=arm64
find out -path '*@casechek/node-printer/build*'   # must be empty
find out -path '*@casechek/node-printer/bin*'     # must be empty
```

**Phase 3 — real hardware.** Install the dev-env DMG on an Intel Mac and an Apple Silicon Mac, and the MSI on a Windows kiosk. Exercise `getPrinters`, `printDirect` (raw/ZPL to a Zebra), and the socket path. Run `spctl -a -vvv` on the `.app` — the addon's signature now comes solely from forge's `osxSign` rather than node-printer's own `codesign` step, so this is the one place where behavior genuinely changes.

**Phase 4 — rollback.** Revert the `package.json` ref to `#v1.3.0` (or `#v1.1.0`). node-printer's old tags and release assets stay in place for at least one release cycle.

---

## Critical files

- `package.json` — dependency ref; optionally drop `electron-rebuild`
- `forge.config.ts` — `rebuildConfig`, `afterCopy` allowlist that throws
- `.github/workflows/build-and-deploy.yml` — per-arch slice assertion

## Follow-up (separate spike, do not bundle)

This repo's `windows-2022` pin can potentially be lifted later with a one-line override. node-printer's CI mirrors the pin, so it deliberately provides **no** v145 signal — confirm the C++ is MSVC v145-clean with a one-off manual run (a temporary `windows-latest` leg on a throwaway branch) before attempting this:

```json
"overrides": { "@electron/node-gyp": "npm:node-gyp@^12.4.0" }
```

`@electron/rebuild@4.2.0` depends on real `node-gyp ^12.2.0` instead of the fork, but `@electron-forge/core` still requires `^3.7.0`, so the override is the lever. **Untested.** node-gyp 12 requires Node `^20.17.0 || >=22.9.0`; CI is on 20.20.2, which is fine.
