#!/bin/sh
set -eu

PUBLIC_ROOT="/srv/public"
RELEASES_DIR="${PUBLIC_ROOT}/releases"
CURRENT_LINK="${PUBLIC_ROOT}/current"
DEFAULT_RELEASE="${RELEASES_DIR}/default"

mkdir -p "${RELEASES_DIR}"

if [ -L "${CURRENT_LINK}" ] || [ -d "${CURRENT_LINK}" ]; then
  exit 0
fi

legacy_items=$(find "${PUBLIC_ROOT}" -mindepth 1 -maxdepth 1 ! -name current ! -name releases -print)
if [ -n "${legacy_items}" ]; then
  legacy_release="${RELEASES_DIR}/legacy-bootstrap"
  mkdir -p "${legacy_release}"
  find "${PUBLIC_ROOT}" -mindepth 1 -maxdepth 1 ! -name current ! -name releases -exec mv {} "${legacy_release}/" \;
  ln -s "releases/legacy-bootstrap" "${CURRENT_LINK}"
  exit 0
fi

mkdir -p "${DEFAULT_RELEASE}"
cp -R /opt/agent-os/public-default/. "${DEFAULT_RELEASE}/"
ln -s "releases/default" "${CURRENT_LINK}"
