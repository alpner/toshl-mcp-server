#!/usr/bin/env bash
# Deploys toshl-mcp-server on this server. Installed as /srv/toshl-mcp/deploy.sh.
#
#   /srv/toshl-mcp/deploy.sh             pull deploy/vps, build, restart, check health
#   /srv/toshl-mcp/deploy.sh --rollback  run the image from before the last deploy again
#
# Each build is tagged toshl-mcp:<commit>; toshl-mcp:current is what compose runs.
# current-image and previous-image record which tags those are.
set -euo pipefail
cd /srv/toshl-mcp

BRANCH=deploy/vps
PUBLIC_URL=https://toshl-mcp.alpner.com

wait_healthy() {
    for _ in $(seq 1 30); do
        if docker exec toshl-mcp wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
            echo "==> Healthy inside the container"
            if curl -fsS --max-time 15 "$PUBLIC_URL/healthz" >/dev/null; then
                echo "==> Healthy at $PUBLIC_URL/healthz"
                return 0
            fi
            echo "!! $PUBLIC_URL/healthz failed: check Caddy (docker logs caddy) and DNS"
            return 1
        fi
        sleep 1
    done
    echo "!! Not healthy after 30 s. Last log lines:"
    docker logs --tail 30 toshl-mcp
    return 1
}

if [ "${1:-}" = "--rollback" ]; then
    previous=$(cat previous-image 2>/dev/null) || { echo "!! No previous image recorded"; exit 1; }
    current=$(cat current-image)
    echo "==> Rolling back from $current to $previous"
    docker tag "$previous" toshl-mcp:current
    echo "$previous" > current-image
    echo "$current" > previous-image
    docker compose up -d --force-recreate
    wait_healthy
    exit
fi

echo "==> Fetching $BRANCH"
# deploy/vps is rebuilt and force-pushed, so never pull: fetch, then reset hard to the remote
# branch, and clean so nothing left over from an older build reaches the image.
git -C src fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -C src reset --quiet --hard "origin/$BRANCH"
git -C src clean -ffdxq
commit=$(git -C src rev-parse --short HEAD)
echo "    $(git -C src log --oneline -1)"
image="toshl-mcp:$commit"

echo "==> Building $image"
docker build --quiet -t "$image" src >/dev/null

if [ -f current-image ] && [ "$(cat current-image)" != "$image" ]; then
    cp current-image previous-image
fi
echo "$image" > current-image
docker tag "$image" toshl-mcp:current

echo "==> Restarting"
docker compose up -d --force-recreate
wait_healthy

# Keep the running build and the rollback target; drop older builds.
keep="$(cat current-image) $(cat previous-image 2>/dev/null || true) toshl-mcp:current"
for tag in $(docker image ls toshl-mcp --format '{{.Repository}}:{{.Tag}}'); do
    case " $keep " in
        *" $tag "*) ;;
        *) docker image rm "$tag" >/dev/null 2>&1 || true ;;
    esac
done

echo "==> Deployed $commit"

# The installed copies don't update themselves.
for file in deploy.sh docker-compose.yml set-secret.sh; do
    if ! cmp -s "src/deploy/$file" "$file"; then
        echo "!! $file differs from the branch. Review, then install it:"
        echo "     diff /srv/toshl-mcp/$file /srv/toshl-mcp/src/deploy/$file"
        echo "     install -m $( [ "$file" = docker-compose.yml ] && echo 644 || echo 700 ) /srv/toshl-mcp/src/deploy/$file /srv/toshl-mcp/$file"
    fi
done
