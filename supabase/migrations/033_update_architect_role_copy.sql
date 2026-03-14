UPDATE roles
SET
  description = CASE
    WHEN id = 'architect' THEN 'System self-improvement. Owns system modifications.'
    ELSE description
  END,
  policy_doc = CASE
    WHEN id = 'architect' THEN replace(
      replace(
        replace(
          policy_doc,
          'Approve and direct system-level changes.',
          'Own and direct system-level changes.'
        ),
        'Approve the system modification.',
        'Own the system modification decision and route the implementation.'
      ),
      'You are the only role that approves system modifications.',
      'You are the role that owns system modification decisions.'
    )
    ELSE policy_doc
  END
WHERE id = 'architect';
