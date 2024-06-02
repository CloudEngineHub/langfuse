-- traces
INSERT INTO langfuse.traces
SELECT toString(floor(randUniform(0, 4500000)))  AS id,
  now() - randUniform(0, 10000000) AS `timestamp`,
  concat('name', toString(rand() % 100)) AS `name`,
  concat('name', toString(rand() % 10000)) AS `user_id`,
  map('key', 'value') AS metadata,
  concat('release', toString(rand() % 10000)) AS `release`,
  concat('version', toString(rand() % 10000)) AS `version`,
  toString(floor(randExponential(1 / 2)) % 1000) AS project_id,
  if(rand() < 0.8, true, false) as public,
  if(rand() < 0.8, true, false) as bookmarked,
  array('tag1', 'tag2') as tags,
  'input' as input,
  'output' as output,
  concat('session', toString(rand() % 100)) AS `session_id`,
  now() - randUniform(0, 10000000) AS `created_at`,
  now() - randUniform(0, 10000000) AS `updated_at`,
  now() - randUniform(0, 10000000) AS `event_ts`,
  randUniform(0, 1000000) AS event_microseconds
FROM numbers(1000000);
-- observations
INSERT INTO langfuse.observations
SELECT toString(floor(randUniform(0, 4500000))) AS id,
  toString(floor(randUniform(0, 4500000)))  AS trace_id,
  floor(randExponential(1 / 2))  AS project_id,
  multiIf(
    rand() < 0.8,
    'SPAN',
    rand() < 0.95,
    'GENERATION',
    'EVENT'
  ) AS `type`,
  toString(rand()) AS `parent_observation_id`,
  now() - randUniform(0, 10000000) AS `created_at`,
  now() - randUniform(0, 10000000) AS `start_time`,
  addSeconds(start_time, floor(randExponential(1 / 10))) AS `end_time`,
  concat('name', toString(rand() % 100)) AS `name`,
  map('key', 'value') AS metadata,
  'level' AS `level`,
  'status_message' AS `status_message`,
  'version' AS `version`,
  repeat('input', toInt64(randExponential(1 / 100))) AS `input`,
  repeat('output', toInt64(randExponential(1 / 100))) AS `output`,
  if(
    number % 2 = 0,
    'claude-3-haiku-20240307',
    'gpt-4'
  ) as `model`,
  if(
    number % 2 = 0,
    'claude-3-haiku-20240307',
    'gpt-4'
  ) as `internal_model`,
  'model_parameters' AS `model_parameters`,
  toInt32(rand() % 1000) AS `prompt_tokens`,
  toInt32(rand() % 1000) AS `completion_tokens`,
  toInt32(rand() % 1000) AS `total_tokens`,
  'unit' AS `unit`,
  rand64() AS `input_cost`,
  rand64() AS `output_cost`,
  rand64() AS `total_cost`,
  addYears(now(), -1) AS `completion_start_time`,
  toString(rand()) AS `prompt_id`,
  now() AS event_ts,
  randUniform(0, 1000000) AS event_microseconds
FROM numbers(4500000);
-- scores
INSERT INTO langfuse.scores
SELECT toString(floor(randUniform(0, 500000))) AS id,
  now() - randUniform(0, 10000000) AS `timestamp`,
  toString(floor(randExponential(1 / 2)) % 1000) AS project_id,
  concat('name', toString(rand() % 100)) AS `name`,
  randUniform(0, 100) as `value`,
  toString(floor(randExponential(1 / 2)) % 1000) AS trace_id,
  'API' as source,
  if(
    rand() > 0.9,
    toString(floor(randUniform(0, 500000))),
    NULL
  ) AS observation_id,
  'comment' as comment,
  now() AS event_ts,
  randUniform(0, 1000000) AS event_microseconds
FROM numbers(1000000);