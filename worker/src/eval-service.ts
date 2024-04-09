import { z } from "zod";

import {
  ChatMessageRole,
  EvalExecutionEvent,
  ModelProvider,
  QueueJobs,
  QueueName,
  ScoreSource,
  fetchLLMCompletion,
  singleFilter,
  tableColumnsToSqlFilterAndPrefix,
  tracesTableCols,
  variableMappingList,
  evalObjects,
  TraceUpsertEvent,
  EvalModelNames,
  evalModels,
  ZodModelConfig,
} from "@langfuse/shared";
import { Prisma } from "@langfuse/shared";
import { kyselyPrisma, prisma } from "@langfuse/shared/src/db";
import { randomUUID } from "crypto";
import { evalQueue } from "./redis/consumer";
import { sql } from "kysely";
import Handlebars from "handlebars";
import logger from "./logger";

// this function is used to determine which eval jobs to create for a given trace
// there might be multiple eval jobs to create for a single trace
export const createEvalJobs = async ({
  data,
}: {
  data: z.infer<typeof TraceUpsertEvent>;
}) => {
  const configs = await kyselyPrisma.$kysely
    .selectFrom("job_configurations")
    .selectAll()
    .where(sql.raw("job_type::text"), "=", "EVAL")
    .where("project_id", "=", data.data.projectId)
    .execute();

  if (configs.length === 0) {
    logger.info("No evaluation jobs found for project", data.data.projectId);
    return;
  }
  logger.info("Creating eval jobs for trace", data.data.traceId);

  for (const config of configs) {
    logger.info("Creating eval job for config", config.id);
    const validatedFilter = z.array(singleFilter).parse(config.filter);

    const condition = tableColumnsToSqlFilterAndPrefix(
      validatedFilter,
      tracesTableCols,
      "traces"
    );

    const joinedQuery = Prisma.sql`
        SELECT id
        FROM traces as t
        WHERE project_id = ${data.data.projectId}
        AND id = ${data.data.traceId}
        ${condition}
      `;

    const traces = await prisma.$queryRaw<Array<{ id: string }>>(joinedQuery);

    const existingJob = await kyselyPrisma.$kysely
      .selectFrom("job_executions")
      .select("id")
      .where("project_id", "=", data.data.projectId)
      .where("job_configuration_id", "=", config.id)
      .where("job_input_trace_id", "=", data.data.traceId)
      .execute();

    // if we have a match, and no execution exists already, we want to create a job execution
    if (traces.length > 0) {
      logger.info(
        `Eval job for config ${config.id} matched trace ids ${JSON.stringify(traces.map((t) => t.id))}`
      );

      const jobExecutionId = randomUUID();

      if (existingJob.length > 0) {
        logger.info(
          `Eval job for config ${config.id} and trace ${data.data.traceId} already exists`
        );
        continue;
      }

      logger.info(
        `Creating eval job for config ${config.id} and trace ${data.data.traceId}`
      );

      await kyselyPrisma.$kysely
        .insertInto("job_executions")
        .values({
          id: jobExecutionId,
          project_id: data.data.projectId,
          job_configuration_id: config.id,
          job_input_trace_id: data.data.traceId,
          status: sql`'PENDING'::"JobExecutionStatus"`,
        })
        .execute();

      evalQueue?.add(
        QueueName.EvaluationExecution,
        {
          name: QueueJobs.EvaluationExecution,
          payload: {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            data: {
              projectId: data.data.projectId,
              jobExecutionId: jobExecutionId,
            },
          },
        },
        {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          delay: config.delay, // milliseconds
        }
      );
    } else {
      // if we do not have a match, and execution exists, we mark the job as cancelled
      // we do this, because a second trace event might 'deselect' a trace
      logger.info(`Eval job for config ${config.id} did not match trace`);
      if (existingJob.length > 0) {
        logger.info(
          `Cancelling eval job for config ${config.id} and trace ${data.data.traceId}`
        );
        await kyselyPrisma.$kysely
          .updateTable("job_executions")
          .set("status", sql`'CANCELLED'::"JobExecutionStatus"`)
          .where("id", "=", existingJob[0].id)
          .execute();
      }
    }
  }
};

// for a single eval job, this function is used to evaluate the job
export const evaluate = async ({
  data,
}: {
  data: z.infer<typeof EvalExecutionEvent>;
}) => {
  logger.info(
    `Evaluating job ${data.data.jobExecutionId} for project ${data.data.projectId}`
  );
  // first, fetch all the context required for the evaluation
  const job = await kyselyPrisma.$kysely
    .selectFrom("job_executions")
    .selectAll()
    .where("id", "=", data.data.jobExecutionId)
    .where("project_id", "=", data.data.projectId)
    .executeTakeFirstOrThrow();

  if (!job?.job_input_trace_id) {
    throw new Error("Jobs can only be executed on traces for now.");
  }

  if (job.status === "CANCELLED") {
    logger.info(
      `Job ${job.id} for project ${data.data.projectId} was cancelled.`
    );

    await kyselyPrisma.$kysely
      .deleteFrom("job_executions")
      .where("id", "=", job.id)
      .where("project_id", "=", data.data.projectId)
      .execute();

    return;
  }

  const config = await kyselyPrisma.$kysely
    .selectFrom("job_configurations")
    .selectAll()
    .where("id", "=", job.job_configuration_id)
    .where("project_id", "=", data.data.projectId)
    .executeTakeFirstOrThrow();

  const template = await kyselyPrisma.$kysely
    .selectFrom("eval_templates")
    .selectAll()
    .where("id", "=", config.eval_template_id)
    .where("project_id", "=", data.data.projectId)
    .executeTakeFirstOrThrow();

  logger.info(
    `Evaluating job ${job.id} for project ${data.data.projectId} with template ${template.id}. Searching for context...`
  );

  const parsedVariableMapping = variableMappingList.parse(
    config.variable_mapping
  );

  // extract the variables which need to be inserted into the prompt
  const mappingResult = await extractVariablesFromTrace(
    data.data.projectId,
    template.vars,
    job.job_input_trace_id,
    parsedVariableMapping
  );

  logger.info(`Extracted variables ${JSON.stringify(mappingResult)} `);

  // compile the prompt and send out the LLM request
  const prompt = compileHandlebarString(template.prompt, {
    ...Object.fromEntries(
      mappingResult.map(({ var: key, value }) => [key, value])
    ),
  });

  logger.info(`Compiled prompt ${prompt}`);

  const parsedOutputSchema = z
    .object({
      score: z.string(),
      reasoning: z.string(),
    })
    .parse(template.output_schema);

  if (!parsedOutputSchema) {
    throw new Error("Output schema not found");
  }

  const openAIFunction = z.object({
    score: z.number().describe(parsedOutputSchema.score),
    reasoning: z.string().describe(parsedOutputSchema.reasoning),
  });

  const evalModel = EvalModelNames.parse(template.model);
  const provider = evalModels.find((m) => m.model === evalModel)?.provider;
  const modelParams = ZodModelConfig.parse(template.model_params);

  if (!provider) {
    throw new Error(`Model ${evalModel} provider not found`);
  }

  const completion = await fetchLLMCompletion({
    streaming: false,
    messages: [{ role: ChatMessageRole.System, content: prompt }],
    modelParams: {
      provider: provider,
      model: evalModel,
      ...modelParams,
    },
    functionCall: {
      name: "evaluate",
      description: "some description",
      parameters: openAIFunction,
    },
  });

  const parsedLLMOutput = openAIFunction.parse(completion);

  logger.info(`Parsed LLM output ${JSON.stringify(parsedLLMOutput)}`);

  // persist the score and update the job status
  const scoreId = randomUUID();
  await kyselyPrisma.$kysely
    .insertInto("scores")
    .values({
      id: scoreId,
      trace_id: job.job_input_trace_id,
      name: config.score_name,
      value: parsedLLMOutput.score,
      comment: parsedLLMOutput.reasoning,
      source: sql`'EVAL'::"ScoreSource"`,
    })
    .execute();

  await kyselyPrisma.$kysely
    .updateTable("job_executions")
    // .set("status", sql`'COMPLETED'::"JobExecutionStatus"`)
    .set("end_time", new Date())
    .set("job_output_score_id", scoreId)
    .where("id", "=", data.data.jobExecutionId)
    .execute();
};

export function compileHandlebarString(
  handlebarString: string,
  context: Record<string, any>
): string {
  logger.info("Compiling handlebar string", handlebarString, context);
  const template = Handlebars.compile(handlebarString, { noEscape: true });
  return template(context);
}

async function extractVariablesFromTrace(
  projectId: string,
  variables: string[],
  traceId: string,
  // this here are variables which were inserted by users. Need to validate before DB query.
  variableMapping: z.infer<typeof variableMappingList>
) {
  const mappingResult: { var: string; value: string }[] = [];

  // find the context for each variable of the template
  for (const variable of variables) {
    const mapping = variableMapping.find(
      (m) => m.templateVariable === variable
    );

    if (!mapping) {
      logger.debug(`No mapping found for variable ${variable}`);
      mappingResult.push({ var: variable, value: "" });
      continue; // no need to fetch additional data
    }

    if (mapping.langfuseObject === "trace") {
      // find the internal definitions of the column
      const column = evalObjects
        .find((o) => o.id === "trace")
        ?.availableColumns.find((col) => col.id === mapping.selectedColumnId);

      // if no column was found, we still process with an empty variable
      if (!column?.id) {
        logger.error(
          `No column found for variable ${variable} and column ${mapping.selectedColumnId}`
        );
        mappingResult.push({ var: variable, value: "" });
        continue;
      }

      const trace = await kyselyPrisma.$kysely
        .selectFrom("traces as t")
        .select(sql`${sql.raw(column.internal)}`.as(column.id)) // query the internal column name raw
        .where("id", "=", traceId)
        .where("project_id", "=", projectId)
        .executeTakeFirstOrThrow();

      mappingResult.push({
        var: variable,
        value: parseUnknwnToString(trace[mapping.selectedColumnId]),
      });
    }
    if (["generation", "span", "event"].includes(mapping.langfuseObject)) {
      const column = evalObjects
        .find((o) => o.id === mapping.langfuseObject)
        ?.availableColumns.find((col) => col.id === mapping.selectedColumnId);

      if (!mapping.objectName) {
        logger.info(
          `No object name found for variable ${variable} and object ${mapping.langfuseObject}`
        );
        mappingResult.push({ var: variable, value: "" });
        continue;
      }

      if (!column?.id) {
        logger.warn(
          `No column found for variable ${variable} and column ${mapping.selectedColumnId}`
        );
        mappingResult.push({ var: variable, value: "" });
        continue;
      }

      const observation = await kyselyPrisma.$kysely
        .selectFrom("observations as o")
        .select(sql`${sql.raw(column.internal)}`.as(column.id)) // query the internal column name raw
        .where("trace_id", "=", traceId)
        .where("project_id", "=", projectId)
        .where("name", "=", mapping.objectName)
        .executeTakeFirstOrThrow();

      mappingResult.push({
        var: variable,
        value: parseUnknwnToString(observation[mapping.selectedColumnId]),
      });
    }
  }
  return mappingResult;
}

export const parseUnknwnToString = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value.toString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "symbol") {
    return value.toString();
  }

  return String(value);
};