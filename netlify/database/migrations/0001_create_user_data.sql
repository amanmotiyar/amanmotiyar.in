-- One row per signed-in user. `data` holds their entire tracker state
-- (the same JSON your Export button already produces) as a single JSONB
-- column, keyed by their Netlify Identity user id.
CREATE TABLE IF NOT EXISTS user_data (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
