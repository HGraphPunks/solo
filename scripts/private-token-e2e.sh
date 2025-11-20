#!/usr/bin/env bash

# This script creates a dedicated Kind cluster, deploys a Solo network via the
# one-shot (falcon) command, runs the private token end-to-end spec, and then
# tears everything down again. Override the defaults with environment variables:
#   KIND_CLUSTER_NAME    Name of the Kind cluster to create (default: solo-private-token)
#   KIND_IMAGE           Kind node image (default: v1.31.4 pinned digest)
#   REUSE_KIND_CLUSTER   Set to 1 to reuse an existing Kind cluster with the same name
#   KEEP_ENVIRONMENT     Set to 1 to skip teardown (useful for debugging)
#   SOLO_DEPLOY_FLAGS    Extra flags passed to `solo one-shot falcon deploy`
#   SOLO_DESTROY_FLAGS   Extra flags passed to `solo one-shot falcon destroy`
#   SOLO_HOME             Override the Solo home directory (default: <repo>/.solo-private-token)
#   FALCON_LOCAL_BUILD_PATH Path to Hedera services build to stage (default: ../hiero-consensus-node/hedera-node/data)
#   FALCON_RELEASE_TAG    Release tag to embed in the falcon values file (default: empty / auto)
#   FALCON_NUM_CONSENSUS_NODES Number of consensus nodes for falcon deploy (default: 1)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-solo-private-token}"
KIND_IMAGE="${KIND_IMAGE:-kindest/node:v1.31.4@sha256:2cb39f7295fe7eafee0842b1052a599a4fb0f8bcf3f83d96c7f4864c357c6c30}"
REUSE_KIND_CLUSTER="${REUSE_KIND_CLUSTER:-0}"
KEEP_ENVIRONMENT="${KEEP_ENVIRONMENT:-0}"

CUSTOM_SOLO_HOME=1
if [[ -z "${SOLO_HOME:-}" ]]; then
  CUSTOM_SOLO_HOME=0
  export SOLO_HOME="${SOLO_DIR}/.solo-private-token"
fi
SOLO_HOME_PATH="${SOLO_HOME}"

LATEST_ONE_SHOT_DIR=""
LATEST_CLUSTER_REF=""
LATEST_NAMESPACE=""
LATEST_DEPLOYMENT=""
SPEC_ONE_SHOT_BASE=""
SPEC_ONE_SHOT_DIR=""
FALCON_VALUES_FILE=""
FALCON_LOCAL_BUILD_TMP=""

declare -a SOLO_DEPLOY_EXTRA=()
if [[ -n "${SOLO_DEPLOY_FLAGS:-}" ]]; then
  read -r -a SOLO_DEPLOY_EXTRA <<< "${SOLO_DEPLOY_FLAGS}"
fi

declare -a SOLO_DESTROY_EXTRA=()
if [[ -n "${SOLO_DESTROY_FLAGS:-}" ]]; then
  read -r -a SOLO_DESTROY_EXTRA <<< "${SOLO_DESTROY_FLAGS}"
fi

CREATED_KIND_CLUSTER=0
DEPLOYED_SOLO=0

reset_default_solo_home() {
  if [[ "${CUSTOM_SOLO_HOME}" == "0" ]]; then
    rm -rf "${SOLO_HOME_PATH}"
  fi
  mkdir -p "${SOLO_HOME_PATH}"
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

fatal() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    fatal "Missing required command: ${cmd}"
  fi
}

run_solo() {
  (
    cd -- "${SOLO_DIR}"
    npx --no-install tsx --no-deprecation --no-warnings solo.ts "$@"
  )
}

run_private_token_spec() {
  if [[ -z "${LATEST_ONE_SHOT_DIR}" ]]; then
    fatal 'Solo deployment metadata has not been captured; cannot run private token spec.'
  fi
  if [[ -z "${SPEC_ONE_SHOT_DIR}" || ! -d "${SPEC_ONE_SHOT_DIR}" ]]; then
    fatal 'Spec directory not prepared; cannot run private token spec.'
  fi
  (
    cd -- "${SOLO_DIR}"
    SOLO_ONE_SHOT_DIR="${SPEC_ONE_SHOT_DIR}" \
      SOLO_WORKSPACE_ROOT="${SOLO_DIR}" \
      npm run private-token-spec
  )
}

kind_cluster_exists() {
  kind get clusters | grep -qx "${KIND_CLUSTER_NAME}"
}

ensure_kube_context() {
  local context="kind-${KIND_CLUSTER_NAME}"
  if ! kubectl config get-contexts "${context}" >/dev/null 2>&1; then
    fatal "Kubernetes context ${context} not found; did Kind create the cluster?"
  fi
  kubectl config use-context "${context}" >/dev/null
}

create_kind_cluster() {
  if kind_cluster_exists; then
    if [[ "${REUSE_KIND_CLUSTER}" == "1" ]]; then
      log "Reusing existing Kind cluster ${KIND_CLUSTER_NAME}"
      return
    fi
    fatal "Kind cluster ${KIND_CLUSTER_NAME} already exists. Delete it or set REUSE_KIND_CLUSTER=1."
  fi

  log "Creating Kind cluster ${KIND_CLUSTER_NAME} (image ${KIND_IMAGE})"
  kind create cluster --name "${KIND_CLUSTER_NAME}" --image "${KIND_IMAGE}"
  CREATED_KIND_CLUSTER=1
}

load_one_shot_metadata() {
  local cache_file="${SOLO_HOME_PATH}/cache/last-one-shot-deployment.txt"
  if [[ ! -f "${cache_file}" ]]; then
    fatal "Cannot locate ${cache_file}; Solo deploy did not record the last deployment."
  fi

  local deployment
  deployment="$(tr -d '\r\n' < "${cache_file}")"
  if [[ -z "${deployment}" ]]; then
    fatal "Deployment name stored in ${cache_file} is empty."
  fi

  local dir="${SOLO_HOME_PATH}/one-shot-${deployment}"
  if [[ ! -d "${dir}" ]]; then
    fatal "Expected one-shot directory ${dir} does not exist."
  fi

  local notes_file="${dir}/notes"
  if [[ ! -f "${notes_file}" ]]; then
    fatal "Expected notes file ${notes_file} does not exist."
  fi

  local cluster_ref namespace
  local cluster_line namespace_line
  cluster_line="$(grep -Ei '^([[:space:]-])*Cluster Reference:' "${notes_file}" | head -n1 || true)"
  namespace_line="$(grep -Ei '^([[:space:]-])*Namespace Name:' "${notes_file}" | head -n1 || true)"
  if [[ -n "${cluster_line}" ]]; then
    cluster_ref="$(printf '%s' "${cluster_line}" | sed -E 's/^[[:space:]-]*Cluster Reference:[[:space:]]*//' | tr -d '\r' | xargs)"
  fi
  if [[ -n "${namespace_line}" ]]; then
    namespace="$(printf '%s' "${namespace_line}" | sed -E 's/^[[:space:]-]*Namespace Name:[[:space:]]*//' | tr -d '\r' | xargs)"
  fi
  if [[ -z "${cluster_ref}" || -z "${namespace}" ]]; then
    fatal "Unable to parse cluster reference or namespace from ${notes_file}"
  fi

  LATEST_ONE_SHOT_DIR="${dir}"
  LATEST_CLUSTER_REF="${cluster_ref}"
  LATEST_NAMESPACE="${namespace}"
  LATEST_DEPLOYMENT="${deployment}"

  log "Captured Solo deployment metadata: deployment=${deployment}, namespace=${namespace}, clusterRef=${cluster_ref}"

  prepare_spec_directory
  patch_block_stream_config
}

patch_block_stream_config() {
  local namespace="${LATEST_NAMESPACE}"
  if [[ -z "${namespace}" ]]; then
    fatal "Namespace not captured; cannot patch block stream config"
  fi
  local pod
  pod="$(
    kubectl -n "${namespace}" get pods -l 'solo.hedera.com/type=network-node' -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
  )" || true
  if [[ -z "${pod}" ]]; then
    fatal "Unable to locate network node pod in namespace ${namespace}"
  fi
  log "Patching blockStream configuration inside pod ${pod}..."
  kubectl -n "${namespace}" exec "${pod}" -c root-container -- /bin/bash <<'PATCHCFG'
set -euo pipefail
CONFIG="/opt/hgcapp/services-hedera/HapiApp2.0/data/config/application.properties"
if [[ ! -f "${CONFIG}" ]]; then
  echo "Missing application.properties at ${CONFIG}" >&2
  exit 1
fi
if grep -q '^blockStream.streamMode=' "${CONFIG}"; then
  sed -i 's/^blockStream\.streamMode=.*/blockStream.streamMode=RECORDS/' "${CONFIG}"
else
  echo 'blockStream.streamMode=RECORDS' >> "${CONFIG}"
fi
if grep -q '^blockStream.writerMode=' "${CONFIG}"; then
  sed -i 's/^blockStream\.writerMode=.*/blockStream.writerMode=FILE/' "${CONFIG}"
else
  echo 'blockStream.writerMode=FILE' >> "${CONFIG}"
fi
systemctl restart network-node.service
PATCHCFG
  log "Waiting for network node to return to Ready..."
  kubectl -n "${namespace}" wait --for=condition=Ready pod -l 'solo.hedera.com/type=network-node' --timeout=300s >/dev/null
}

create_falcon_values_file() {
  if [[ -n "${FALCON_VALUES_FILE}" && -f "${FALCON_VALUES_FILE}" ]]; then
    return
  fi
  local default_build="${SOLO_DIR}/../hiero-consensus-node/hedera-node/data"
  local source_build_path="${FALCON_LOCAL_BUILD_PATH:-${default_build}}"
  if [[ ! -d "${source_build_path}" ]]; then
    fatal "FALCON_LOCAL_BUILD_PATH ${source_build_path} does not exist or is not a directory"
  fi
  FALCON_LOCAL_BUILD_TMP="$(mktemp -d "${SOLO_HOME_PATH}/falcon-build.XXXXXX")"
  mkdir -p "${FALCON_LOCAL_BUILD_TMP}/data"
  rsync -a "${source_build_path}/" "${FALCON_LOCAL_BUILD_TMP}/data/"
  local app_props="${FALCON_LOCAL_BUILD_TMP}/data/config/application.properties"
  if [[ -f "${app_props}" ]]; then
    if grep -q '^blockStream.streamMode=' "${app_props}"; then
      sed -i '' 's/^blockStream\.streamMode=.*/blockStream.streamMode=RECORDS/' "${app_props}"
    else
      echo 'blockStream.streamMode=RECORDS' >> "${app_props}"
    fi
    if grep -q '^blockStream.writerMode=' "${app_props}"; then
      sed -i '' 's/^blockStream\.writerMode=.*/blockStream.writerMode=FILE/' "${app_props}"
    else
      echo 'blockStream.writerMode=FILE' >> "${app_props}"
    fi
  fi
  local local_build_path="${FALCON_LOCAL_BUILD_TMP}/data"
  local release_tag="${FALCON_RELEASE_TAG:-}"
  local num_nodes="${FALCON_NUM_CONSENSUS_NODES:-1}"
  FALCON_VALUES_FILE="$(mktemp "${SOLO_HOME_PATH}/falcon-values.XXXXXX.yaml")"
  cat > "${FALCON_VALUES_FILE}" <<EOF
network:
  --release-tag: "${release_tag}"

setup:
  --local-build-path: "${local_build_path}"
  --release-tag: "${release_tag}"

consensusNode:
  --force-port-forward: true

mirrorNode:
  --enable-ingress: true
  --force-port-forward: true

relayNode:
  --force-port-forward: true

explorerNode:
  --enable-ingress: true
  --force-port-forward: true

EOF
  export FALCON_DEPLOY_NODE_COUNT="${num_nodes}"
}

prepare_spec_directory() {
  if [[ -z "${LATEST_ONE_SHOT_DIR}" ]]; then
    fatal 'Cannot prepare spec directory before metadata is captured.'
  fi
  SPEC_ONE_SHOT_BASE="$(mktemp -d "${SOLO_HOME_PATH}/private-token-spec.XXXXXX")"
  local base_name
  base_name="$(basename "${LATEST_ONE_SHOT_DIR}")"
  cp -R "${LATEST_ONE_SHOT_DIR}" "${SPEC_ONE_SHOT_BASE}/"
  SPEC_ONE_SHOT_DIR="${SPEC_ONE_SHOT_BASE}/${base_name}"
  mkdir -p "${SPEC_ONE_SHOT_DIR}/one-shot-placeholder"
}

deploy_solo_network() {
  log "Deploying Solo one-shot falcon network (this can take several minutes)..."
  create_falcon_values_file
  local args=(one-shot falcon deploy --values-file "${FALCON_VALUES_FILE}")
  local node_count="${FALCON_DEPLOY_NODE_COUNT:-1}"
  if [[ -n "${node_count}" ]]; then
    args+=(--num-consensus-nodes "${node_count}")
  fi
  if ((${#SOLO_DEPLOY_EXTRA[@]})); then
    args+=("${SOLO_DEPLOY_EXTRA[@]}")
  fi
  run_solo "${args[@]}"
  load_one_shot_metadata
  DEPLOYED_SOLO=1
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "${KEEP_ENVIRONMENT}" == "1" ]]; then
    log "KEEP_ENVIRONMENT=1 -> skipping teardown. Kind cluster and Solo deployment remain running."
    exit "${exit_code}"
  fi

  if [[ -n "${SPEC_ONE_SHOT_BASE}" && -d "${SPEC_ONE_SHOT_BASE}" ]]; then
    rm -rf "${SPEC_ONE_SHOT_BASE}"
  fi

  set +e
  if [[ "${DEPLOYED_SOLO}" == "1" ]]; then
    log "Destroying Solo one-shot deployment..."
    local destroy_args=(one-shot falcon destroy)
    if ((${#SOLO_DESTROY_EXTRA[@]})); then
      destroy_args+=("${SOLO_DESTROY_EXTRA[@]}")
    fi
    run_solo "${destroy_args[@]}" || log "Solo destroy reported an error; manual cleanup may be required."
  fi

  if [[ "${CREATED_KIND_CLUSTER}" == "1" ]]; then
    log "Deleting Kind cluster ${KIND_CLUSTER_NAME}..."
    kind delete cluster --name "${KIND_CLUSTER_NAME}" || log "Kind delete reported an error; manual cleanup may be required."
  fi
  set -e

  if [[ -n "${FALCON_VALUES_FILE}" && -f "${FALCON_VALUES_FILE}" ]]; then
    rm -f "${FALCON_VALUES_FILE}"
  fi
  if [[ -n "${FALCON_LOCAL_BUILD_TMP}" && -d "${FALCON_LOCAL_BUILD_TMP}" ]]; then
    rm -rf "${FALCON_LOCAL_BUILD_TMP}"
  fi

  exit "${exit_code}"
}

trap cleanup EXIT

main() {
  log "Solo private token end-to-end test runner starting..."

  for cmd in kind kubectl npm npx; do
    require_command "${cmd}"
  done

  reset_default_solo_home
  create_kind_cluster
  ensure_kube_context
  deploy_solo_network

  log "Running private token end-to-end spec..."
  run_private_token_spec
  log "Private token test completed successfully."
}

main "$@"
