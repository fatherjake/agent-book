# frozen_string_literal: true
#
# HIDDEN seed for mastodon-bookmarks checks (bin/rails runner, development DB).
# Uses only checkpoint models; writes everything the checks need as one FRUGAL_JSON line.
require File.join(ENV.fetch('FRUGAL_EVAL_DIR', '/tmp/frugal-eval'), 'seed_helpers.rb')
include FrugalSeed

alice = user!('alice')   # main API user
bob   = user!('bob')     # followed by alice and uma
carol = user!('carol')   # NOT followed by alice
dave  = user!('dave')    # second user for privacy checks
uma   = user!('uma')     # UI user (follows bob)

follow!(alice.account, bob.account)
follow!(uma.account, bob.account)
follow!(dave.account, bob.account)

s = {}
# Visibility matrix (author → what alice may see).
s['bob_public']        = status!(bob.account, 'Bob public: the lighthouse keeper logbook', visibility: :public)
s['bob_unlisted']      = status!(bob.account, 'Bob unlisted: notes about tide tables', visibility: :unlisted)
s['bob_private']       = status!(bob.account, 'Bob followers-only: harbour gossip', visibility: :private)
s['bob_direct_alice']  = status!(bob.account, '@alice Bob direct: the spare key is under the mat', visibility: :direct)
s['carol_public']      = status!(carol.account, 'Carol public: a recipe for fish soup', visibility: :public)
s['carol_private']     = status!(carol.account, 'Carol followers-only: secret garden plans', visibility: :private)
s['carol_direct_dave'] = status!(carol.account, '@dave Carol direct: just between us', visibility: :direct)
s['alice_private']     = status!(alice.account, 'Alice followers-only: my own reminder', visibility: :private)
s['carol_boosted']     = status!(carol.account, 'Carol public: boosted by bob', visibility: :public)
s['bob_boost_carol']   = boost!(bob.account, s['carol_boosted'])

# Statuses dedicated to single checks, so checks don't interfere with each other.
s['idem']        = status!(bob.account, 'Bob public: idempotency target', visibility: :public)
s['unbm']        = status!(bob.account, 'Bob public: unbookmark target', visibility: :public)
s['never']       = status!(bob.account, 'Bob public: never bookmarked', visibility: :public)
s['privacy']     = status!(bob.account, 'Bob public: bookmarked by dave only', visibility: :public)
s['scope']       = status!(bob.account, 'Bob public: scope target', visibility: :public)
s['flag']        = status!(bob.account, 'Bob public: bookmarked flag in timelines', visibility: :public)
s['delete_me']   = status!(bob.account, 'Bob public: will be deleted after bookmarking', visibility: :public)
s['export']      = status!(bob.account, 'Bob public: exported in the archive', visibility: :public)
pages = (1..7).map { |i| status!(bob.account, "Bob public: pagination item #{i}", visibility: :public) }

# Home feed for alice (flag check reads it) and for uma (UI checks).
ui = {}
ui['toggle'] = status!(bob.account, 'Bob public: a kingfisher dives at dawn (ui-toggle)', visibility: :public)
ui['column'] = status!(bob.account, 'Bob public: notes on the old stone bridge (ui-column)', visibility: :public)
ui['detail'] = status!(bob.account, 'Bob public: the quiet museum at noon (ui-detail)', visibility: :public)
[s['flag'], ui['toggle'], ui['column'], ui['detail']].each do |st|
  push_home!(alice.account, st)
  push_home!(uma.account, st)
end

tokens = {
  alice_full: token!(alice, 'read write follow'),
  alice_read: token!(alice, 'read'),
  alice_write: token!(alice, 'write'),
  alice_read_bookmarks: token!(alice, 'read:bookmarks'),
  alice_write_bookmarks: token!(alice, 'write:bookmarks'),
  alice_read_favourites: token!(alice, 'read:favourites'),
  alice_write_favourites: token!(alice, 'write:favourites'),
  dave_full: token!(dave, 'read write follow'),
  carol_full: token!(carol, 'read write follow'),
  uma_full: token!(uma, 'read write follow'),
  # Pagination uses its own user so its list contains exactly the pagination statuses.
}
pager = user!('pat')
follow!(pager.account, bob.account)
tokens[:pat_full] = token!(pager, 'read write follow')

emit(
  password: FrugalSeed::PASSWORD,
  users: {
    alice: { id: alice.account.id.to_s, email: alice.email },
    bob: { id: bob.account.id.to_s, email: bob.email },
    carol: { id: carol.account.id.to_s, email: carol.email },
    dave: { id: dave.account.id.to_s, email: dave.email },
    uma: { id: uma.account.id.to_s, email: uma.email },
    pat: { id: pager.account.id.to_s, email: pager.email },
  },
  statuses: s.transform_values { |st| sid(st) },
  originals: { bob_boost_carol: sid(s['carol_boosted']) },
  status_uris: { export: ActivityPub::TagManager.instance.uri_for(s['export']) },
  pages: pages.map { |st| sid(st) },
  ui: ui.transform_values { |st| { id: sid(st), text: st.text } },
  tokens: tokens
)
