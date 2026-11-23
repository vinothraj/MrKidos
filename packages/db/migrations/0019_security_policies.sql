-- 0019 Community security settings, as data.
--
-- Security settings are community policies (the existing, typed, audited `policy_definitions` / `community_policies`
-- mechanism), grouped under a new `category` so the app can show them on their own screen with a confirm step.
-- The API enforces each one:
--   require_two_step_all_members  guards.ts: anyone acting in the community must have two-step verification set up
--                                 and used for this session (like a role that requires it).
--   invite_code_max_days          membership.ts: a new invite code never lives longer than this.
-- Defaults keep today's behaviour, so nothing changes for a community until an administrator decides.
-- Session length and password rules are platform-wide (one account spans many communities), not community policies.

ALTER TABLE policy_definitions
  ADD COLUMN category text NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'security'));

INSERT INTO policy_definitions (key, label, description, value_type, allowed, default_value, sort_order, category) VALUES
  ('require_two_step_all_members', 'Everyone must use two-step verification',
   'When on, every member acting in this community, residents included, must set up two-step verification (an authenticator app) before they can continue. Administrators always need it.',
   'boolean', NULL, 'false', 110, 'security'),
  ('invite_code_max_days', 'Longest an invite code can last',
   'New invite codes stop working after this many days, even if the person creating one asks for longer. Codes that already exist keep their dates.',
   'enum', '["none", "7", "30", "90"]', '"none"', 120, 'security');
