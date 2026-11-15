You are working in an existing codebase: the Mastodon server and web client (Ruby on Rails API +
React/Redux web UI), checked out at `/workspace`. It is a git repository; commit nothing, your
working-tree changes are what gets evaluated.

Implement **Bookmarks**: a private, per-user list of saved statuses. Users bookmark or un-bookmark
any status they can see, from the status action bar in the web UI or through the REST API, and
open a "Bookmarks" column that lists what they saved. Bookmarks are never federated and never
visible to anybody but their owner.

The full feature specification (REST API, OAuth scopes, data model, web UI entry points and the
accessible names the UI must use) is in `/spec/feature.md`. Read it first; it is the contract your
work is checked against.

Environment notes:

* Postgres and Redis run inside this container (`/opt/frugal/task/services status`). There is no
  network access, so you can't install new gems or npm packages; use what is already installed.
* `bundle exec rspec <files>` runs specs against the test database. `bin/rails db:migrate` (and
  `RAILS_ENV=test bin/rails db:migrate`) apply migrations.
* `/opt/frugal/task/app start` migrates the development database, compiles the web UI's assets
  (this takes a few minutes), and serves the app at `http://127.0.0.1:3000` with Sidekiq running
  (`app status`, `app stop`, `app logs` are also available; logs are in `/tmp/frugal-app/`).
* `/opt/frugal/task/pw-node <script.js>` runs a Node.js script in which `require('playwright')`
  and a headless Chromium are available.
* Follow the conventions of the surrounding code (how favourites, pins and mutes are built is a good
  guide). Add or update specs for what you build.
* When you are done, the app must boot, migrations must run from the current schema, and the
  existing test suite must keep passing.
