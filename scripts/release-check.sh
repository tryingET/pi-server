#!/usr/bin/env bash
# Release check script for pi-server (compiled server package)
# Validates npm pack contents and runs full CI before publishing.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NAME="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).name")"
VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"

echo "=== release-check: ${NAME}@${VERSION} ==="

# =============================================================================
# 1. Verify package.json has required fields
# =============================================================================

REPOSITORY_URL="$(node -p "(() => { const pkg = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')); const repo = pkg.repository; if (typeof repo === 'string') return repo.trim(); if (repo && typeof repo === 'object' && typeof repo.url === 'string') return repo.url.trim(); return ''; })()")"

if [[ -z "$REPOSITORY_URL" ]]; then
  echo "package.json must have 'repository' field for provenance publishing." >&2
  exit 1
fi

# =============================================================================
# 2. Verify package name is valid (must be lowercase)
# =============================================================================

if [[ "$NAME" != "${NAME,,}" ]]; then
  echo "Invalid npm package name: must be lowercase: $NAME" >&2
  exit 1
fi

# =============================================================================
# 3. Verify dist/ exists and has compiled files
# =============================================================================

if [[ ! -d "dist" ]]; then
  echo "dist/ directory not found. Run 'npm run build' first." >&2
  exit 1
fi

JS_COUNT=$(find dist -name "*.js" -type f | wc -l)
if [[ "$JS_COUNT" -eq 0 ]]; then
  echo "No .js files found in dist/. Run 'npm run build' first." >&2
  exit 1
fi

# =============================================================================
# 4. Verify entry point has shebang
# =============================================================================

if [[ -f "dist/server.js" ]]; then
  if ! head -1 dist/server.js | grep -q "#!/usr/bin/env node"; then
    echo "dist/server.js must start with #!/usr/bin/env node shebang." >&2
    exit 1
  fi
  echo "✓ Entry point has correct shebang"
else
  echo "dist/server.js not found (entry point required)." >&2
  exit 1
fi

# =============================================================================
# 5. Run npm pack --dry-run and validate file whitelist
# =============================================================================

echo "=== npm pack --dry-run --json ==="
PACK_JSON="$(npm pack --dry-run --json)"
echo "$PACK_JSON"

# Validate files[] whitelist matches actual pack contents
PACK_JSON="$PACK_JSON" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const normalize = (value) => value.replace(/^\.\//, "").replace(/\\/g, "/");

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const filesEntries = Array.isArray(pkg.files)
  ? pkg.files.map((entry) => normalize(String(entry).trim())).filter(Boolean)
  : [];

if (filesEntries.length === 0) {
  fail("package.json must define a non-empty 'files' array for deterministic publish artifacts.");
}

const expectedExact = new Set(["package.json"]);
const expectedDirPrefixes = [];
const expectedPatternPrefixes = [];

// Always include README and LICENSE
const allowByAlwaysIncluded = (filePath) => {
  return (
    /^README(?:\.[^/]+)?$/i.test(filePath) ||
    /^LICENSE(?:\.[^/]+)?$/i.test(filePath)
  );
};

// Process files[] entries
for (const entry of filesEntries) {
  if (/[*?\[]/.test(entry)) {
    const prefix = normalize(entry.split(/[*?\[]/, 1)[0]);
    if (!prefix) {
      fail(`Unsupported files[] wildcard entry without prefix: ${entry}`);
    }
    expectedPatternPrefixes.push(prefix);
    continue;
  }

  const fullPath = path.resolve(entry);
  if (!fs.existsSync(fullPath)) {
    fail(`files[] entry does not exist: ${entry}`);
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const prefix = entry.endsWith("/") ? entry : `${entry}/`;
    expectedDirPrefixes.push(prefix);
  } else {
    expectedExact.add(entry);
  }
}

// Parse npm pack output
const pack = JSON.parse(process.env.PACK_JSON || "[]");
if (!Array.isArray(pack) || !pack[0] || !Array.isArray(pack[0].files)) {
  fail("Could not parse npm pack --dry-run --json output.");
}

const actual = pack[0].files.map((f) => normalize(String(f.path || ""))).filter(Boolean).sort();
const actualSet = new Set(actual);

// Check for missing files
const missing = [];
for (const filePath of expectedExact) {
  if (!actualSet.has(filePath)) {
    missing.push(filePath);
  }
}
for (const prefix of expectedDirPrefixes) {
  if (!actual.some((filePath) => filePath.startsWith(prefix))) {
    missing.push(`${prefix}*`);
  }
}
for (const prefix of expectedPatternPrefixes) {
  if (!actual.some((filePath) => filePath.startsWith(prefix))) {
    missing.push(`${prefix}*`);
  }
}

// Check for extra files
const extra = actual.filter((filePath) => {
  if (expectedExact.has(filePath)) return false;
  if (expectedDirPrefixes.some((prefix) => filePath.startsWith(prefix))) return false;
  if (expectedPatternPrefixes.some((prefix) => filePath.startsWith(prefix))) return false;
  if (allowByAlwaysIncluded(filePath)) return false;
  return true;
});

if (missing.length || extra.length) {
  console.error("Publish file whitelist mismatch.");
  if (missing.length) console.error(`Missing: ${missing.join(", ")}`);
  if (extra.length) console.error(`Extra: ${extra.join(", ")}`);
  process.exit(1);
}

console.log(`✓ File whitelist OK (${actual.length} files)`);
NODE

# =============================================================================
# 6. Run npm publish --dry-run
# =============================================================================

echo "=== npm publish --dry-run ==="
set +e
PUBLISH_DRY_RUN_OUTPUT="$(npm publish --dry-run 2>&1)"
PUBLISH_DRY_RUN_EXIT=$?
set -e
echo "$PUBLISH_DRY_RUN_OUTPUT"
if [[ "$PUBLISH_DRY_RUN_EXIT" -ne 0 ]]; then
  if grep -qi "You cannot publish over the previously published versions" <<<"$PUBLISH_DRY_RUN_OUTPUT"; then
    echo "✓ npm publish --dry-run hit already-published version (${VERSION}); continuing."
  else
    echo "npm publish --dry-run failed." >&2
    exit "$PUBLISH_DRY_RUN_EXIT"
  fi
fi

# =============================================================================
# 7. Run full CI
# =============================================================================

echo "=== Running full CI ==="
npm run ci

echo ""
echo "=== release-check complete ==="
