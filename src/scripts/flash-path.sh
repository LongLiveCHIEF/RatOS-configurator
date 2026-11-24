#!/usr/bin/env bash
# The configurator flashes boards without a flash script of their own, such as toolboards, through
# this script. It runs configuration/scripts/flash-path.sh, which the board flash scripts use, so
# every board is flashed the same way.
#
# USAGE: flash-path.sh <mcu path> [flash path]

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
exec "$SCRIPT_DIR/../../configuration/scripts/flash-path.sh" "$@"
