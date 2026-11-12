#!/usr/bin/env bash
# Writes two zips of the extension's files, and nothing else (tests, notes and other project files stay out):
# - release/bitbucket-artifact-viewer-<version>.zip holds one folder, ready to be unzipped and loaded with
#   chrome://extensions > Load unpacked;
# - release/bitbucket-artifact-viewer-<version>-store.zip has manifest.json at its root, as the Chrome Web Store
#   requires for an upload.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -I -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
name="bitbucket-artifact-viewer-${version}"
out="release/${name}.zip"
store="release/${name}-store.zip"
mkdir -p release
rm -f "$out" "$store"

python3 -I - "$out" "$name" "$store" <<'EOF'
import os
import sys
import zipfile

out, top, store = sys.argv[1], sys.argv[2], sys.argv[3]


def write(path, prefix):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for folder, folders, files in os.walk("extension"):
            folders.sort()
            for file in sorted(files):
                full = os.path.join(folder, file)
                relative = os.path.relpath(full, "extension")
                archive.write(full, os.path.join(prefix, relative) if prefix else relative)


write(out, top)
write(store, "")
EOF

echo "$out"
echo "$store"
