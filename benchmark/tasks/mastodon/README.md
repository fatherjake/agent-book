# Mastodon task images (env stream)

Docker images for the brownfield tasks `mastodon-bookmarks` and `mastodon-filters`
(contract: `docs/TASKS.md` §3). Everything is built by `image.ts` in this directory.

> **Status: built and validated (2026-11-15)** on arm64 macOS (Docker VM 8 GB). Base ~2 GB, each task
> image ~3.3 GB, each Claude Code layer ~0.5 GB. The upstream reference passes every evaluator check
> and the bare checkpoint fails (see the VALIDATION.md files under evaluator/tasks). Sections below
> that predate the build still carry the original estimates.

## Images

| Tag | Content | Built from |
|---|---|---|
| `frugal-task-mastodon-base:<h32>` | Debian 11 slim, build toolchain and native-gem libs, PostgreSQL 13, Redis 6, user `node` (1000:1000), private Node 22 at `/opt/frugal/node`, Playwright 1.49.1 and Chromium headless shell at `/opt/frugal/pw`, `/opt/frugal/task/pw-node` | `docker/base.Dockerfile` |
| `frugal-task-<taskId>:<sha256>` | project Ruby, Node and Yarn in `/usr/local`, `/workspace` checkpoint, gems, node_modules, DB template, `services`/`app` | `docker/task.Dockerfile` + `../<taskId>/docker/{build.json,patches/}` |
| `frugal-task-<taskId>-cc:<h32>` | plus Claude Code `CLAUDE_CODE_VERSION` (runner/claude-code.ts) under `/opt/claude` | `docker/cc.Dockerfile` |
| `frugal-task-<taskId>-ref:<h32>` | **HIDDEN.** Task image plus `evaluator/tasks/<taskId>/reference.diff` applied and staged | `docker/reference.Dockerfile` |

Tags are content hashes of their inputs plus the parent tag, so an unchanged input reuses the
existing image. The task tag's sha256 is the `starterHash`. Both task images share the base layers.

```sh
npx tsx benchmark/tasks/mastodon/image.ts tags                         # print all tags (no docker)
npx tsx benchmark/tasks/mastodon/image.ts cc   mastodon-bookmarks      # base -> task -> cc
npx tsx benchmark/tasks/mastodon/image.ts task mastodon-filters        # base -> task (evaluator image)
npx tsx benchmark/tasks/mastodon/image.ts ref  mastodon-bookmarks      # hidden reference image
npx tsx benchmark/tasks/mastodon/image.ts ref-tree mastodon-bookmarks /tmp/ref-bm   # host checkout, no docker
```

Builds refuse to start below `FRUGAL_MIN_FREE_GB` (default 12) free on the host
(`FRUGAL_SKIP_DISK_CHECK=1` overrides this). `FRUGAL_MASTODON_PLATFORM=linux/amd64` forces emulation;
see "arm64" below. The runner reaches the images through `benchmark/tasks/<taskId>/docker/image.ts`,
the `image.builder` in each task.json. Its `ensureTaskImage()` returns
`{ image: <cc tag>, imageId, starterHash, baseImage: <task tag> }`. Module API: `ensureTaskImage(taskId)`
(task image), `ensureTaskCcImage(taskId)`, `ensureReferenceImage(taskId)`, `exportReferenceTree(taskId, dir)`.

## Checkpoints and versions

| | mastodon-bookmarks | mastodon-filters |
|---|---|---|
| Upstream PR | #7107 "Add bookmarks", squash `dfea7368c934f600bd0b6b93b4a6c008a4e265b0` (2019-11-13) | #7905 "Keyword/phrase filtering", squash `cdb101340a20183a82889f811d9311c370c855e5` (2018-06-29) |
| Checkpoint (first parent) | `afb398b583b23c139c5a069c1281550bb69760e0` | `fbee9b5ac898e571e384792a92b40fa1524cf127` |
| Checkpoint commit in `/workspace` | `d93102a301d53f47da3d87ea1e2d5f80122a6d8e` | `8c4bbf03c00f22c2cd61b96036a11226d5c34c5e` |
| Ruby / Bundler | 2.6.5 / 1.17.3 (`.ruby-version`, `BUNDLED WITH`) | 2.5.1 / 1.16.2 |
| Node / Yarn | 12.22.12 / 1.22.19 (engines `>=8.12 <13`; upstream Docker used 12.11.1) | 8.17.0 / 1.22.19 (node-sass 4.7.2 supports Node <= 9) |
| Rails / webpacker | 5.2.3 / 4.0.7 (dart `sass`) | 5.2.0 / 3.4.3 (`node-sass` 4.7.2) |
| Reference diff | 33 files, +712 -1, applies cleanly | 38 files, +530 -72, applies cleanly |

The checkpoint commit is reproducible: `docker/scripts/make-checkpoint.sh` fetches the single upstream
commit (`--depth 1`), applies `patches/*.patch`, deletes `.git`, and commits everything as one
commit (author/committer `frugal`, date 2000-01-01, message `checkpoint`). It then repacks and
prunes, and removes reflogs and hooks. `verify-checkpoint.sh` runs as the last build step and fails
the build if there's more than one commit, any ref besides `refs/heads/main`, any remote, shallow
file, stash, reflog, FETCH_HEAD/ORIG_HEAD, extra pack, unreachable object, or a dirty tree.

## Environment workarounds (2018/2019 code in 2026)

* **Yanked gems** (`patches/0001-gemfile-lock-yanked-gems.patch`, part of the checkpoint commit):
  rubygems.org returns 403 for `mimemagic` 0.3.2 and 0.3.3 (yanked in 2021 over a licence problem) and
  for `sidekiq-unique-jobs` 6.0.15. The patch moves them to `mimemagic 0.3.10`, which needs the
  `shared-mime-info` apt package and pulls in `nokogiri ~> 1` and `rake`, both already locked, and
  to `sidekiq-unique-jobs 6.0.16`, whose dependencies are unchanged. I checked every other locked gem
  (266 per checkpoint) and every `yarn.lock` tarball (1475 and 1230, including `uws` 8.14.1 and the
  emoji-mart codeload tarball): all still downloadable. Neither upstream diff touches the lockfiles,
  so the reference diffs still apply.
* **`git://` submodules**: `http_parser.rb` (a git gem) has `git://github.com/...` submodules.
  GitHub has disabled that protocol, so a system git config rewrites `git://github.com/` to
  `https://github.com/`.
* **Debian bullseye** is past its LTS end. `scripts/apt-sources.sh` uses deb.debian.org while it
  still serves bullseye and falls back to archive.debian.org (with `Check-Valid-Until false`) when it
  stops. Bullseye is the newest Debian that still ships OpenSSL 1.1 (Ruby < 3.1 can't build against
  OpenSSL 3) and `python2` (node-gyp 3 for node-sass on the filters checkpoint). Its glibc 2.31 is
  still accepted by Playwright's Chromium, hence Playwright 1.49.1 rather than the host's 1.65.
* **gcc 10** defaults to `-fno-common`, which breaks some old C extensions. Ruby is built with
  `optflags='-O2 -fcommon'`, and extensions inherit that through RbConfig.
* nokogiri uses the system libxml2/libxslt (`--use-system-libraries`), which is faster to build
  than the vendored copies.
* `devise_pam_authenticatable2` (optional group `pam_authentication`) is installed
  (`BUNDLE_WITH`) because the filters checkpoint's `.env.test` sets `PAM_ENABLED=true`.
* `uws` (filters, the streaming server only) has no arm64 binary. Its install script fails softly,
  and the streaming server isn't needed by the tasks or the evaluator. `node-zopfli` is optional.

## Inside the image

* `/workspace`: repo at the checkpoint, uid 1000, `git status` clean. node_modules is in the
  workspace (copied into the per-container `/workspace` volume). Gems are in
  `/opt/frugal/bundle` (`BUNDLE_PATH`, read-only at run time, `BUNDLE_FROZEN=true`), with all groups
  installed, including development and test.
* Runtime env: `DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=mastodon`, `PGHOST/PGUSER/PGDATABASE` for
  `psql`, `REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_URL=redis://127.0.0.1:6379/0`,
  `DISABLE_SPRING=1`, yarn and npm caches under `/tmp`, and `/opt/frugal/task` on PATH.
* **Deviations from §3 (deliberate):** `RAILS_ENV` and `LOCAL_DOMAIN` are **not** baked in.
  `spec/rails_helper.rb` does `ENV['RAILS_ENV'] ||= 'test'`, so a baked `RAILS_ENV=development`
  would run rspec against the development DB. Separately, `.env.test` sets `LOCAL_DOMAIN`,
  `LOCAL_HTTPS` and `NODE_ENV` for tests, and dotenv never overrides an existing variable (upstream
  specs assert on `cb6e6126.ngrok.io` URLs). Rails defaults to development anyway, and development
  defaults to `LOCAL_DOMAIN=localhost:$PORT`. Dev/test `secret_key_base` values are committed
  upstream in `config/secrets.yml`; no secret is added.
* **Postgres and Redis** (`/opt/frugal/task/services start|stop|status|restart`, idempotent) run as
  the calling user. All state lives in `$FRUGAL_DATA_DIR` (default `/data`). If there's no
  `pg/PG_VERSION` there, the template `/opt/frugal/data-template` is copied in first. Both listen on
  127.0.0.1 TCP only, Postgres with `unix_socket_directories = ''`, so **nothing outside `/data`
  needs to be writable and no extra tmpfs is required** (task.json declares only
  `extraVolumes: ["/data"]`). Postgres runs with `fsync=off`, `synchronous_commit=off` and
  `full_page_writes=off`, since the data is throwaway. The servers are started with `setsid`, so
  they outlive the `docker exec` that started them. A stale `postmaster.pid` is cleaned up.
  `status` exits 3 if either server is down.
* **DB template** (`scripts/build-db-template.sh`, at build time): `initdb` (superuser `mastodon`,
  trust auth on loopback), then `db:create db:schema:load db:seed` (development), then
  `RAILS_ENV=test db:create db:schema:load`. The dev seed creates the `Web` OAuth superapp, which the
  web UI login needs, and `admin@localhost:3000` / `mastodonadmin`.
* **`/opt/frugal/task/app start [--port N] [--no-sidekiq] [--skip-migrate]`** (evaluator) runs
  `services start`, then `bin/rails db:migrate` (development), then compiles the development packs
  with `Webpacker.compile`. That's the same step the dev server runs on a first request: it records
  the source digest, so no request ever compiles. Measured: a cold `app start` takes about 18 s, 13 s
  of it webpack. Baking precompiled packs into the image cut that to 6 s, which wasn't worth changing
  the environment mid-research, so it was reverted. (`rails webpacker:compile` would force
  `NODE_ENV=production` on webpacker 3.) It then starts puma (single mode, `0.0.0.0:$PORT`) and
  sidekiq in the background, and returns once `GET /about` is 200. Rails serves the packs from
  `public/packs`. `app run` does the same but keeps puma in the foreground. `app stop|status|logs`
  are also available. Logs go to `/tmp/frugal-app/*.log`, and webpack errors also go to
  `log/development.log`. `NODE_OPTIONS=--max-old-space-size=3072` is set for webpack. If the evaluator
  serves on a port other than the one the browser uses, it can pass `LOCAL_DOMAIN`. URLs in HTML
  responses use the request Host header in any case.
* **Claude Code** (`-cc` image) is installed under `/opt/claude` with the private Node 22, which is
  needed because the npm package's postinstall requires Node >= 22. `/usr/local/bin/claude` is a
  symlink to the package's native binary, so `claude` needs no Node at run time, and `node`/`yarn`
  on PATH stay at 8 or 12. The build checks both (`claude --version`, and a project node below 18).
* **`/opt/frugal/task/pw-node script.js`**: runs a script on the private Node 22 with
  `require('playwright')` resolvable (`NODE_PATH`) and Chromium headless shell preinstalled. A
  preload adds `--disable-dev-shm-usage --disable-gpu` to every Chromium launch. Playwright already
  runs Chromium without its own sandbox, so no capabilities are needed. Use CommonJS `require`.
  The base image build smoke-tests it (Chromium launches and reads a `setContent` page).
  `/opt/frugal/task/pw-screenshot.js [url] [out.png]` is an example, and also the contract check: it
  opens the app (default `http://127.0.0.1:3000/`), saves a full-page screenshot to `/tmp/home.png`
  and prints `{url, status, title}`. The script and preload were *verified* on the host against a
  local page. The in-image run against `app start` is still pending a build:
  `docker exec mtest bash -c '/opt/frugal/task/app start && /opt/frugal/task/pw-node /opt/frugal/task/pw-screenshot.js'`.
  It lives in the **base** image, so both tasks share it. Estimated size: Chromium headless shell
  about 110 MB, plus its apt libraries about 120 MB, plus the playwright package about 10 MB, so
  roughly 0.25 GB. The private Node 22 (about 0.18 GB) is shared with Claude Code.

## Portability (arm64 Mac now, linux/amd64 VPS later)

Nothing in the build depends on the Mac. BuildKit's `TARGETARCH` selects the Node tarball and
checksum (both arm64 and amd64 are pinned in `build.json` and `base.Dockerfile`). Ruby and every
native gem are built from source either way. On amd64, `node-sass` 4.7.2 downloads its prebuilt
`linux-x64-57` binary and `uws` ships x64 binaries, so the arm64-only risks (compiling node-sass
and uws from source) disappear. The builder builds for the docker daemon's native platform.
`FRUGAL_MASTODON_PLATFORM` overrides it, and the platform is part of the base hash. The disk check
measures Docker's root dir when dockerd runs natively on Linux (e.g. `/var/lib/docker`), and the
home filesystem on Docker Desktop. If an arm64-only native dependency fight drags on, the plan is to
document it and build on amd64.

## Running it under the sandbox hardening

The same flags as `runner/sandbox.ts`, plus the task's volume:

```sh
IMG=$(npx tsx benchmark/tasks/mastodon/image.ts tags mastodon-bookmarks | jq -r '.tasks["mastodon-bookmarks"].task')
docker run -d --name mtest --network none --user node --cpus 4 --memory 6g --memory-swap 6g \
  --pids-limit 4096 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --tmpfs /spec:rw,nosuid,nodev,noexec,size=64m,mode=0755 -v /workspace -v /data \
  --cap-drop ALL --security-opt no-new-privileges --init -e HOME=/tmp -e CI=1 "$IMG" sleep infinity
docker exec mtest /opt/frugal/task/services start
docker exec mtest bin/rails runner 'p Account.count'
docker exec mtest bundle exec rspec spec/models/status_spec.rb
docker exec mtest /opt/frugal/build/verify-checkpoint.sh /workspace
docker exec mtest bash -c 'node -v; ruby -v; ls /opt/frugal/task'
docker rm -f -v mtest
```

## Reference tree (HIDDEN, for the checks stream)

`evaluator/tasks/<taskId>/reference.diff` is the upstream squash diff, `git diff --binary
--full-index <checkpoint> <feature>`. It's the same format as the runner's `workspace.patch`, so it
can be fed straight to the evaluator as the patch file. There are two other ways to get the
reference tree:
* `image.ts ref <taskId>` builds the reference image. `/workspace` holds the reference staged on top
  of the checkpoint commit.
* `image.ts ref-tree <taskId> <dir>` builds the same checkpoint commit on the host (no docker) with
  the diff applied and staged. *Verified* for both tasks: the commit ids above match, and the diffs
  apply.

## Resources (estimates; not measured yet)

| | estimate |
|---|---|
| Base image | about 1.3 GB (toolchain 0.4, Postgres/Redis/ImageMagick 0.15, Node 22 0.2, Chromium shell and deps 0.4) |
| Task image on top of base | about 1.3 to 1.8 GB (Ruby 0.06, Node 0.07, repo + .git 0.15, gems 0.3 to 0.5, node_modules 0.5 to 0.8, DB template 0.1) |
| Claude Code layer | about 0.25 GB |
| Disk to build everything | about 6 to 7 GB of images plus 1 to 2 GB of build cache. Each running container adds roughly 1 GB (`/workspace` volume copy) plus 0.1 GB (`/data`) |
| Build time, arm64 native | base 5 to 10 min. Per task 25 to 40 min (Ruby compile 4 to 6, `bundle install` with native gems 6 to 12, `yarn install` 3 to 6, plus node-sass from source about 5 for filters, DB template 1 to 2) |
| Boot | `services start` under 5 s (template copy plus Postgres start). Rails boot 10 to 20 s. Dev webpack compile 2 to 5 min (filters, webpack 3) or 3 to 6 min (bookmarks, webpack 4) |
| Coding container | 4 CPUs, 6 GB RAM, pids 4096 (task.json). Steady state is about 1.5 GB (Postgres, Redis, Claude Code, an rspec process). A webpack compile adds 1.5 to 2.5 GB, Chromium 0.3 to 0.5 GB |
| Docker VM | 8 GB fits **one** Mastodon container at a time. Use 12 to 16 GB for a coding container plus an evaluator container, or parallel runs |

`--platform linux/amd64` (last resort, not expected to be needed) would run every Ruby, Node and
Postgres process under QEMU emulation. Expect builds about 3 to 5 times slower, rspec and webpack 2
to 4 times slower, and occasional QEMU crashes in node-sass/webpack.

## Verified without building

* Commits looked up with `gh`: the bookmarks parent is `afb398b5`, and PR #7905's squash-merge
  `cdb10134` has parent `fbee9b5a`.
* Both upstream diffs apply cleanly (`git apply --check`) to the patched checkpoints, which are
  built with the same `make-checkpoint.sh` as the image. `verify-checkpoint.sh` passes on both
  (5652 and 4718 objects, one pack).
* All locked gems and yarn tarballs are downloadable, except the three yanked gems patched above.
  Node, Ruby and Yarn checksums come from the official SHASUMS files or downloads.
* `services start|stop|status` was tested under `--read-only --cap-drop ALL --security-opt
  no-new-privileges --network none` in a throwaway `postgres:16` container (Redis stubbed). It
  covered the template copy, idempotent start and stop, the daemons outliving the exec, and
  stale-pid recovery.
* `pw-preload.cjs` was tested against the host's Playwright (Chromium launches with the extra
  flags).
* `image.ts` typechecks, `runner/tasks.ts` loads both task.json files, and
  `ensureTaskImage()` reaches the disk guard and refuses at 17 GB free.
