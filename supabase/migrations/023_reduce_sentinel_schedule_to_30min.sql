UPDATE schedules
SET cron_expr = '*/30 * * * *'
WHERE name = 'sentinel-health-check'
  AND cron_expr = '*/5 * * * *';
