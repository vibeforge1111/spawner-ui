#!/usr/bin/env bash
# Kanban / Spark pipeline unit tests — one-at-a-time smoke tools for the /kanban board.
#
# Usage (from repo root):
#   scripts/kanban-test.sh list                # show available tests
#   scripts/kanban-test.sh run <name>          # fire a single named test and watch it
#   scripts/kanban-test.sh board               # dump current board snapshot
#   scripts/kanban-test.sh status <mission_id> # show event timeline for one mission
#   scripts/kanban-test.sh watch <mission_id>  # poll a mission until terminal
#
# Requires: curl, python3 (for JSON parsing; available in Git Bash on Windows).

set -euo pipefail

# Windows cp1252 default encoding chokes on non-ascii. Force utf-8 for all python child processes.
export PYTHONIOENCODING=utf-8

BASE="${SPAWNER_BASE:-http://localhost:3333}"

# --- ANSI ---
# Respect both NO_COLOR (https://no-color.org) and non-TTY stdout. NO_COLOR is
# honored when set to any non-empty value, matching curl/git/most CLIs. This
# keeps CI logs, `| tee`, and `> capture.log` clean of escape codes that some
# log aggregators render as literal "\033[1m" garbage.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
	YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
	BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

json() { python -c "import sys,json; d=json.load(sys.stdin); $1"; }

# --- Canned tests. Each is: NAME | GOAL | PROVIDERS(comma or empty) ---
TEST_NAMES=(trivial medium long-title only-zai only-minimax missing-goal)
declare -A TEST_GOAL=(
	[trivial]="Write 'hello world'."
	[medium]="Explain in 3 bullet points why kanban boards fit operator tools."
	[long-title]="Write a short essay explaining how Spark missions relay through the mission-control relay into the spawner-ui kanban board, covering the provider runtime, webhook targets, and the Telegram bridge, so we can test that long titles render fully on the card."
	[only-zai]="Write a haiku about the color of operator consoles."
	[only-minimax]="Write a haiku about a mission moving from To Do to Done."
	[missing-goal]=""   # error path: empty goal should 400
)
declare -A TEST_PROVIDERS=(
	[only-zai]="zai"
	[only-minimax]="minimax"
)

usage() {
	cat <<EOF
${BOLD}Kanban / Spark pipeline tests${RESET}  (base: $BASE)

${BOLD}Commands${RESET}
  list                         Show available tests
  run <name>                   Fire one named test and watch to completion
  board                        Dump current board state
  status <mission_id>          Show event timeline for a mission
  watch <mission_id>           Poll a mission until it reaches a terminal state

${BOLD}Available test names${RESET}
$(for n in "${TEST_NAMES[@]}"; do printf "  %-16s %s\n" "$n" "${TEST_GOAL[$n]:0:60}..."; done)

Override base URL: ${DIM}SPAWNER_BASE=http://... scripts/kanban-test.sh ...${RESET}
EOF
}

dispatch() {
	local name="$1"
	local goal="${TEST_GOAL[$name]:-}"
	local providers="${TEST_PROVIDERS[$name]:-}"
	local request_id="test-${name}-$(date +%s)"

	echo "${BOLD}[$name]${RESET} ${DIM}goal=${goal:0:80}${RESET}"

	local body
	if [ -n "$providers" ]; then
		local prov_json
		prov_json=$(python -c "import json,sys; print(json.dumps(sys.argv[1].split(',')))" "$providers")
		body=$(python -c "import json,sys; print(json.dumps({'goal': sys.argv[1], 'providers': json.loads(sys.argv[2]), 'userId': 'kanban-test', 'requestId': sys.argv[3]}))" "$goal" "$prov_json" "$request_id")
	else
		body=$(python -c "import json,sys; print(json.dumps({'goal': sys.argv[1], 'userId': 'kanban-test', 'requestId': sys.argv[2]}))" "$goal" "$request_id")
	fi

	local resp
	resp=$(curl -s -X POST "$BASE/api/spark/run" -H "Content-Type: application/json" -d "$body")
	local success mission_id error
	success=$(echo "$resp" | json "print(d.get('success', False))" 2>/dev/null || echo "False")
	mission_id=$(echo "$resp" | json "print(d.get('missionId') or '')" 2>/dev/null || echo "")
	error=$(echo "$resp" | json "print(d.get('error') or '')" 2>/dev/null || echo "")

	if [ "$success" != "True" ]; then
		echo "${RED}✗ dispatch failed${RESET}  ${DIM}$error${RESET}"
		return 1
	fi
	echo "${GREEN}✓ dispatched${RESET}  id=${CYAN}$mission_id${RESET}"
	echo ""
	watch_mission "$mission_id"
}

watch_mission() {
	local id="$1"
	local started=$(date +%s)
	local last_event=""
	while true; do
		local snap
		snap=$(curl -s "$BASE/api/mission-control/status?missionId=$id")
		local latest_event status terminal name
		latest_event=$(echo "$snap" | json "r=d.get('snapshot',{}).get('recent',[]); print(r[0]['eventType'] if r else '')" 2>/dev/null || echo "")
		name=$(echo "$snap" | json "r=d.get('snapshot',{}).get('recent',[]); print(r[0].get('missionName') or '' if r else '')" 2>/dev/null || echo "")
		if [ "$latest_event" != "$last_event" ] && [ -n "$latest_event" ]; then
			local elapsed=$(( $(date +%s) - started ))
			printf "  ${DIM}+%02ds${RESET}  %s\n" "$elapsed" "$latest_event"
			last_event="$latest_event"
		fi
		case "$latest_event" in
			mission_completed)
				echo ""
				echo "${GREEN}✓ completed${RESET}  ${DIM}${name:0:80}${RESET}"
				return 0
				;;
			mission_failed)
				echo ""
				echo "${RED}✗ failed${RESET}  ${DIM}${name:0:80}${RESET}"
				return 1
				;;
		esac
		if [ $(( $(date +%s) - started )) -gt 180 ]; then
			echo "${YELLOW}⚠ timeout after 180s — not waiting further${RESET}"
			return 2
		fi
		sleep 2
	done
}

board() {
	curl -s "$BASE/api/mission-control/board" | python -c "
import json, sys
d = json.load(sys.stdin)
b = d.get('board', {})
cols = [('To do', b.get('created',[])), ('Running', b.get('running',[]) + b.get('paused',[])), ('Done', b.get('completed',[]) + b.get('failed',[]))]
total = sum(len(c[1]) for c in cols)
print(f'Board: {total} missions total')
for title, entries in cols:
    print(f'  {title}: {len(entries)}')
    for e in entries[:6]:
        name = (e.get('missionName') or '')[:70]
        dot = {'running':'>','paused':'=','completed':'+','failed':'x','created':'o'}.get(e.get('status','?'),'?')
        print(f'    {dot} {e[\"missionId\"]:30}  {name}')
    if len(entries) > 6:
        print(f'    … {len(entries)-6} more')
"
}

status() {
	local id="$1"
	curl -s "$BASE/api/mission-control/status?missionId=$id" | python -c "
import json, sys
d = json.load(sys.stdin)
s = d.get('snapshot', {})
r = list(reversed(s.get('recent', [])))
print(f'Mission: $id')
if r:
    name = r[-1].get('missionName') or '(no name)'
    print(f'Name:    {name}')
print(f'Events:  {len(r)}')
print()
for e in r:
    ts = e['timestamp'][11:19]
    print(f\"  {ts}  {e['eventType']:22}  {e['summary'][:70]}\")
"
}

case "${1:-}" in
	list)
		echo "${BOLD}Available tests${RESET}"
		for n in "${TEST_NAMES[@]}"; do
			printf "  %-16s %s\n" "$n" "${TEST_GOAL[$n]:0:80}"
		done
		;;
	run)
		[ -z "${2:-}" ] && { echo "${RED}need a test name${RESET}"; usage; exit 1; }
		dispatch "$2"
		;;
	board)
		board
		;;
	status)
		[ -z "${2:-}" ] && { echo "${RED}need a mission id${RESET}"; exit 1; }
		status "$2"
		;;
	watch)
		[ -z "${2:-}" ] && { echo "${RED}need a mission id${RESET}"; exit 1; }
		watch_mission "$2"
		;;
	""|help|-h|--help)
		usage
		;;
	*)
		echo "${RED}unknown command: $1${RESET}"
		usage
		exit 1
		;;
esac
