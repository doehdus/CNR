#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
node_version="22.23.4"
allow_install="false"
for argument in "$@"; do
  case "${argument}" in
    --install) allow_install="true" ;;
    --prepare-only|--check) ;;
    *) echo "Usage: bash scripts/dev-local.sh [--install] [--prepare-only|--check]" >&2; exit 1 ;;
  esac
done
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This launcher supports macOS. See CONTRIBUTING.md for other platforms." >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) node_arch="arm64"; node_sha="c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428" ;;
  x86_64) node_arch="x64"; node_sha="efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
node_distribution="node-v${node_version}-darwin-${node_arch}"
node_directory="${project_root}/.tools/${node_distribution}"
archive="${project_root}/.cache/bootstrap/${node_distribution}.tar.gz"

if [ ! -x "${node_directory}/bin/node" ]; then
  if [ "${allow_install}" != "true" ]; then
    echo "Project-local Node.js is not installed. Nothing was downloaded." >&2
    echo "To choose installation, run: bash scripts/dev-local.sh --install" >&2
    exit 1
  fi
  mkdir -p "${project_root}/.tools" "${project_root}/.cache/bootstrap"
  if [ ! -f "${archive}" ]; then
    echo "Downloading project-local Node.js ${node_version} (${node_arch})..."
    curl --fail --location --retry 3 --output "${archive}.part" "https://nodejs.org/dist/v${node_version}/${node_distribution}.tar.gz"
    mv "${archive}.part" "${archive}"
  fi
  actual_sha="$(shasum -a 256 "${archive}" | awk '{print $1}')"
  if [ "${actual_sha}" != "${node_sha}" ]; then
    echo "Node.js archive checksum mismatch. Remove ${archive} and retry." >&2
    exit 1
  fi
  tar -xzf "${archive}" -C "${project_root}/.tools"
fi
export PATH="${node_directory}/bin:${PATH}"
export npm_config_cache="${project_root}/.cache/npm"
cd "${project_root}"
exec "${node_directory}/bin/node" "${project_root}/website/scripts/local-setup.mjs" "$@"
