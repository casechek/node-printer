# @casechek/node-printer

Native printer bindings for Node.js and Electron — CUPS on macOS, the Win32 print spooler on Windows.

Casechek's fork of [tojocky/node-printer](https://github.com/tojocky/node-printer), by way of
[thiagoelg/node-printer](https://github.com/thiagoelg/node-printer).

## Installation

The addon is compiled from source at install time:
npm runs `node-gyp rebuild` automatically for any package with a `binding.gyp`, and the build
output is copied to `lib/node_printer.node`.

```json
"dependencies": {
  "@casechek/node-printer": "github:casechek/node-printer#v1.3.0"
}
```

Consumers pin a git tag. There is no npm-registry publish.

### Build requirements

| | |
|---|---|
| **macOS** | Xcode Command Line Tools (`xcode-select --install`). Provides clang, the CUPS headers, and `cups-config`. macOS 11+. |
| **Windows** | Visual Studio 2022 or newer Build Tools with the "Desktop development with C++" workload. |
| **Node** | 20 or newer (`engines.node: >= 20.0.0`). |

Requires a C++20 toolchain.

### Electron

This addon uses [NAN](https://github.com/nodejs/nan), so its binary is tied to a specific ABI.
Under Electron, let `@electron/rebuild` recompile it against the Electron headers — electron-forge
and electron-builder both do this automatically. Nothing here needs to know which Electron version
you are on.

To rebuild by hand:

```bash
npx node-gyp rebuild --runtime=electron --target=<electron-version> \
  --dist-url=https://electronjs.org/headers
```

## API

- `getPrinters()` — enumerate installed printers with current jobs and statuses
- `getPrinter(printerName)` — info for a specific or the default printer
- `getDefaultPrinterName()`
- `printDirect(options)` — send a job to a printer; accepts [CUPS options](https://www.cups.org/doc/options.html) as a JS object (see `examples/cancelJob.js`)
- `printFile(options)` — POSIX only
- `getPrinterDriverOptions(printerName)` — POSIX only; supported paper sizes and other driver info
- `getSelectedPaperSize(printerName)` — POSIX only
- `getSupportedPrintFormats()` — valid formats for `printDirect`; `RAW` and `TEXT` are supported everywhere
- `getJob(printerName, jobId)` / `setJob(printerName, jobId, command)`
- `getSupportedJobCommands()` — `'CANCEL'` is supported everywhere

TypeScript definitions are in `types/index.d.ts`. Runnable examples are in [`examples/`](./examples).

## Development

```bash
npm ci              # installs deps and compiles the addon
npm run rebuild     # recompile after changing anything in src/
npm test            # jest; requires a Node-ABI build of the addon
```

CI (`.github/workflows/ci.yml`) compiles on `macos-latest`, `windows-2022`, and `windows-latest`
against both the Node and Electron runtimes, and verifies that an x64 binary can be cross-compiled
on an arm64 macOS host. It publishes nothing — the point is to catch toolchain regressions here
rather than in a downstream release.

## Releasing

Bump `version` in `package.json` and merge to `main`. `.github/workflows/tag-release.yml` creates
the matching `vX.Y.Z` tag and GitHub release. Consumers move by bumping their git ref.

## Authors

Ion Lupascu (ionlupascu@gmail.com), with contributions from Thiago Lugli (@thiagoelg),
Eko Eryanto (@ekoeryanto), Stephen Carlin, and Steven Lehn.

## License

[MIT](./LICENSE)
