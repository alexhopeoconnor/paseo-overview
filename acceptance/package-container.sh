#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -n "${OVERVIEW_TEST_ARTIFACT:-}" || -n "${OVERVIEW_TEST_ARTIFACT_DIR:-}" ]]; then
  echo "OVERVIEW_TEST_ARTIFACT/OVERVIEW_TEST_ARTIFACT_DIR are no longer supported. Set OVERVIEW_TEST_PLUGIN_DIR to a prepared plugin directory, or omit it to test /plugin-source." >&2
  exit 2
fi
if [[ -d /artifact ]]; then
  echo "The /artifact mount is no longer supported. Mount a prepared plugin directory at /plugin-dir instead." >&2
  exit 2
fi

# This runs only in the pinned fork builder. The packaged daemon gets its own
# temporary home and local fixture provider, never the workstation's live data.
package_root=$(mktemp -d /tmp/overview-package.XXXXXXXX)
trap 'rm -rf -- "$package_root"' EXIT
dpkg-deb --extract /inputs/package.deb "$package_root"
export OVERVIEW_TEST_PACKAGE_FILE=/inputs/package.deb
export OVERVIEW_TEST_PACKAGE_ROOT="$package_root"
if [[ -z "${OVERVIEW_TEST_PLUGIN_DIR:-}" && -d /plugin-dir ]]; then
  export OVERVIEW_TEST_PLUGIN_DIR=/plugin-dir
fi
node /plugin-source/acceptance/packaged.cjs
