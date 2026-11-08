#!/usr/bin/env bash
set -euo pipefail
umask 077

# This runs only in the pinned fork builder. The packaged daemon gets its own
# temporary home and local fixture provider, never the workstation's live data.
package_root=$(mktemp -d /tmp/overview-package.XXXXXXXX)
trap 'rm -rf -- "$package_root"' EXIT
dpkg-deb --extract /inputs/package.deb "$package_root"
export OVERVIEW_TEST_PACKAGE_FILE=/inputs/package.deb
export OVERVIEW_TEST_PACKAGE_ROOT="$package_root"
if [[ -d /artifact ]]; then export OVERVIEW_TEST_ARTIFACT=/artifact; fi
node /plugin-source/acceptance/packaged.cjs
