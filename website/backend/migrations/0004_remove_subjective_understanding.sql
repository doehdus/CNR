-- Understanding is measured by keyword accuracy. Remove only the retired rating.
UPDATE study_state
SET payload = json_set(payload, '$.ratings', json((
    SELECT json_group_array(json_remove(value, '$.understanding', '$.legacy_understanding'))
    FROM json_each(study_state.payload, '$.ratings')
  ))),
  revision = revision + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM json_each(payload, '$.ratings')
  WHERE json_type(value, '$.understanding') IS NOT NULL
     OR json_type(value, '$.legacy_understanding') IS NOT NULL
) OR EXISTS (
  SELECT 1 FROM survey_responses
  WHERE json_type(rating, '$.understanding') IS NOT NULL
     OR json_type(rating, '$.legacy_understanding') IS NOT NULL
);
--> statement-breakpoint
UPDATE survey_responses
SET rating = json_remove(rating, '$.understanding', '$.legacy_understanding')
WHERE json_type(rating, '$.understanding') IS NOT NULL
   OR json_type(rating, '$.legacy_understanding') IS NOT NULL;
