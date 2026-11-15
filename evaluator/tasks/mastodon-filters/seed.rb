# frozen_string_literal: true
#
# HIDDEN seed for mastodon-filters checks (bin/rails runner, development DB). Checkpoint models only.
require File.join(ENV.fetch('FRUGAL_EVAL_DIR', '/tmp/frugal-eval'), 'seed_helpers.rb')
include FrugalSeed

alice = user!('alice') # API user
bob   = user!('bob')   # followed by alice and uma
dave  = user!('dave')  # second user for isolation checks
uma   = user!('uma')   # UI user

follow!(alice.account, bob.account)
follow!(uma.account, bob.account)

ui = {}
ui['fruit']   = status!(bob.account, 'Bob: fresh Kiwi smoothies at the market today', visibility: :public)
ui['bus']     = status!(bob.account, 'Bob: the number nine bus was late again', visibility: :public)
ui['neutral'] = status!(bob.account, 'Bob: the library opens at nine on Sundays', visibility: :public)
[ui['neutral'], ui['bus'], ui['fruit']].each { |st| push_home!(uma.account, st) }

emit(
  password: FrugalSeed::PASSWORD,
  users: {
    alice: { id: alice.account.id.to_s, email: alice.email },
    bob: { id: bob.account.id.to_s, email: bob.email },
    dave: { id: dave.account.id.to_s, email: dave.email },
    uma: { id: uma.account.id.to_s, email: uma.email },
  },
  ui: ui.transform_values { |st| { id: sid(st), text: st.text } },
  tokens: {
    alice_full: token!(alice, 'read write follow'),
    alice_read: token!(alice, 'read'),
    alice_write: token!(alice, 'write'),
    dave_full: token!(dave, 'read write follow'),
    uma_full: token!(uma, 'read write follow'),
  }
)
