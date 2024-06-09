import {
  ObservationEvent,
  clickhouseClient,
  convertObservationReadToInsert,
  convertScoreReadToInsert,
  convertTraceReadToInsert,
  eventTypes,
  findModel,
  ingestionBatchEvent,
  observationRecordInsert,
  observationRecordRead,
  scoreEvent,
  scoreRecordInsert,
  scoreRecordRead,
  traceEvent,
  traceRecordInsert,
  traceRecordRead,
  tokenCount,
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
import _ from "lodash";
import { prisma } from "@langfuse/shared/src/db";

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
  if (scores.length === 0) {
    return;
  }

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

  const newRecords = await getDedupedAndUpdatedRecords(
    insert,
    projectId,
    "scores",
    scoreRecordInsert,
    scoreRecordRead
  );

  if (newRecords.length === 0) {
    return;
  }

  await insertFinalRecords(projectId, "scores", newRecords);
};

const storeTraces = async (
  projectId: string,
  traces: z.infer<typeof traceEvent>[]
) => {
  console.log(`Storing traces ${JSON.stringify(traces)}`);
  if (traces.length === 0) {
    return;
  }
  const insert = convertEventToRecord(traces, projectId);

  console.log(
    `Inserting trace into clickhouse, ${env.CLICKHOUSE_URL} ${JSON.stringify(insert)}`
  );

  const newRecords = await getDedupedAndUpdatedRecords(
    insert,
    projectId,
    "traces",
    traceRecordInsert,
    traceRecordRead
  );

  if (newRecords.length === 0) {
    return;
  }

  console.log(`Inserting trace into clickhouse ${JSON.stringify(newRecords)}`);

  await insertFinalRecords(projectId, "traces", newRecords);
};

const storeObservations = async (
  projectId: string,
  observations: ObservationEvent[]
) => {
  if (observations.length === 0) {
    return;
  }
  const observationMap = await findPrompt(projectId, observations);
  console.log("observation map ", JSON.stringify(observationMap));
  const insert = convertEventToObservation(
    observations,
    projectId,
    observationMap
  );

  console.log(`hehe check: ${JSON.stringify(insert)}`);

  // merge observations with same id and project id into one
  const newRecords = await getDedupedAndUpdatedRecords(
    insert,
    projectId,
    "observations",
    observationRecordInsert,
    observationRecordRead
  );

  if (newRecords.length === 0) {
    return;
  }

  // model match of observations

  const modelMatchedRecords = await modelMatch(newRecords);

  return await insertFinalRecords(
    projectId,
    "observations",
    modelMatchedRecords
  );
};

export const findPrompt = async (
  projectId: string,
  events: ObservationEvent[]
) => {
  const observationMap = new Map<string, string>(); // contains prompt id for each matching observation
  // find all unique combinations of prompt names + versions alongside all observations
  console.log(`events to find prompts ${JSON.stringify(events)}`);
  const uniquePrompts = events.reduce<{
    [key: string]: ObservationEvent[];
  }>((acc, event) => {
    if (
      "promptName" in event.body &&
      typeof event.body.promptName === "string" &&
      "promptVersion" in event.body &&
      typeof event.body.promptVersion === "number"
    ) {
      const key = `${event.body.promptName}-${event.body.promptVersion}`;
      console.log(`key ${key}`);
      acc[key] = acc[key] ?? [];
      acc[key]?.push(event);
      console.log(`acc ${JSON.stringify(acc)}`);
      return acc;
    }
    return acc;
  }, {});

  console.log(`uniquePrompts ${JSON.stringify(uniquePrompts)}`);

  // for all unique prompts, find the prompt in the database

  const prompts = await prisma.prompt.findMany({
    where: {
      projectId,
      name: {
        in: Object.keys(uniquePrompts).map((key) => key.split("-")[0]),
      },
      version: {
        in: Object.keys(uniquePrompts).map((key) =>
          parseInt(key.split("-")[1])
        ),
      },
    },
  });

  // assign prompt id to all observations
  for (const [key, observationsGroup] of Object.entries(uniquePrompts)) {
    const prompt = prompts.find(
      (prompt) =>
        prompt.name === key.split("-")[0] &&
        prompt.version === parseInt(key.split("-")[1])
    );

    if (!prompt) {
      continue;
    }

    for (const observation of observationsGroup) {
      if (!observation.body.id) {
        continue;
      }
      observationMap.set(observation.body.id, prompt.id);
    }
  }
  return observationMap;
};

export const modelMatch = async (
  observations: z.infer<typeof observationRecordInsert>[]
) => {
  const groupedGenerations = observations.reduce<{
    [key: string]: z.infer<typeof observationRecordInsert>[];
  }>((acc, observation) => {
    const config = {
      model: observation.model,
      unit: observation.unit,
      projectId: observation.project_id,
    };

    const key = JSON.stringify(config);

    acc[key] = acc[key] ?? [];
    acc[key]?.push(observation);

    return acc;
  }, {});

  for (const [key, observationsGroup] of Object.entries(groupedGenerations)) {
    const { model, unit, projectId } = JSON.parse(key) as {
      model: string;
      unit: string;
      projectId: string;
    };

    if (!projectId) {
      throw new Error("No project id");
    }

    if (!model) {
      continue;
    }

    console.log(`Execute key: ${model} ${unit} ${projectId}`);

    if (!projectId) {
      throw new Error("No project id");
    }

    const foundModel = await findModel({
      event: { projectId, model, unit },
    });

    console.log(
      `Found model: ${foundModel?.id} for key: ${key} with observations: ${observationsGroup.length}`
    );

    if (foundModel) {
      observationsGroup.map((observation) => {
        let updatedObservation = observation;
        if (
          !observation.input_usage &&
          !observation.output_usage &&
          !observation.total_usage
        ) {
          const newInputCount = tokenCount({
            model: foundModel,
            text: observation.input,
          });
          const newOutputCount = tokenCount({
            model: foundModel,
            text: observation.output,
          });
          const newTotalCount = newInputCount + newOutputCount;
          updatedObservation = {
            ...observation,
            input_usage: newInputCount,
            output_usage: newOutputCount,
            total_usage: newTotalCount,
          };
        }

        if (
          updatedObservation.input_cost ||
          updatedObservation.output_cost ||
          updatedObservation.total_cost
        ) {
          return {
            ...updatedObservation,
          };
        }
        return {
          ...updatedObservation,
          model_id: foundModel.id,
          input_cost:
            foundModel.inputPrice ?? 0 * (updatedObservation.input_cost ?? 0),
          output_cost:
            foundModel.outputPrice ?? 0 * (updatedObservation.output_cost ?? 0),
          total_cost:
            foundModel.totalPrice ?? 0 * (updatedObservation.total_cost ?? 0),
        };
      });
    }
  }

  // return a list of all groupedGenerations values, without the keys
  return Object.values(groupedGenerations).flat();
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

async function insertFinalRecords<T extends { id: string; project_id: string }>(
  projectId: string,
  recordType: "traces" | "scores" | "observations",
  insert: T[]
) {
  console.log(
    `Inserting final records ${recordType} ${JSON.stringify(insert)}`
  );
  await redis
    ?.pipeline(
      insert.map((record) => [
        "setex",
        `${recordType}:${record.id}-${projectId}`,
        120,
        JSON.stringify(record),
      ])
    )
    .exec();

  await clickhouseClient.insert({
    table: recordType,
    format: "JSONEachRow",
    values: insert,
  });
}

async function getDedupedAndUpdatedRecords<
  T extends { id: string; project_id: string },
>(
  insert: T[],
  projectId: string,
  recordType: "traces" | "scores" | "observations",
  recordInsert: z.ZodType<any, any>,
  recordRead: z.ZodType<any, any>
) {
  const nonOverwritableProperties = {
    traces: ["id", "project_id", "name", "timestamp", "created_at"],
    scores: ["id", "project_id", "timestamp", "type", "trace_id", "created_at"],
    observations: ["id", "project_id", "trace_id", "timestamp", "created_at"],
  };
  const dedupedSdkRecords = z
    .array(recordInsert)
    .parse(
      dedupeAndOverwriteObjectById(
        insert,
        nonOverwritableProperties[recordType]
      )
    );

  console.log(`deduped ${recordType} ${JSON.stringify(dedupedSdkRecords)}`);

  const redisRecords = await getCurrentStateFromRedis(
    dedupedSdkRecords.map((m) => m.id),
    projectId,
    recordInsert,
    recordType
  );
  console.log(`redis ${recordType} ${JSON.stringify(redisRecords)}`);

  const nonRedisRecords = dedupedSdkRecords.filter(
    (record) => !redisRecords.find((r) => r && r.id === record.id)
  );

  console.log(
    `nonRedis, needs to be found in CH ${recordType} ${JSON.stringify(nonRedisRecords)}`
  );

  const chRecords =
    nonRedisRecords.length > 0
      ? await instrumentAsync({ name: `get-${recordType}` }, async () => {
          const clickhouseRecords = await clickhouseClient.query({
            query: `SELECT * FROM ${recordType} FINAL where project_id = '${projectId}' and id in (${nonRedisRecords.map((obs) => `'${obs.id}'`).join(",")})`,
            format: "JSONEachRow",
          });
          return z
            .array(recordRead)
            .parse(await clickhouseRecords.json())
            .map((record) => {
              // convert read into write format
              if (recordType === "traces") {
                return convertTraceReadToInsert(record);
              } else if (recordType === "scores") {
                return convertScoreReadToInsert(record);
              } else {
                return convertObservationReadToInsert(record);
              }
            });
        })
      : [];
  console.log(`clickhouse ${recordType} ${JSON.stringify(chRecords)}`);

  const retrievedRecords = [...chRecords, ...redisRecords.filter(Boolean)];

  const newRecords = dedupedSdkRecords.map((record) => {
    const existingRecord = retrievedRecords.find(
      (r) => r !== undefined && r.id === record.id
    );
    if (!existingRecord) {
      return record;
    }
    // if the record exists, we need to update the existing record with the new record
    return overwriteObject(
      existingRecord,
      record,
      nonOverwritableProperties[recordType]
    );
  });
  return newRecords;
}

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
        : {},
      release: trace.body.release,
      version: trace.body.version,
      project_id: projectId,
      public: trace.body.public ?? false,
      bookmarked: false,
      tags: trace.body.tags ?? [],
      input: trace.body.input?.toString(), // convert even json to string
      output: trace.body.output?.toString(),
      session_id: trace.body.sessionId,
      updated_at: Date.now() * 1000,
      created_at: Date.now() * 1000,
    })
  );
}

async function getCurrentStateFromRedis<T extends z.ZodType<any, any>>(
  ids: string[],
  projectId: string,
  record: T,
  recordType: "traces" | "scores" | "observations"
) {
  const keys = ids.map((id) => `${recordType}:${id}-${projectId}`);

  if (keys.length === 0) {
    return [];
  }

  const redisObjects =
    keys.length === 1
      ? [await redis?.get(keys[0])]
      : await redis?.mget(...keys);

  console.log(
    `redisObjects  ${recordType} ${keys} ${JSON.stringify(redisObjects)}`
  );

  const redisObservations =
    redisObjects?.map((redisObject) =>
      redisObject ? JSON.parse(redisObject) : undefined
    ) ?? [];

  return z
    .array(record.nullish())
    .parse(redisObservations)
    .filter((item): item is z.infer<typeof record> => !!item);
}

function convertEventToObservation(
  observationsToStore: ObservationEvent[],
  projectId: string,
  observationMap: Map<string, string>
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
        : new Date().getTime() * 1000,
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
        : {},
      model: "model" in obs.body ? obs.body.model : undefined,
      model_parameters:
        "modelParameters" in obs.body
          ? obs.body.modelParameters ?? undefined
          : undefined,
      input: obs.body.input?.toString() ?? undefined, // convert even json to string
      output: obs.body.output?.toString() ?? undefined,
      promptTokens: newInputCount,
      completionTokens: newOutputCount,
      totalTokens: newTotalCount,
      unit: newUnit,
      level: obs.body.level ?? "DEFAULT",
      status_message: obs.body.statusMessage ?? undefined,
      parent_observation_id: obs.body.parentObservationId ?? undefined,
      version: obs.body.version ?? undefined,
      project_id: projectId,
      input_cost: "usage" in obs.body ? obs.body.usage?.inputCost : undefined,
      output_cost: "usage" in obs.body ? obs.body.usage?.outputCost : undefined,
      total_cost: "usage" in obs.body ? obs.body.usage?.totalCost : undefined,
      prompt_id: obs.body.id ? observationMap.get(obs.body.id) : undefined,
      created_at: Date.now(),
    });
  });
}

function dedupeAndOverwriteObjectById(
  insert: {
    id: string;
    project_id: string;
    [key: string]: any;
  }[],
  nonOverwritableKeys: string[]
) {
  return insert.reduce(
    (acc, curr) => {
      const existing = acc.find(
        (o) => o.id === curr.id && o.project_id === curr.project_id
      );
      if (existing) {
        return acc.map((o) =>
          o.id === curr.id ? overwriteObject(o, curr, nonOverwritableKeys) : o
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
  },
  nonOverwritableKeys: string[]
) {
  console.log(`Overwriting ${JSON.stringify(a)} with ${JSON.stringify(b)}`);

  const result = _.mergeWith(a, b, (objValue, srcValue, key) => {
    if (nonOverwritableKeys.includes(key)) {
      return objValue;
    }
  });

  result.metadata =
    !a.metadata && b.metadata
      ? b.metadata
      : !b.metadata && a.metadata
        ? a.metadata
        : mergeRecords(a.metadata, b.metadata) ?? {};

  console.log(`Result ${JSON.stringify(result)}`);
  return result;
}