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

trap cleanup EXIT INT TERM


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

    sleep "$INTERVAL_SECONDS"


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