#!/usr/bin/env bash
# Full in-cluster journey for the captured Rivet control plane, on a local cluster:
#   tools/alchemy-kubernetes-capture/cluster/run.sh <receipt-name>
# Touches only namespace typekro-rivet-spike, the RGD rivet-control-plane and its generated CRD,
# and the images this run pulls or builds. Every command's PID is recorded in the receipt.
set -u
NAME=$1
CLUSTER_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$CLUSTER_DIR/../../.." && pwd)
LINES="$CLUSTER_DIR/$NAME.jsonl"
NS=typekro-rivet-spike
CONTEXT=${TKCAPTURE_KUBE_CONTEXT:-orbstack}
K="kubectl --context $CONTEXT"
ENGINE=rivetdev/engine@sha256:5ae3c24275eeff87ad1962f4d66fcdb85786fc1397feeeb55afc2ca1f7ccf6f2
CURL=curlimages/curl@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69
BUN=oven/bun@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e
PROBE=typekro-rivetkit-probe:spike
: > "$LINES"
export TKCAPTURE_RECEIPT="$LINES"
FAILED=0

note() { python3 -I -c 'import json,sys,datetime; d=json.loads(sys.argv[1]); d["at"]=datetime.datetime.utcnow().isoformat()+"Z"; print(json.dumps(d))' "$1" >> "$LINES"; }

# step <name> <command...>: runs the command in the background to learn its PID, then waits.
step() {
  local name=$1; shift
  local started=$SECONDS
  "$@" > "$CLUSTER_DIR/.step.out" 2>&1 &
  local pid=$!
  wait "$pid"; local rc=$?
  local tail; tail=$(tail -c 1500 "$CLUSTER_DIR/.step.out" | python3 -I -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  note "{\"step\":\"$name\",\"pid\":$pid,\"rc\":$rc,\"s\":$((SECONDS - started)),\"output\":$tail}"
  return $rc
}

present() { docker image inspect "$1" > /dev/null 2>&1 && echo true || echo false; }
note "{\"step\":\"images present before run\",\"engine\":$(present $ENGINE),\"curl\":$(present $CURL),\"bun\":$(present $BUN),\"probe\":$(present $PROBE)}"
BEFORE_ENGINE=$(present $ENGINE); BEFORE_CURL=$(present $CURL); BEFORE_BUN=$(present $BUN); BEFORE_PROBE=$(present $PROBE)

wait_phase() { # wait_phase <pod> <seconds>: until the pod is Succeeded or Failed
  local deadline=$((SECONDS + $2))
  while [ $SECONDS -lt $deadline ]; do
    phase=$($K -n $NS get pod "$1" -o jsonpath='{.status.phase}' 2>/dev/null)
    case "$phase" in Succeeded|Failed) echo "$phase"; return 0 ;; esac
    sleep 3
  done
  echo "Timeout"; return 1
}

step "build probe image" docker build -q -t $PROBE "$CLUSTER_DIR/rivetkit-probe" || FAILED=1
[ $FAILED = 0 ] && { (cd "$ROOT" && step "up: token secret, RGD and instance" bun tools/alchemy-kubernetes-capture/cluster/control-plane.ts up) || FAILED=1; }
if [ $FAILED = 0 ]; then
  step "pool job log" sh -c "$K -n $NS logs job/\$($K -n $NS get job -o jsonpath='{.items[0].metadata.name}')"
  step "apply probe pod (real token)" sh -c "cd '$ROOT' && bun tools/alchemy-kubernetes-capture/cluster/probe-pods.ts good | $K apply -f -" || FAILED=1
  step "probe pod (real token) phase" wait_phase rivetkit-probe 180
  step "probe pod (real token) log" $K -n $NS logs rivetkit-probe
  probe_ok() { # probe_ok <step name> <true|false>: the probe's JSON line in that step's output
    python3 -I -c 'import json,sys
for line in open(sys.argv[1]):
    d=json.loads(line)
    if d.get("step")==sys.argv[2]:
        for out in d["output"].splitlines():
            if out.startswith("{") and "rivetkit round-trip" in out:
                sys.exit(0 if json.loads(out)["ok"] is (sys.argv[3]=="true") else 1)
sys.exit(1)' "$LINES" "$1" "$2"
  }
  probe_ok "probe pod (real token) log" true || FAILED=1
  step "apply probe pod (wrong token)" sh -c "cd '$ROOT' && bun tools/alchemy-kubernetes-capture/cluster/probe-pods.ts wrong | $K apply -f -"
  step "probe pod (wrong token) phase" wait_phase rivetkit-probe-wrong-token 120
  step "probe pod (wrong token) log" $K -n $NS logs rivetkit-probe-wrong-token
  if probe_ok "probe pod (wrong token) log" false; then note '{"step":"wrong token refused","ok":true}'; else note '{"step":"wrong token refused","ok":false}'; FAILED=1; fi
  step "delete probe pods" $K -n $NS delete pod rivetkit-probe rivetkit-probe-wrong-token --wait=true
  (cd "$ROOT" && step "down: delete instance through kro" bun tools/alchemy-kubernetes-capture/cluster/control-plane.ts down) || FAILED=1
  step "PVC kept after instance delete (faithful to Alchemy)" $K -n $NS get pvc data-rivet-0 -o name || FAILED=1
fi

# Cleanup always runs.
step "delete RGD if present" $K delete rgd rivet-control-plane --ignore-not-found --wait=true --timeout=120s
step "delete generated CRD" $K delete crd rivetcontrolplanes.kro.run --ignore-not-found --wait=true --timeout=120s
step "delete namespace" $K delete namespace $NS --ignore-not-found --wait=true --timeout=300s
for pair in "ENGINE:$ENGINE:$BEFORE_ENGINE" "CURL:$CURL:$BEFORE_CURL" "BUN:$BUN:$BEFORE_BUN" "PROBE:$PROBE:$BEFORE_PROBE"; do
  label=${pair%%:*}; rest=${pair#*:}; before=${rest##*:}; image=${rest%:*}
  if [ "$before" = false ] && docker image inspect "$image" > /dev/null 2>&1; then
    # The kubelet removes exited pod containers shortly after the namespace goes; retry until then.
    step "remove image $label (pulled or built by this run)" sh -c "for i in \$(seq 1 20); do docker rmi '$image' && exit 0; sleep 6; done; exit 1"
  fi
done
rm -f "$CLUSTER_DIR/.step.out"
note "{\"step\":\"end\",\"failed\":$FAILED}"
exit $FAILED
