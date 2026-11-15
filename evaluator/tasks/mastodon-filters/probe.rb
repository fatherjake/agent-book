# frozen_string_literal: true
#
# HIDDEN probe for mastodon-filters (bin/rails runner, development DB). Posts statuses through the
# normal delivery path with Sidekiq jobs run inline:
#   Status.create! → ProcessMentionsService (→ LocalNotificationWorker → NotifyService)
#                  → FanOutOnWriteService (→ FeedInsertWorker → FeedManager#filter?(:home) → home feed)
# Args: { "posts": [ { "key", "author" (username), "text", "spoiler_text"? } ] }
# Output: { "ids": { key => status id } } or { "error": ... }
require File.join(ENV.fetch('FRUGAL_EVAL_DIR', '/tmp/frugal-eval'), 'seed_helpers.rb')
include FrugalSeed
inline!

ids = {}
errors = {}
args.fetch('posts', []).each do |p|
  begin
    author = Account.find_local(p['author']) || raise("no local account #{p['author']}")
    status = status!(author, p['text'], visibility: :public, spoiler_text: p['spoiler_text'].to_s, process_mentions: true)
    FanOutOnWriteService.new.call(status)
    ids[p['key']] = sid(status)
  rescue StandardError => e
    errors[p['key']] = "#{e.class}: #{e.message} #{e.backtrace&.first(3)&.join(' | ')}"
  end
end

emit(ids: ids, errors: errors)
