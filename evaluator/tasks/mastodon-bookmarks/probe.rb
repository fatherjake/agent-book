# frozen_string_literal: true
#
# HIDDEN probe for mastodon-bookmarks (bin/rails runner, development DB). Run after the API checks
# bookmarked the 'delete_me' and 'export' statuses as alice.
#  - deletes 'delete_me' with RemoveStatusService (the normal deletion path)
#  - builds alice's archive with BackupService and reads bookmarks.json / actor.json from it
require File.join(ENV.fetch('FRUGAL_EVAL_DIR', '/tmp/frugal-eval'), 'seed_helpers.rb')
require 'zlib'
require 'rubygems/package'
include FrugalSeed
inline!

out = {}

begin
  st = Status.find_by(id: args['delete_id'])
  RemoveStatusService.new.call(st) if st
  out['deleted'] = Status.where(id: args['delete_id']).exists? ? 'still exists' : 'deleted'
rescue StandardError => e
  out['deleted'] = "error: #{e.class}: #{e.message}"
end

begin
  user = User.find_by!(email: args['email'])
  backup = Backup.create!(user: user)
  BackupService.new.call(backup)
  backup.reload
  files = {}
  path = backup.dump.path
  Zlib::GzipReader.open(path) do |gz|
    Gem::Package::TarReader.new(gz) do |tar|
      tar.each do |entry|
        next unless entry.file?
        name = entry.full_name.sub(%r{\A\./}, '')
        files[name] = entry.read if %w(bookmarks.json actor.json).include?(name)
      end
    end
  end
  out['archive_files'] = files.keys
  out['bookmarks_json'] = files['bookmarks.json'] && JSON.parse(files['bookmarks.json'])
  out['actor_bookmarks'] = files['actor.json'] && JSON.parse(files['actor.json'])['bookmarks']
rescue StandardError => e
  out['export_error'] = "#{e.class}: #{e.message}"
end

emit(out)
