#!/bin/sh
set -eu
exec /usr/bin/python3 /usr/local/sbin/safe-scheduled-reboot.py "$@"
