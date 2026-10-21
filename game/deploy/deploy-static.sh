#!/usr/bin/env bash
# Static deploy of the game client (index/play/consent + JS) to /home/fpv/lightshow-game/app (bind-mounted
# read-only into the nginx container, so no restart is needed). 2026-10-21.
#  1. GA guard on the source — refuses to deploy without the GA4 measurement id;
#  2. backup tarball of /home/fpv/lightshow-game on the server (+ sha256, listing check);
#  3. upload + copy only the listed files; 4. live GA guard + /healthz.
# Does NOT touch config.env, ws/, nginx/, worlds/ or any container. Run it under the hub deploy lock.
#   game/deploy/deploy-static.sh [file ...]     (default: the client files below)
set -euo pipefail
cd "$(dirname "$0")/.."                      # -> game/
SSH="ssh -p 2222 -i $HOME/.ssh/fpv_hetzner_key -o ConnectTimeout=20 fpv@65.109.11.177"
SCP="scp -P 2222 -i $HOME/.ssh/fpv_hetzner_key -o ConnectTimeout=20"
FILES=("$@"); [ ${#FILES[@]} -eq 0 ] && FILES=(consent.js index.html play.html play.js main.js)
TAG="$(date -u +%Y%m%d-%H%M)-ga"

node deploy/check-ga.mjs                     # 1. fails -> set -e stops the deploy
for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done

echo "== backup /home/fpv/lightshow-game-backup-$TAG.tgz"
$SSH "set -e; cd /home/fpv; tar czf lightshow-game-backup-$TAG.tgz lightshow-game; chmod 600 lightshow-game-backup-$TAG.tgz; \
  sha256sum lightshow-game-backup-$TAG.tgz; tar tzf lightshow-game-backup-$TAG.tgz | grep -c '^lightshow-game/app/' ; \
  tar xzf lightshow-game-backup-$TAG.tgz -O lightshow-game/app/index.html | cmp - lightshow-game/app/index.html && echo restore-check-ok"

echo "== upload ${FILES[*]}"
$SSH "mkdir -p /tmp/lsg-$TAG"
$SCP "${FILES[@]}" "fpv@65.109.11.177:/tmp/lsg-$TAG/"
$SSH "set -e; cd /tmp/lsg-$TAG; for f in ${FILES[*]}; do cp \"\$f\" /home/fpv/lightshow-game/app/\"\$f\"; done; \
  cd /home/fpv/lightshow-game/app && md5sum ${FILES[*]}; rm -rf /tmp/lsg-$TAG"

echo "== live check"
node deploy/check-ga.mjs --live https://game.flyreelstudio.eu
curl -fsS https://game.flyreelstudio.eu/healthz; echo
echo "rollback: $SSH 'cd /home/fpv && tar xzf lightshow-game-backup-$TAG.tgz lightshow-game/app'"
