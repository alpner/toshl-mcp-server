# Deploy: toshl-mcp.alpner.com

This branch (`deploy/vps` on alpner/toshl-mcp-server) is what runs on the Hetzner VPS
("lab") as a remote MCP connector for claude.ai. It is upstream `master` plus these open
pull requests, merged in this order:

| PR | Branch | What it adds |
| --- | --- | --- |

No open PRs right now: #48, #49, #50, #52, #53 and #54 were all merged upstream on
2026-10-17, so the branch is plain upstream `master` plus the fork-only files.

`scripts/rebuild-deploy-branch.sh` reads this table, so keep its row format:
``| [#N](url) | `branch` | description |``, in merge order. An empty table is fine.

The branch also carries fork-only files that no upstream PR contains: this file,
`deploy/`, and `scripts/`. The rebuild puts them back as one commit on top.

## Layout on the server

Mirrors Kept (`/srv/kept`): one folder per app, a shared external `web` Docker network,
no published ports, Caddy in front.

```
/srv/toshl-mcp/              root, 700
  docker-compose.yml         from deploy/docker-compose.yml
  deploy.sh, set-secret.sh   from deploy/
  toshl-mcp.env              root, 600: TOSHL_API_TOKEN, MCP_OAUTH_PASSPHRASE, MCP_OAUTH_SIGNING_KEY
  state/                     uid 1000, 700: refresh-token hashes (survive redeploys)
  src/                       clone of this branch; the image is built from it
  current-image, previous-image   which toshl-mcp:<commit> tags are running and the rollback target
```

Caddy (`/srv/caddy/conf/Caddyfile`):

```
toshl-mcp.alpner.com {
	reverse_proxy toshl-mcp:3000
}
```

The connector URL in claude.ai is `https://toshl-mcp.alpner.com/mcp`, with the OAuth client
left on "Use Claude's published identity".

## Routine

`deploy/vps` is never edited by hand and never pulled. It is rebuilt from upstream `master`
plus the table above, force-pushed with a lease, and the server resets to it.

### On the server

```bash
/srv/toshl-mcp/deploy.sh              # fetch, reset --hard origin/deploy/vps, build toshl-mcp:<commit>, restart, check /healthz
/srv/toshl-mcp/deploy.sh --rollback   # back to the image from before the last deploy
docker logs --tail 100 toshl-mcp      # LOG_LEVEL=info: no tokens, no entry payloads
```

`deploy.sh`, `set-secret.sh` and `docker-compose.yml` in `/srv/toshl-mcp` are copies.
`deploy.sh` prints a warning with the `install` command when the branch has a newer version.

### Rebuilding the branch (on the PC, in the worktree that has `deploy/vps` checked out)

```bash
scripts/rebuild-deploy-branch.sh             # rebuild, frozen install, tsc, credential-free tests, push --force-with-lease
scripts/rebuild-deploy-branch.sh --no-push   # same, stop before pushing
```

It stops in these cases:
- a listed PR is no longer open, or its branch doesn't match the table (checked when `gh` is available)
- a merge conflict has no recorded resolution
- the build or tests fail
- there are local changes outside the fork-only files

**A PR merged upstream:**
1. Delete its row from the table.
2. Run `scripts/rebuild-deploy-branch.sh`.
3. Run `ssh root@<server> /srv/toshl-mcp/deploy.sh`.

The PR's change now comes in through upstream `master`.

**A new PR to deploy:**
1. Push its branch to the fork and open the PR upstream.
2. Add a row in the right merge order.
3. Rebuild, then deploy.

**A PR branch was updated** (review fixes, a rebase): just rebuild, then deploy.

**Stacked PRs** (one PR built on another's branch): once the lower one is squash-merged,
the upper one still carries its original commits. Move it onto `master` with
`git rebase --onto origin/master <lower PR's last commit> <upper branch>`, test, and
`git push --force-with-lease`.

### The local Claude Desktop checkout

The checkout Desktop runs (`dev/toshl-mcp-server`) tracks the same branch through a local
`desktop` branch. A branch can be checked out in only one worktree, and this one holds
`deploy/vps`. Desktop speaks stdio, so the HTTP and OAuth code never runs there.

```bash
# Quit Claude Desktop first.
scripts/update-local-checkout.sh   # desktop := fork/deploy/vps (reset, so force-pushes are fine), frozen install, build
# Start Claude Desktop again.
```

First time, before the script exists in that checkout:
`git fetch fork && git checkout -B desktop fork/deploy/vps`, then run the script.

## Secrets

- **`TOSHL_API_TOKEN`** and **`MCP_OAUTH_PASSPHRASE`** are entered by the owner with
  `ssh -t root@<server> /srv/toshl-mcp/set-secret.sh <NAME>`. That script prompts without
  echo, so the value never appears in a command line, shell history or output.
- **`MCP_OAUTH_SIGNING_KEY`** was generated on the server
  (`openssl rand -base64 48`) and has never left it.
  - Replacing it signs every client out within the hour, when their access tokens expire.
  - To rotate without that, move the old value to `MCP_OAUTH_SIGNING_KEY_PREVIOUS` first.
- **Restart the container after changing any secret:** `docker compose up -d --force-recreate`.
- **Revoking every connector at once:** delete `state/refresh-tokens.json` and replace the
  signing key.
