#!/bin/zsh

AUTO_COMMIT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$AUTO_COMMIT_DIR/config"
WORKER="$AUTO_COMMIT_DIR/worker.sh"

# ---------------------------------------------------------
# Locate Git repository
# ---------------------------------------------------------

ROOT="$(git -C "$AUTO_COMMIT_DIR" rev-parse --show-toplevel 2>/dev/null)"

if [[ -z "$ROOT" ]]; then
    echo "Auto-commit could not locate the Git repository."
    exit 1
fi


# ---------------------------------------------------------
# Runtime state
#
# Store this inside Git's internal directory so things like
# PID files, session files, and logs can never be committed.
# ---------------------------------------------------------

STATE_DIR="$(git -C "$ROOT" rev-parse --git-path vsetup-auto-commit)"

if [[ "$STATE_DIR" != /* ]]; then
    STATE_DIR="$ROOT/$STATE_DIR"
fi

SESSIONS_DIR="$STATE_DIR/sessions"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/log"

mkdir -p "$SESSIONS_DIR"


# ---------------------------------------------------------
# Config helpers
# ---------------------------------------------------------

load_config() {
    if [[ ! -f "$CONFIG" ]]; then
        echo "Auto-commit config is missing:"
        echo "  $CONFIG"
        return 1
    fi

    source "$CONFIG"

    if [[ "$ENABLED" != "true" && "$ENABLED" != "false" ]]; then
        echo "Invalid ENABLED value in auto-commit config."
        echo "Expected:"
        echo "  ENABLED=true"
        echo "or:"
        echo "  ENABLED=false"
        return 1
    fi

    if ! [[ "$INTERVAL_SECONDS" =~ '^[0-9]+$' ]] ||
       [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
        echo "Invalid INTERVAL_SECONDS in auto-commit config."
        return 1
    fi

    return 0
}


set_config_value() {
    local key="$1"
    local value="$2"

    python3 - "$CONFIG" "$key" "$value" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

lines = path.read_text(encoding="utf-8").splitlines()

result = []
found = False

for line in lines:
    if line.startswith(f"{key}="):
        result.append(f"{key}={value}")
        found = True
    else:
        result.append(line)

if not found:
    result.append(f"{key}={value}")

path.write_text("\n".join(result) + "\n", encoding="utf-8")
PY
}


# ---------------------------------------------------------
# Worker helpers
# ---------------------------------------------------------

worker_running() {
    if [[ ! -f "$PID_FILE" ]]; then
        return 1
    fi

    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"

    if ! [[ "$pid" =~ '^[0-9]+$' ]]; then
        rm -f "$PID_FILE"
        return 1
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        return 1
    fi

    # Avoid treating a reused PID as our worker.
    local command
    command="$(ps -p "$pid" -o command= 2>/dev/null)"

    if [[ "$command" != *"$WORKER"* ]]; then
        rm -f "$PID_FILE"
        return 1
    fi

    return 0
}


stop_worker() {
    if worker_running; then
        local pid
        pid="$(cat "$PID_FILE")"

        kill "$pid" 2>/dev/null
    fi

    rm -f "$PID_FILE"
}


cleanup_dead_sessions() {
    local session
    local pid

    for session in "$SESSIONS_DIR"/*(N); do
        pid="$(basename "$session")"

        if ! [[ "$pid" =~ '^[0-9]+$' ]] ||
           ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$session"
        fi
    done
}


has_sessions() {
    local sessions
    sessions=("$SESSIONS_DIR"/*(N))

    [[ ${#sessions[@]} -gt 0 ]]
}


validate_remote() {
    if ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
        echo "No Git remote named 'origin' is configured."
        return 1
    fi

    if ! git -C "$ROOT" ls-remote origin >/dev/null 2>&1; then
        echo "Git remote 'origin' could not be reached."
        return 1
    fi

    return 0
}


start_worker() {
    if worker_running; then
        return 0
    fi

    validate_remote || return 1

    nohup zsh "$WORKER" >> "$LOG_FILE" 2>&1 </dev/null &

    local pid=$!

    echo "$pid" > "$PID_FILE"

    return 0
}


# ---------------------------------------------------------
# Commands
# ---------------------------------------------------------

COMMAND="$1"

case "$COMMAND" in

    on)
        load_config || exit 1

        set_config_value "ENABLED" "true" || exit 1

        echo "Auto-commit enabled."
        echo "It will run whenever a shell is inside this repo."
        ;;


    off)
        load_config || exit 1

        set_config_value "ENABLED" "false" || exit 1

        stop_worker

        rm -f "$SESSIONS_DIR"/*(N)

        echo "Auto-commit disabled."
        ;;


    interval)
        load_config || exit 1

        SECONDS="$2"

        if [[ -z "$SECONDS" ]]; then
            echo "Usage:"
            echo "  vsetup auto-commit interval <seconds>"
            exit 1
        fi

        if ! [[ "$SECONDS" =~ '^[0-9]+$' ]] ||
           [[ "$SECONDS" -lt 1 ]]; then
            echo "Interval must be a positive integer."
            exit 1
        fi

        set_config_value "INTERVAL_SECONDS" "$SECONDS" || exit 1

        echo "Auto-commit interval set to $SECONDS seconds."
        ;;


    status)
        load_config || exit 1

        cleanup_dead_sessions

        echo "Enabled: $ENABLED"
        echo "Interval: $INTERVAL_SECONDS seconds"

        if worker_running; then
            echo "Worker: running"
            echo "PID: $(cat "$PID_FILE")"
        else
            echo "Worker: stopped"
        fi

        local_sessions=("$SESSIONS_DIR"/*(N))
        echo "Active shells: ${#local_sessions[@]}"

        echo "Log:"
        echo "  $LOG_FILE"
        ;;

    watch)
        if [[ ! -f "$LOG_FILE" ]]; then
            touch "$LOG_FILE"
        fi

        echo "Watching auto-commit log."
        echo "Press Ctrl+C to stop watching."
        echo

        tail -f "$LOG_FILE"
        ;;
    enter)
        SHELL_PID="$2"

        if ! [[ "$SHELL_PID" =~ '^[0-9]+$' ]]; then
            exit 1
        fi

        load_config || exit 1

        # Disabled means being inside the repo changes nothing.
        if [[ "$ENABLED" != "true" ]]; then
            rm -f "$SESSIONS_DIR/$SHELL_PID"
            stop_worker
            exit 0
        fi

        # If no worker survived (for example after reboot),
        # discard stale sessions before registering this one.
        if ! worker_running; then
            rm -f "$SESSIONS_DIR"/*(N)
        else
            cleanup_dead_sessions
        fi

        touch "$SESSIONS_DIR/$SHELL_PID"

        start_worker
        ;;


    leave)
        SHELL_PID="$2"

        if [[ -n "$SHELL_PID" ]]; then
            rm -f "$SESSIONS_DIR/$SHELL_PID"
        fi

        cleanup_dead_sessions

        # Another terminal is still inside this repo.
        if has_sessions; then
            exit 0
        fi

        stop_worker
        ;;


    *)
        echo "Usage:"
        echo "  control.sh on"
        echo "  control.sh off"
        echo "  control.sh status"
        echo "  control.sh watch"
        echo "  control.sh interval <seconds>"
        echo "  control.sh enter <shell-pid>"
        echo "  control.sh leave <shell-pid>"
        exit 1
        ;;

esac