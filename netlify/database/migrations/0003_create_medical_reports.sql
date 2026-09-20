CREATE TABLE IF NOT EXISTS medical_reports (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  report_date date,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  blob_key text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_medical_reports_user ON medical_reports(user_id);
