ALTER TABLE schedules
ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

UPDATE schedules
SET timezone = COALESCE(NULLIF(timezone, ''), 'UTC')
WHERE timezone IS NULL OR timezone = '';
