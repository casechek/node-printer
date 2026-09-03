/**
 * Asserts that a release carries every prebuilt archive its consumers will ask for.
 *
 * prebuild (the publisher) and prebuild-install (the consumer) derive archive names
 * independently, so they can drift: v1.1.0 and v1.2.0 both uploaded working binaries
 * under names prebuild-install never requested, and every install quietly fell back to
 * compiling from source. This recomputes the consumer-side names from package.json and
 * checks them against what was actually uploaded.
 *
 * Usage: node tools/verify-prebuilds.mjs <release-tag> <runtime:target:platform:arch>...
 *   node tools/verify-prebuilds.mjs v1.3.0 node:20.3.0:win32:x64 electron:35.7.5:win32:x64
 */
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const {getAbi} = require('node-abi');

const [tag, ...combos] = process.argv.slice(2);
if (!tag || combos.length === 0) {
  console.error('usage: verify-prebuilds.mjs <release-tag> <runtime:target:platform:arch>...');
  process.exit(2);
}

// Mirrors prebuild-install's template expansion (see prebuild-install/util.js
// getDownloadUrl): {name} is the package name without its npm scope and {abi} is the
// ABI of the *target* runtime, not of the node running the install.
function expectedArchive({runtime, target, platform, arch}) {
  const template =
    pkg.binary?.package_name ||
    '{name}-v{version}-{runtime}-v{abi}-{platform}{libc}-{arch}.tar.gz';
  const vars = {
    name: pkg.name.replace(/^@[^/]+\//, ''),
    version: pkg.version,
    runtime,
    abi: getAbi(target, runtime),
    platform,
    arch,
    libc: '',
  };
  return template.replace(/{(\w+)}/g, (match, key) =>
    key in vars ? vars[key] : match,
  );
}

// Draft releases have no git tag yet, so they are not reachable via /releases/tags/{tag}.
async function findRelease() {
  const {owner, repo} = (() => {
    const match = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(pkg.repository.url);
    if (!match) throw new Error(`cannot parse repository url: ${pkg.repository.url}`);
    return {owner: match[1], repo: match[2]};
  })();

  const headers = {accept: 'application/vnd.github+json'};
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  for (let page = 1; page <= 5; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`;
    const response = await fetch(url, {headers});
    if (!response.ok) {
      throw new Error(`GET ${url} -> ${response.status} ${await response.text()}`);
    }
    const releases = await response.json();
    if (releases.length === 0) break;
    const match = releases.find((release) => release.tag_name === tag);
    if (match) return match;
  }
  throw new Error(`no release found for tag ${tag}`);
}

const release = await findRelease();
const uploaded = new Set(release.assets.map((asset) => asset.name));

const missing = [];
for (const combo of combos) {
  const [runtime, target, platform, arch] = combo.split(':');
  if (!runtime || !target || !platform || !arch) {
    throw new Error(`malformed combo "${combo}", expected runtime:target:platform:arch`);
  }
  const archive = expectedArchive({runtime, target, platform, arch});
  const present = uploaded.has(archive);
  console.log(`${present ? 'ok  ' : 'MISS'}  ${combo.padEnd(34)} ${archive}`);
  if (!present) missing.push(archive);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} archive(s) missing from ${tag}. Uploaded assets:\n  ` +
      ([...uploaded].sort().join('\n  ') || '(none)'),
  );
  process.exit(1);
}
console.log(`\nAll ${combos.length} expected archives present on ${tag}.`);
