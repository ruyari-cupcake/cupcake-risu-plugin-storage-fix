# Sourced by run-all.sh (run from the repo root). The gate reads this tree for its whole run: an edit
# to the tool, its bundle or the drivers mid-run would mix two versions into one "every step passed".
# Each step therefore re-checks the tree it started on and stops the gate the moment it moved.
# Scenario output under tests/live/work/ is excluded (the drivers write there on purpose).

venue_sum() {
  find src dist tests scripts package.json -type f -not -path 'tests/live/work/*' -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

venue_freeze() {
  VENUE_SUM=$(venue_sum)
}

step() {
  "$@"
  if [ "$(venue_sum)" != "$VENUE_SUM" ]; then
    echo "run-all: VENUE_CHANGED_MID_RUN after: $* — a file the gate reads changed during the run; start the gate again on a tree nobody edits" >&2
    exit 1
  fi
}
