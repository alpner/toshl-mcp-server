#!/usr/bin/env bash
# Prompts for a secret without echoing it and writes it into /srv/toshl-mcp/toshl-mcp.env.
# Installed as /srv/toshl-mcp/set-secret.sh. Run it with a terminal, e.g.:
#
#   ssh -t root@<server> /srv/toshl-mcp/set-secret.sh MCP_OAUTH_PASSPHRASE
#
# The value never appears on a command line, in shell history or in the output.
# Restart the container afterwards (deploy.sh, or docker compose up -d --force-recreate).
set -euo pipefail

name=${1:-}
case "$name" in
    MCP_OAUTH_PASSPHRASE) min=20 ;;
    TOSHL_API_TOKEN) min=1 ;;
    *) echo "usage: set-secret.sh MCP_OAUTH_PASSPHRASE|TOSHL_API_TOKEN" >&2; exit 2 ;;
esac

env_file=/srv/toshl-mcp/toshl-mcp.env
[ -t 0 ] || { echo "Needs a terminal: use ssh -t" >&2; exit 2; }

read -rs -p "$name: " value
echo
if [ "$name" = MCP_OAUTH_PASSPHRASE ]; then
    read -rs -p "Again: " again
    echo
    if [ "$value" != "$again" ]; then
        echo "They differ; nothing written." >&2
        exit 1
    fi
    unset again
fi

if [ "${#value}" -lt "$min" ]; then
    echo "Needs at least $min characters; nothing written." >&2
    exit 1
fi
# Values are written single-quoted, which compose reads literally.
case "$value" in
    *\'*) echo "Can't contain a single quote; nothing written." >&2; exit 1 ;;
esac

umask 077
tmp=$(mktemp "$env_file.XXXXXX")
grep -v "^$name=" "$env_file" > "$tmp" 2>/dev/null || true
printf "%s='%s'\n" "$name" "$value" >> "$tmp"
unset value
chmod 600 "$tmp"
mv "$tmp" "$env_file"
echo "$name written to $env_file."
