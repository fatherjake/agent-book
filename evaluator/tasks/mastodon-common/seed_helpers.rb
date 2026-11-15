# frozen_string_literal: true
#
# Evaluator-owned seeding helpers (HIDDEN). Loaded by the task seed/probe scripts that run with
# `bin/rails runner` in the development environment of the evaluated tree. Only uses models and
# services that exist at both checkpoints (Mastodon 2.4.2 and 3.0.x), never the feature under test.
require 'json'
require 'sidekiq/testing'

module FrugalSeed
  PASSWORD = 'frugal-eval-pass-1234'
  APP_NAME = 'frugal-eval'

  module_function

  def args
    @args ||= JSON.parse(ENV['FRUGAL_ARGS'] || '{}')
  end

  # Single-line marker the evaluator parses (the last one wins).
  def emit(obj)
    $stdout.puts "FRUGAL_JSON:#{JSON.generate(obj)}"
    $stdout.flush
  end

  # Run Sidekiq jobs inline so fan-out and notifications happen synchronously.
  def inline!
    Sidekiq::Testing.inline!
  end

  def user!(username, display_name: nil)
    email = "#{username}@frugal.test"
    existing = User.find_by(email: email)
    return existing if existing

    attrs = {
      email: email,
      password: PASSWORD,
      password_confirmation: PASSWORD,
      confirmed_at: Time.now.utc,
      locale: 'en',
      account: Account.new(username: username, display_name: display_name || username.capitalize),
    }
    # `validates :agreement, acceptance: true` defines its attribute lazily (Rails 5.2), so
    # method_defined? is false until first use; check the validators instead.
    attrs[:agreement] = true if User.method_defined?(:agreement=) || User.validators_on(:agreement).any?
    attrs[:approved] = true if User.column_names.include?('approved')
    user = User.new(attrs)
    user.skip_confirmation! if user.respond_to?(:skip_confirmation!)
    user.save!
    # Mark the user as recently active, so neither a web sign-in nor API use triggers a home feed
    # regeneration (which would make the home timeline answer 206 for a while).
    now = Time.now.utc
    user.update_columns(current_sign_in_at: now, last_sign_in_at: now)
    # Skip the web UI's first-run modals (introduction in 3.x, onboarding in 2.x).
    setting = Web::Setting.where(user: user).first_or_initialize
    setting.data = { 'introductionVersion' => 20_181_216_044_202, 'onboarded' => true }
    setting.save!
    user
  end

  def app!
    Doorkeeper::Application.where(name: APP_NAME).first_or_create!(
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: 'read write follow'
    )
  end

  # Access tokens are created directly (scope strings are not validated on tokens), so tokens with
  # scopes the checkpoint doesn't know yet can be issued.
  def token!(user, scopes)
    t = Doorkeeper::AccessToken.create!(application: app!, resource_owner_id: user.id, scopes: scopes)
    t.respond_to?(:plaintext_token) && t.plaintext_token ? t.plaintext_token : t.token
  end

  # Creates a local status without going through PostStatusService (its signature differs between
  # versions). Mentions are processed so direct statuses are visible to the mentioned accounts.
  def status!(account, text, visibility: :public, spoiler_text: '', reply_to: nil, process_mentions: true)
    attrs = { account: account, text: text, visibility: visibility, spoiler_text: spoiler_text }
    if reply_to
      attrs[:thread] = reply_to
    end
    status = Status.create!(attrs)
    ProcessMentionsService.new.call(status) if process_mentions && text.include?('@')
    status
  end

  def boost!(account, status)
    Status.create!(account: account, reblog: status, visibility: :public)
  end

  def push_home!(account, status)
    FeedManager.instance.push_to_home(account, status)
  end

  def follow!(a, b)
    a.follow!(b) unless a.following?(b)
  end

  def sid(status)
    status.id.to_s
  end
end
