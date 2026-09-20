ALTER TABLE user_data
  ADD COLUMN IF NOT EXISTS force_logout_at timestamptz;
