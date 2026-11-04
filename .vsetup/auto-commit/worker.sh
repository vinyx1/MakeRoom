#!/bin/zsh

AUTO_COMMIT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$AUTO_COMMIT_DIR/config"

ROOT="$(git -C "$AUTO_COMMIT_DIR" rev-parse --show-toplevel 2>/dev/null)"

if [[ -z "$ROOT" ]]; then
    exit 1
fi


# ---------------------------------------------------------
# Runtime state
# ---------------------------------------------------------

STATE_DIR="$(git -C "$ROOT" rev-parse --git-path vsetup-auto-commit)"

if [[ "$STATE_DIR" != /* ]]; then
    STATE_DIR="$ROOT/$STATE_DIR"
fi

SESSIONS_DIR="$STATE_DIR/sessions"
PID_FILE="$STATE_DIR/pid"


# ---------------------------------------------------------
# Clean our PID file when this worker exits.
# Only delete it if it still points to this exact process.
# ---------------------------------------------------------

cleanup() {
    if [[ -f "$PID_FILE" ]]; then
        CURRENT_PID="$(cat "$PID_FILE" 2>/dev/null)"

        if [[ "$CURRENT_PID" == "$$" ]]; then
            rm -f "$PID_FILE"
        fi
    fi
}

# ---------------------------------------------------------
# Stop when asked
#
# A stop request wakes the worker from its sleep. If a commit
# or push is running, it finishes first, so the worker never
# stops between the two.
# ---------------------------------------------------------

STOP_REQUESTED=false
SLEEP_PID=""

request_stop() {
    STOP_REQUESTED=true

    if [[ -n "$SLEEP_PID" ]]; then
        kill "$SLEEP_PID" 2>/dev/null
    fi
}

trap cleanup EXIT
trap request_stop INT TERM


# ---------------------------------------------------------
# Helper: remove shells that no longer exist
# ---------------------------------------------------------

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


# ---------------------------------------------------------
# Main loop
# ---------------------------------------------------------

while true; do

    if [[ "$STOP_REQUESTED" == "true" ]]; then
        exit 0
    fi

    if [[ ! -f "$CONFIG" ]]; then
        exit 0
    fi

    source "$CONFIG"

    # Feature was turned off.
    if [[ "$ENABLED" != "true" ]]; then
        exit 0
    fi

    if ! [[ "$INTERVAL_SECONDS" =~ '^[0-9]+$' ]] ||
       [[ "$INTERVAL_SECONDS" -lt 1 ]]; then
        exit 1
    fi

    cleanup_dead_sessions

    sessions=("$SESSIONS_DIR"/*(N))

    # Nobody is currently inside the repo.
    if [[ ${#sessions[@]} -eq 0 ]]; then
        exit 0
    fi


    # -----------------------------------------------------
    # Wait one complete interval
    # -----------------------------------------------------

    # In the background, because a signal can interrupt wait
    # but has to wait for a foreground sleep to finish.
    sleep "$INTERVAL_SECONDS" &
    SLEEP_PID=$!

    wait "$SLEEP_PID"
    SLEEP_PID=""

    if [[ "$STOP_REQUESTED" == "true" ]]; then
        exit 0
    fi


    # -----------------------------------------------------
    # Re-check everything after sleeping
    # -----------------------------------------------------

    if [[ ! -f "$CONFIG" ]]; then
        exit 0
    fi

    source "$CONFIG"

    if [[ "$ENABLED" != "true" ]]; then
        exit 0
    fi

    cleanup_dead_sessions

    sessions=("$SESSIONS_DIR"/*(N))

    if [[ ${#sessions[@]} -eq 0 ]]; then
        exit 0
    fi


    # -----------------------------------------------------
    # Stage changes
    # -----------------------------------------------------

    git -C "$ROOT" add . || exit 1

    # Nothing changed.
    if git -C "$ROOT" diff --cached --quiet; then
        continue
    fi


    # -----------------------------------------------------
    # Build commit message
    # -----------------------------------------------------

    CHANGED_COUNT="$(
        git -C "$ROOT" diff --cached --name-only |
        wc -l |
        tr -d ' '
    )"

    FIRST_FILE="$(
        git -C "$ROOT" diff --cached --name-only |
        head -n 1
    )"

    if [[ "$CHANGED_COUNT" -eq 1 ]]; then
        COMMIT_MESSAGE="Auto-update $FIRST_FILE"
    else
        COMMIT_MESSAGE="Auto-update $CHANGED_COUNT files"
    fi


    # -----------------------------------------------------
    # Commit + push
    # -----------------------------------------------------

    git -C "$ROOT" commit -m "$COMMIT_MESSAGE" || exit 1

    git -C "$ROOT" push || exit 1

    #echo "[$(date '+%H:%M:%S')] Auto-committed: $COMMIT_MESSAGE"

done