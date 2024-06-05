import z from "zod";
export const clickhouseStringDate = z
  .string()
  // clickhouse stores UTC like '2024-05-23 18:33:41.602000'
  // we need to convert it to '2024-05-23T18:33:41.602000Z'
  .transform((str) => str.replace(" ", "T") + "Z")
  .pipe(z.string().datetime());

export const observationRecord = z.object({
  id: z.string(),
  trace_id: z.string().nullable(),
  project_id: z.string(),
  type: z.string().nullable(),
  parent_observation_id: z.string().nullable(),
  created_at: clickhouseStringDate,
  start_time: clickhouseStringDate.nullable(),
  end_time: clickhouseStringDate.nullable(),
  name: z.string().nullable(),
  metadata: z.record(z.string()),
  level: z.string().nullable(),
  status_message: z.string().nullable(),
  version: z.string().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  model: z.string().nullable(),
  internal_model: z.string().nullable(),
  model_parameters: z.string().nullable(),
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
  unit: z.string().nullable(),
  input_cost: z.number().nullable(),
  output_cost: z.number().nullable(),
  total_cost: z.number().nullable(),
  completion_start_time: z.date().nullable(),
  prompt_id: z.string().nullable(),
});

export const traceRecord = z.object({
  id: z.string(),
  timestamp: clickhouseStringDate,
  name: z.string().nullable(),
  user_id: z.string().nullish(),
  metadata: z.record(z.string()),
  release: z.string().nullable(),
  version: z.string().nullable(),
  project_id: z.string(),
  public: z.boolean(),
  bookmarked: z.boolean(),
  tags: z.array(z.string()),
  input: z.string().nullable(),
  output: z.string().nullable(),
  session_id: z.string().nullable(),
  created_at: clickhouseStringDate,
});

export const scoreRecord = z.object({
  id: z.string(),
  timestamp: clickhouseStringDate,
  project_id: z.string(),
  name: z.string().nullable(),
  value: z.number().nullable(),
  source: z.string(),
  comment: z.string().nullable(),
  trace_id: z.string(),
  observation_id: z.string().nullable(),
});
