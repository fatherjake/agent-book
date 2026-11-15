You are working in an existing codebase: the Mastodon server and web client (Ruby on Rails API +
React/Redux web UI), checked out at `/workspace`. It is a git repository; commit nothing, your
working-tree changes are what gets evaluated.

Implement **keyword and phrase filtering**: users keep a list of words or phrases they don't want
to see. Each filter applies to chosen contexts (home timeline, notifications, public timelines,
conversations). Matching statuses are hidden behind a "Filtered" placeholder in the web UI, or,
for filters marked irreversible, dropped from the home feed and notifications on the server.
Users manage their filters on a new "Filters" settings page and through a new REST API.

The full feature specification (REST API, data model, server-side and client-side filtering
rules, the settings pages and the accessible names the UI must use) is in `/spec/feature.md`.
Read it first; it is the contract your work is checked against.

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
* Follow the conventions of the surrounding code (the invites settings page and the existing
  REST controllers are good guides). Add or update specs for what you build.
* When you are done, the app must boot, migrations must run from the current schema, and the
  existing test suite must keep passing.
