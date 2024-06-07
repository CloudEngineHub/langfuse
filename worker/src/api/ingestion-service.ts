import {
  ObservationEvent,
  clickhouseClient,
  eventTypes,
  ingestionBatchEvent,
  observationRecordInsert,
  observationRecordRead,
  scoreEvent,
  traceEvent,
  traceRecordInsert,
  traceRecordRead,
} from "@langfuse/shared/backend";
import z from "zod";
import { instrumentAsync } from "../instrumentation";
import {
  JsonNested,
  convertRecordToJsonSchema,
  env,
  mergeJson,
} from "@langfuse/shared";
import { redis } from "../redis/redis";
import { v4 } from "uuid";

export const processEvents = async (
  events: z.infer<typeof ingestionBatchEvent>
) => {
  // first order events
  console.log(`Processing events ${JSON.stringify(events)}`);

  const observationEvents: ObservationEvent[] = [];
  const traceEvents: z.infer<typeof traceEvent>[] = [];
  const scoreEvents: z.infer<typeof scoreEvent>[] = [];

  events.forEach((event) => {
    switch (event.type) {
      case eventTypes.TRACE_CREATE:
        traceEvents.push(event);
        break;
      case eventTypes.OBSERVATION_CREATE:
      case eventTypes.OBSERVATION_UPDATE:
      case eventTypes.EVENT_CREATE:
      case eventTypes.SPAN_CREATE:
      case eventTypes.SPAN_UPDATE:
      case eventTypes.GENERATION_CREATE:
      case eventTypes.GENERATION_UPDATE:
        observationEvents.push(event);
        break;
      case eventTypes.SCORE_CREATE: {
        scoreEvents.push(event);
        break;
      }
      case eventTypes.SDK_LOG:
        break;
    }
  });

  // then process all of them per table in batches in parallel
  await Promise.all([
    storeObservations(
      "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a",
      observationEvents
    ),
    storeTraces("7a88fb47-b4e2-43b8-a06c-a5ce950dc53a", traceEvents),
    storeScores("7a88fb47-b4e2-43b8-a06c-a5ce950dc53a", scoreEvents),
  ]);
};

const storeScores = async (
  projectId: string,
  scores: z.infer<typeof scoreEvent>[]
) => {
  const insert = scores.map((score) => ({
    id: score.body.id ?? v4(),
    timestamp: new Date(score.timestamp).getTime() * 1000,
    name: score.body.name,
    value: score.body.value,
    source: "API",
    comment: score.body.comment,
    trace_id: score.body.traceId,
    observation_id: score.body.observationId ?? null,
    project_id: projectId,
  }));

  console.log(`Inserting score into clickhouse ${JSON.stringify(insert)}`);
  if (insert.length === 0) {
    return;
  }
  await clickhouseClient.insert({
    table: "scores",
    format: "JSONEachRow",
    values: insert,
  });
};

const storeTraces = async (
  projectId: string,
  traces: z.infer<typeof traceEvent>[]
) => {
  console.log(`Storing traces ${JSON.stringify(traces)}`);
  const insert = convertEventToRecord(traces, projectId);

  console.log(
    `Inserting trace into clickhouse, ${env.CLICKHOUSE_URL} ${JSON.stringify(insert)}`
  );

  const dedupedSdkRecords = z
    .array(traceRecordInsert)
    .parse(dedupeAndOverwriteObjectById(insert));

  console.log(`deduped traces ${JSON.stringify(dedupedSdkRecords)}`);

  const redisTraces = z
    .array(traceRecordInsert.nullish())
    .parse(
      dedupedSdkRecords.length > 0
        ? await redis?.mget(
            ...dedupedSdkRecords.map((m) => `trace:${m.id}-${projectId}`)
          )
        : [
            await redis?.get(
              dedupedSdkRecords.map((m) => `trace:${m.id}-${projectId}`)[0]
            ),
          ]
    )
    .filter((item): item is z.infer<typeof traceRecordInsert> => !!item);

  const nonRedisTraces = dedupedSdkRecords.filter((record) =>
    redisTraces.find((r) => r && r.id === record.id)
  );

  const chTraces =
    nonRedisTraces.length > 0
      ? await instrumentAsync({ name: "get-traces" }, async () => {
          const clickhouseTraces = await clickhouseClient.query({
            query: `SELECT id FROM traces where project_id = '${projectId}' and id in (${nonRedisTraces.map((obs) => `'${obs.id}'`).join(",")})`,
            format: "JSONEachRow",
          });
          return z.array(traceRecordRead).parse(await clickhouseTraces.json());
        })
      : [];
  console.log(`clickhouse traces ${JSON.stringify(chTraces)}`);

  const retrievedTraces = [...chTraces, ...redisTraces.filter(Boolean)];

  const newRecords = dedupedSdkRecords.map((record) => {
    const existingRecord = retrievedTraces.find(
      (r) => r !== undefined && r.id === record.id
    );
    if (!existingRecord) {
      return record;
    }
    // if the record exists, we need to update the existing record with the new record
    return overwriteObject(existingRecord, record);
  });

  if (newRecords.length === 0) {
    return;
  }

  await redis
    ?.pipeline(
      newRecords.map((record) => [
        "setex",
        `trace:${record.id}-${projectId}`,
        120,
        JSON.stringify(record),
      ])
    )
    .exec();

  await clickhouseClient.insert({
    table: "traces",
    format: "JSONEachRow",
    values: newRecords,
  });
};

const storeObservations = async (
  projectId: string,
  observations: ObservationEvent[]
) => {
  const insert = convertEventToObservation(observations, projectId);

  console.log(
    `Received observation for clickhouse, ${env.CLICKHOUSE_URL}, ${JSON.stringify(insert)}`
  );
  // merge observations with same id and project id into one
  const dedupedSdkEvents = z
    .array(observationRecordInsert)
    .parse(dedupeAndOverwriteObjectById(insert));

  console.log(`merged obs ${JSON.stringify(dedupedSdkEvents)}`);

  const redisObservations = (
    await getCurrentObservationStateFromRedis(
      dedupedSdkEvents.map((m) => m.id),
      projectId
    )
  ).filter(Boolean);

  const observationsNotInRedis = dedupedSdkEvents.filter((record) =>
    redisObservations.find((r) => r !== undefined && r.id === record.id)
  );

  const clickHouseObservations =
    observationsNotInRedis.length > 0
      ? await instrumentAsync(
          { name: "get-observations-clickhouse" },
          async () => {
            const response = await clickhouseClient.query({
              query: `SELECT * FROM observations where project_id = '${projectId}' and id in (${observationsNotInRedis.map((obs) => `'${obs.id}'`).join(",")})`,
              format: "JSONEachRow",
            });
            return z.array(observationRecordRead).parse(await response.json());
          }
        )
      : [];

  const existingObservations = [
    ...clickHouseObservations.filter(Boolean),
    ...redisObservations.filter(Boolean),
  ];

  console.log(
    `existing clickhouse obs: ${JSON.stringify(clickHouseObservations)}`
  );
  console.log(`existing redis obs: ${JSON.stringify(redisObservations)}`);

  const newRecords = dedupedSdkEvents.map((newRecord) => {
    const existingRecord = existingObservations.find(
      (r) => r !== undefined && r.id === newRecord.id
    );
    if (!existingRecord) {
      return newRecord;
    }
    // if the record exists, we need to update the existing record with the new record
    return overwriteObject(existingRecord, newRecord);
  });

  console.log(
    `final records obs, ${env.CLICKHOUSE_URL}, ${JSON.stringify(newRecords)}`
  );

  if (newRecords.length === 0) {
    return;
  }

  await redis
    ?.pipeline(
      newRecords.map((record) => [
        "setex",
        `observation:${record.id}-${projectId}`,
        120,
        JSON.stringify(record),
      ])
    )
    .exec();

  return await clickhouseClient.insert({
    table: "observations",
    format: "JSONEachRow",
    values: newRecords,
  });
};

export const convertJsonSchemaToRecord = (
  jsonSchema: JsonNested
): Record<string, string> => {
  const record: Record<string, string> = {};

  // if it's a literal, return the value with "metadata" prefix
  if (typeof jsonSchema === "string" || typeof jsonSchema === "number") {
    record["metadata"] = jsonSchema.toString();
    return record;
  }

  // if it's an array, add the stringified array with "metadata" prefix
  if (Array.isArray(jsonSchema)) {
    record["metadata"] = JSON.stringify(jsonSchema);
    return record;
  }

  // if it's an object, add each key value pair with a stringified value
  if (typeof jsonSchema === "object") {
    for (const key in jsonSchema) {
      record[key] = JSON.stringify(jsonSchema[key]);
    }
  }
  return record;
};

export const mergeRecords = (
  record1?: Record<string, string>,
  record2?: Record<string, string>
): Record<string, string> | undefined => {
  const merged = mergeJson(
    record1 ? convertRecordToJsonSchema(record1) ?? undefined : undefined,
    record2 ? convertRecordToJsonSchema(record2) ?? undefined : undefined
  );

  return merged ? convertJsonSchemaToRecord(merged) : undefined;
};

function convertEventToRecord(
  traces: z.infer<typeof traceEvent>[],
  projectId: string
) {
  return traces.map((trace) =>
    traceRecordInsert.parse({
      id: trace.body.id ?? v4(),
      // in the default implementation, we set timestamps server side if not provided.
      // we need to insert timestamps here and change the SDKs to send timestamps client side.
      timestamp: trace.body.timestamp
        ? new Date(trace.body.timestamp).getTime()
        : Date.now(),
      name: trace.body.name,
      user_id: trace.body.userId,
      metadata: trace.body.metadata
        ? convertJsonSchemaToRecord(trace.body.metadata)
        : undefined,
      release: trace.body.release,
      version: trace.body.version,
      project_id: projectId,
      public: trace.body.public,
      bookmarked: false,
      tags: trace.body.tags ?? [],
      input: trace.body.input,
      output: trace.body.output,
      session_id: trace.body.sessionId,
      updated_at: Date.now() * 1000,
      created_at: Date.now() * 1000,
    })
  );
}

async function getCurrentObservationStateFromRedis(
  ids: string[],
  projectId: string
) {
  const keys = ids.map((id) => `observation:${id}-${projectId}`);

  const redisObjects = await redis?.mget(...keys);
  const redisObservations =
    redisObjects?.map((redisObject) =>
      redisObject ? JSON.parse(redisObject) : undefined
    ) ?? [];
  return z
    .array(observationRecordInsert.nullish())
    .parse(redisObservations)
    .filter((item): item is z.infer<typeof observationRecordInsert> => !!item);
}

function convertEventToObservation(
  observationsToStore: ObservationEvent[],
  projectId: string
) {
  return observationsToStore.map((obs) => {
    let type: "EVENT" | "SPAN" | "GENERATION";
    switch (obs.type) {
      case eventTypes.OBSERVATION_CREATE:
      case eventTypes.OBSERVATION_UPDATE:
        type = obs.body.type;
        break;
      case eventTypes.EVENT_CREATE:
        type = "EVENT" as const;
        break;
      case eventTypes.SPAN_CREATE:
      case eventTypes.SPAN_UPDATE:
        type = "SPAN" as const;
        break;
      case eventTypes.GENERATION_CREATE:
      case eventTypes.GENERATION_UPDATE:
        type = "GENERATION" as const;
        break;
    }

    // metadata needs to be converted to a record<string, string>.
    // prefix all keys with "metadata." if they are an array or primitive
    const convertedMetadata: Record<string, string> = {};

    if (typeof obs.body.metadata === "string") {
      convertedMetadata["metadata"] = obs.body.metadata;
    }

    const newInputCount =
      "usage" in obs.body ? obs.body.usage?.input : undefined;

    const newOutputCount =
      "usage" in obs.body ? obs.body.usage?.output : undefined;

    const newTotalCount =
      newInputCount !== undefined &&
      newOutputCount !== undefined &&
      newInputCount &&
      newOutputCount
        ? newInputCount + newOutputCount
        : newInputCount ?? newOutputCount;

    const newUnit = "usage" in obs.body ? obs.body.usage?.unit : undefined;

    return observationRecordInsert.parse({
      id: obs.body.id ?? v4(),
      trace_id: obs.body.traceId ?? v4(),
      type: type,
      name: obs.body.name,
      start_time: obs.body.startTime
        ? new Date(obs.body.startTime).getTime() * 1000
        : undefined,
      end_time:
        "endTime" in obs.body && obs.body.endTime
          ? new Date(obs.body.endTime).getTime() * 1000
          : undefined,
      completion_start_time:
        "completionStartTime" in obs.body && obs.body.completionStartTime
          ? new Date(obs.body.completionStartTime).getTime() * 1000
          : undefined,
      metadata: obs.body.metadata
        ? convertJsonSchemaToRecord(obs.body.metadata)
        : undefined,
      model: "model" in obs.body ? obs.body.model : undefined,
      model_parameters:
        "modelParameters" in obs.body
          ? obs.body.modelParameters ?? undefined
          : undefined,
      input: obs.body.input ?? undefined,
      output: obs.body.output ?? undefined,
      promptTokens: newInputCount,
      completionTokens: newOutputCount,
      totalTokens: newTotalCount,
      unit: newUnit,
      level: obs.body.level ?? "DEFAULT",
      status_message: obs.body.statusMessage ?? undefined,
      parent_observation_id: obs.body.parentObservationId ?? undefined,
      version: obs.body.version ?? undefined,
      project_id: projectId,
      // todo: find prompt from postgres
      prompt_id: undefined,
      input_cost: "usage" in obs.body ? obs.body.usage?.inputCost : undefined,
      output_cost: "usage" in obs.body ? obs.body.usage?.outputCost : undefined,
      total_cost: "usage" in obs.body ? obs.body.usage?.totalCost : undefined,
    });
  });
}

function dedupeAndOverwriteObjectById(
  insert: {
    id: string;
    project_id: string;
    [key: string]: any;
  }[]
) {
  return insert.reduce(
    (acc, curr) => {
      const existing = acc.find(
        (o) => o.id === curr.id && o.project_id === curr.project_id
      );
      if (existing) {
        return acc.map((o) =>
          o.id === curr.id ? overwriteObject(o, curr) : o
        );
      }
      return [...acc, curr];
    },
    [] as typeof insert
  );
}

function overwriteObject(
  a: {
    id: string;
    project_id: string;
    [key: string]: any;
  },
  b: {
    id: string;
    project_id: string;
    [key: string]: any;
  }
) {
  return {
    ...a,
    ...Object.entries(b).reduce(
      (acc, [k, v]) => (v == null ? acc : { ...acc, [k]: v }),
      {}
    ),
    metadata:
      !a.metadata && b.metadata
        ? b.metadata
        : !b.metadata && a.metadata
          ? a.metadata
          : mergeRecords(a.metadata, b.metadata),
  };
}
