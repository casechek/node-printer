# Remove prebuilds from node-printer, build from source

**Repo:** `casechek/node-printer`
**Companion plan:** [`remove-prebuilds-kiosk-electron.md`](./remove-prebuilds-kiosk-electron.md) — land this one first.

## Context

`@casechek/node-printer` is a NAN-based native addon (CUPS on macOS, Win32 spooler on Windows). It ships prebuilt `.node` tarballs on GitHub Releases via `prebuild`, downloaded at install time by `prebuild-install`.

**Both `prebuild` and `prebuild-install` are deprecated and unmaintained.** Upstream directs users to `prebuildify` + `node-gyp-build`. The maintenance cost is already visible here: four dependabot branches for `tar-fs` alone plus `axios`, all arriving through `prebuild-install`'s tree.

### The decisive finding

**The prebuild pipeline has never delivered a single working binary to the consumer — not once in its history.** Three independent bugs, verified against the live GitHub API:

| Tag | Published assets | Why it failed |
|---|---|---|
| **v1.1.0** ← *kiosk pins this today* | **0** | `publish-release` created a *second* release (id `231207482`) instead of un-drafting the first. The 6 binaries are stranded in a draft (id `231207368`), and drafts aren't downloadable. |
| v1.2.0 | 6 | Named with `{module_name}`/`{node_abi}`, which `prebuild-install` never requests — fixed in `f72927d`. |
| v1.3.0-pr21 | 7 | Names finally correct, but `v1.3.0` was never released and `f72927d` is still unmerged on `feat/PROC-2640/modernize-deps`. |

So `kiosk-electron` has always fallen through to `node-gyp rebuild`. **From-source compilation is not a proposal — it is the status quo, in production, on every kiosk.** Removing prebuilds ratifies what already happens and deletes machinery that has only ever produced silent failures.

### Why not prebuildify

`prebuildify` + `node-gyp-build` is the right answer *if* you publish to a registry. We are staying on git installs (`github:casechek/node-printer#vX.Y.Z`), which means prebuildify's binaries would have to be **committed to git** — and with NAN (no N-API), that's one binary per ABI × arch × runtime, forever, in a public repo. That trades a deprecated dependency for binaries in version control and keeps the `ELECTRON_TARGET`-must-track-kiosk coupling that has already failed twice.

It also introduces a hazard from-source builds don't have: `node-gyp-build` resolves `build/Release/*.node` **before** `prebuilds/`, and `@electron/rebuild` does nothing when it finds a matching prebuild. A stale `build/` in the consumer then wins and `dlopen` aborts at app launch. Today `node-gyp` always overwrites, so this can't happen.

### What removal buys

- **Production dependency tree: 36 packages → 1** (`nan`). Gone: `prebuild-install`, `tar-fs`, `tar-stream`, `simple-get`, `tunnel-agent`, `rc`, `readable-stream`, `node-abi`. For a HIPAA-scoped app whose install script extracts remote tarballs on the machine that signs production installers, deleting that surface is the headline — and it ends the dependabot stream.
- **ABI drift becomes structurally impossible.** The addon is always compiled against the Electron actually in use. No `ELECTRON_TARGET`, no ABI table, no cross-repo invariant.
- **Kiosk CI gets *faster*.** `scripts.install` existing forces pacote's clone-side `npm install` (all devDeps: jest, prebuild, node-gyp) plus a compile inside a throwaway git clone, before packing and compiling again. Deleting the script removes that whole stage. Windows `npm ci` is 5m07s today; expect 1–2 min back. The compile that produces the shipped artifact (~6s mac, ~14s Windows) is unchanged.
- Deletes the 5-job release workflow, the per-PR draft-release churn (11 tags for 4 versions), and the Apple-cert step here.

### Decisions taken

- **Stay on git installs.** No registry, no `.npmrc`, no tokens.
- **NAN stays.** N-API migration is a separate ticket. It would make prebuildify genuinely cheap (one binary per platform/arch, no ABI matrix) — revisit then, or if a second consumer appears, or if we start publishing to a registry for other reasons.
- **Drop 32-bit Windows (`ia32`).** Nothing builds it — kiosk's `maker-wix` is hardcoded `arch: 'x64'` and `MakerSquirrel` defaults to the x64 host — so the `win32-ia32` archive has served nothing. Only the `Gruntfile.js` ia32 tasks reference it, and those are being deleted.
- **CI mirrors kiosk-electron exactly** — runners `macos-latest` and `windows-2022`; Node 20; Electron 35.7.5. No canary or forward-looking legs.

---

## Changes

### 1. `binding.gyp` — static source list, drop the `python` shell-out

Line 23 is `'<!@(["python", "tools/getSourceFiles.py", "src", "cc"])'`. gyp's `ExpandVariables` runs `contents[0]` — the literal string `python` — as a **bare PATH lookup by gyp itself**, independent of node-gyp's own `python3`-then-`python` discovery. It works on today's runners by accident of the images. A stock Mac has no bare `python` (removed in macOS 12.3); Windows dev boxes may resolve the Store `python.exe` alias, which exits non-zero. Once prebuilds are gone there is no fallback, so this ships in the same PR.

The script is just `ls src/*.cc`. `src/` has exactly three `.cc` files, and the existing per-OS `sources/` exclusion conditions key off filename suffixes and keep working unchanged:

```python
'sources': [
  'src/node_printer.cc',
  'src/node_printer_posix.cc',
  'src/node_printer_win.cc',
],
```

- Do **not** change `python` → `python3` — that breaks Windows dev boxes where only `python` exists.
- **Keep** the `module_name%` / `module_path%` `%` sigils. They are the default-if-unset that makes removing the `binary` block safe: verified that with the `binary` block gone, the generated `build/action_after_build.target.mk` still contains `$(srcdir)/lib/node_printer.node` — package root, not `build/lib`.
- Raise `MACOSX_DEPLOYMENT_TARGET` from `"10.14"` to `"11.0"`. Electron 35 requires macOS 11+ anyway, and Apple keeps ratcheting the floor — 10.14 buys nothing and risks a future hard error during a *kiosk release*, not in our CI.

Then delete `tools/getSourceFiles.py`.

### 2. `package.json` — delete `scripts.install` entirely, add nothing

npm injects the build itself. `@npmcli/arborist`'s `#addToBuildSet`:

```js
const isGyp = gypfile !== false && !install && !preinstall && await isNodeGypPackage(node.path)
if (bin || preinstall || install || postinstall || prepare || isGyp) {
  if (isGyp) { scripts.install = defaultGypInstallScript; node.package.scripts = scripts }
  set.add(node)
}
```

`defaultGypInstallScript` is literally `'node-gyp rebuild'`. So `npm ci` still builds `lib/node_printer.node` here, and `npm test` still works.

- **Why not `"install": "node-gyp rebuild"`?** Functionally identical at install time, but it keeps pacote's clone-side prepare-install alive. `GitFetcher#prepareDir` skips its clone-side `npm install` only if the manifest has **none of** `postinstall｜build｜preinstall｜install｜prepack｜prepare`. That's the biggest cost available to delete.
- **Why not `prepare`?** It runs in the temp clone against the host Node (wrong ABI, overwritten anyway), it *forces* the clone-side devDep install, and it silently stops running the day we publish to a registry.

Also delete `scripts.prebuild`, `scripts.prebuild-electron`, the `binary` block, `dependencies.prebuild-install`, and `devDependencies.{prebuild,prebuild-ci,node-abi}` (`prebuild-ci` was never invoked by any script or workflow).

Add `devDependencies: {"node-gyp": "^12.4.0"}` so `node_modules/.bin/node-gyp` deterministically wins for this repo's own builds. `node-gyp` is currently on `PATH` only because `prebuild` depends on it; remove `prebuild` without this and we silently fall back to npm's bundled node-gyp 10.x. 12.1.0 is the first release that understands VS 2026, so this also keeps local builds working for anyone on a machine with only VS 2026 installed, even though CI pins VS 2022.

Add a `files` allowlist. **`binding.gyp` is load-bearing** — `isNodeGypPackage()` stats `<installed path>/binding.gyp`, so omitting it silently disables the build. npm only auto-includes `package.json`, `README*`, `LICEN[CS]E*`, and `main`:

```json
"files": ["binding.gyp", "lib/", "src/", "types/", "printer.js"]
```

Then **delete `.npmignore`** — with `files` present, `npm-packlist`'s `filterEntries()` nulls out both `.npmignore` and `.gitignore`, so keeping it is just a second place to get it wrong. Note `.npmignore` doesn't exclude `build/` today, and pacote's clone-side install creates `build/` before packing — which is why `examples/test.pdf` and object files currently reach the consumer and get code-signed.

### 3. `lib/printer.js:6-13` — fix the loader

Drop the unreachable `require('./node_printer_'+process.platform+'_'+process.arch+'.node')` fallback. Nothing has produced those names since Grunt, and it converts a clear "addon not built" condition into a confusing `MODULE_NOT_FOUND`. Fail with a message naming `npm rebuild @casechek/node-printer`. This also fixes `printer_helper` being declared twice in the same `var` statement (lines 1 and 7).

### 4. Delete

| Path | Why safe |
|---|---|
| `.github/workflows/prebuild.yml` | replaced by `ci.yml` below |
| `tools/getSourceFiles.py` | replaced by the static `sources` list |
| `Gruntfile.js` | references `grunt-node-gyp`, `grunt-nw-gyp`, `grunt-contrib-copy`, `grunt-contrib-jshint` — none are in `package.json`, so it's already broken. Last reference to the dead `node_printer_<platform>_<arch>` naming and to ia32. |
| `entitlements.plist` | unreferenced anywhere; the mac prebuild step used `--options runtime` without `--entitlements` |
| `tools/buildElectronLinux.sh`, `tools/buildElectronWindows.ps1`, `tools/buildWindows.ps1`, `tools/generateReleaseBuildsLinux.sh`, `tools/generateReleaseBuildsWindows.ps1` | dead; `buildWindows.ps1` targets Electron 1.2.8–6.0.7 |

Stop *referencing* `APPLICATION_CERTIFICATE_P12`, `APPLICATION_CERTIFICATE_P12_PASSWORD`, and `vars.CERTIFICATE_IDENTITY` here — but **do not delete the secrets**; kiosk's mac job uses the same names. The addon's signature now comes solely from forge's `osxSign`, which already re-signs `node_printer.node --force` and notarizes.

### 5. Add `.github/workflows/ci.yml` — compile-only, publishes nothing

Toolchain drift then surfaces here instead of in a kiosk release. This repo currently runs `npm test` in CI zero times.

**Everything in the matrix mirrors kiosk-electron.** No forward-looking or canary legs: `NODE_VERSION` tracks the `actions/setup-node` version in its `build-and-deploy.yml` (currently `20`), `ELECTRON_TARGET` tracks its `electron` devDependency (`35.7.5`, which bundles Node 22.16.0 / V8 13.4 / ABI 133). Bump both when kiosk bumps.

- **Matrix:** `[macos-latest, windows-2022]` × `[node, electron]`, with `fail-fast: false` so one leg failing doesn't cancel the others. Electron leg: `npx node-gyp rebuild --runtime=electron --target=35.7.5 --dist-url=https://electronjs.org/headers`. This is the surviving form of "keep the Node-runtime builds and keep macOS."
- **`windows-2022` only.** Kiosk is converging on it — `develop` already pins it, and `main` will follow. `windows-latest` resolves to the `windows-2025-vs2026` image (Visual Studio Enterprise 2026, MSVC v145), which this NAN addon has never shipped against, so testing it here would put us ahead of the consumer rather than mirroring it. **Prerequisite: `main` must move to `windows-2022` before this is a true mirror** — until then, production releases from `main` build on v145 with no coverage anywhere.
- **`macos-latest`, not a pinned macOS.** Kiosk uses `macos-latest`; pinning here would let its runner advance past ours, which is the drift this workflow exists to catch. (`macos-latest` is macOS 26 arm64 today.)
- **`cross-arch-macos` job:** `npx node-gyp rebuild --arch=x64` then `file lib/node_printer.node | grep -q x86_64`. This is the assertion that catches the one real technical risk. It's already proven to work — the `darwin-x64` asset from `v1.3.0-pr21`, built on an arm64 runner, is `Mach-O 64-bit bundle x86_64`, and `cups-config --cflags` is empty while `--libs` is just `-lcups` (arch-neutral), with the SDK `libcups.2.tbd` carrying both slices.
- **No `ia32` leg** — 32-bit Windows is dropped.
- **No `actions/setup-python` anywhere**, on purpose: that job failing is the regression test for change 1.
- `npm test` on the node runtime only — `test/get-printers.test.js` does `require("../")` and calls `getPrinters()`, so it needs a Node-ABI binary. Assert the call succeeds, not that the result is non-empty.
- No Ubuntu: `ubuntu-latest` has no `cups-config` and Linux isn't a target.

### 6. Release process becomes tagging

Kiosk resolves `github:...#vX.Y.Z` to a git ref, so a `vX.Y.Z` **tag must exist on `main`**. Replace the `softprops/action-gh-release` machinery with a tag-on-main-push job, and drop the `-prN` release scheme — it exists only to name prebuild archives.

State to untangle first: `f72927d` is unmerged on `feat/PROC-2640/modernize-deps`, `origin/main` is still `ccd839a` (v1.2.0), and `v1.3.0` exists as neither tag nor release. Target `v1.3.0`.

### 7. Rewrite the README

It currently says `npm install @thiagoelg/node-printer`, badges point at `thiagoelg/node-printer` workflows that no longer exist, and it's titled "Node Printer **Prebuild**". Document: builds from source at install time; requires a C++20 toolchain + CUPS headers (macOS: Xcode CLT) or VS 2022+ Build Tools (Windows); 64-bit only; consumed via git tag. Also add a LICENSE file — `license: MIT` is declared with no LICENSE in the tree.

---

## Verification

### Local

```bash
rm -rf node_modules package-lock.json build && npm install
node -e "if (require('./package.json').scripts.install) throw new Error('install script still present')"
test -f lib/node_printer.node && echo "npm injected the default gyp build"
npm test
npm pack --dry-run    # expect: no build/, no examples/, no tools/, no .github/

# regression test for change 1: build with no bare `python` on PATH
env PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'python@' | paste -sd: -)" \
  sh -c 'command -v python; npx node-gyp rebuild'
```

### CI

Push the branch and confirm all 5 legs are green: `compile` (2 runners x 2 runtimes) and `cross-arch-macos` asserting `x86_64`.

### The git-dep path, before tagging

This is the step that proves the consumer will actually get a buildable package:

```bash
mkdir -p /tmp/np-probe && cd /tmp/np-probe && npm init -y
npm install --foreground-scripts "github:casechek/node-printer#chore/remove-prebuilds"
# expect "node-gyp rebuild" in the log, and NO clone-side devDep install
node -e "console.log(require('@casechek/node-printer').getPrinters().length + ' printers')"
ls node_modules/@casechek/node-printer   # binding.gyp lib src types printer.js package.json
```

Then tag `v1.3.0` and proceed to the kiosk plan.

---

## Critical files

- `binding.gyp` — static `sources` list, bump deployment target; keep the `%` sigils
- `package.json` — delete `scripts.install` + prebuild scripts + `binary` block + 4 deps; promote `node-gyp` to devDeps; add `files`
- `lib/printer.js` — lines 6-13, drop the dead fallback
- `.github/workflows/prebuild.yml` — delete, replace with compile-only `ci.yml`
- `.npmignore` — delete

## Caveats

- **Unmeasured:** the ~1–2 min Windows `npm ci` saving is inferred from pacote's `#prepareDir` behavior against the 5m07s baseline, not a controlled before/after. Measure it during the kiosk phase.
- **Compliance framing:** the production kiosk binary is compiled on an ephemeral GitHub-hosted runner and is not independently attestable — but that is already true today, since the prebuilds were never used. This change consolidates code signing to a single authority (forge's `osxSign`), which is cleaner for an audit trail. If an SBOM or provenance attestation for the shipped native code is ever asked for, the answer is "we can't" both before and after; `actions/attest-build-provenance` on kiosk's package step would close that, and is a better use of effort than prebuildify.
