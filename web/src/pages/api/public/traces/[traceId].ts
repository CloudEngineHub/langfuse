import { verifyAuthHeaderAndReturnScope } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { mapUsageOutput } from "@/src/features/public-api/server/outputSchemaConversion";
import { prisma } from "@langfuse/shared/src/db";
import { isPrismaException } from "@/src/utils/exceptions";
import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod";
import { env } from "@/src/env.mjs";
import {
  getObservations,
  getScores,
  getTraces,
} from "@/src/server/api/repositories/clickhouse";

const GetTraceSchema = z.object({
  traceId: z.string(),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET") {
    console.error(req.method, req.body, req.query);
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    // CHECK AUTH
    const authCheck = await verifyAuthHeaderAndReturnScope(
      req.headers.authorization,
    );
    if (!authCheck.validKey)
      return res.status(401).json({
        message: authCheck.error,
      });
    // END CHECK AUTH
    console.log("Trying to get trace:", req.body, req.query);

    const { traceId } = GetTraceSchema.parse(req.query);

    // CHECK ACCESS SCOPE
    if (authCheck.scope.accessLevel !== "all") {
      return res.status(401).json({
        message: "Access denied - need to use basic auth with secret key",
      });
    }
    // END CHECK ACCESS SCOPE

    console.log(
      `get trace ${traceId} for project ${authCheck.scope.projectId}`,
    );

    const trace = env.SERVE_FROM_CLICKHOUSE
      ? await queryTracesAndScoresFromClickhouse(
          traceId,
          authCheck.scope.projectId,
        )
      : await prisma.trace.findFirst({
          where: {
            id: traceId,
            projectId: authCheck.scope.projectId,
          },
          include: {
            scores: true,
          },
        });

    if (!trace) {
      return res.status(404).json({
        message: "Trace not found within authorized project",
      });
    }

    const observations = env.SERVE_FROM_CLICKHOUSE
      ? await queryObservationsFromClickhouse(
          traceId,
          authCheck.scope.projectId,
        )
      : await prisma.observationView.findMany({
          where: {
            traceId: traceId,
            projectId: authCheck.scope.projectId,
          },
        });

    console.log("Return trace:", trace, observations);
    return res.status(200).json({
      ...trace,
      externalId: null,
      htmlPath: `/project/${authCheck.scope.projectId}/traces/${traceId}`,
      totalCost: 0,
      // observations.reduce(
      //   (acc, obs) => acc + (obs.calculatedTotalCost ?? 0),
      //   0,
      // ),
      observations: observations,
    });
  } catch (error: unknown) {
    console.error(error);
    if (isPrismaException(error)) {
      return res.status(500).json({
        error: "Internal Server Error",
      });
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Invalid request data",
        error: error.errors,
      });
    }
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({
      message: "Invalid request data",
      error: errorMessage,
    });
  }
}

const queryTracesAndScoresFromClickhouse = async (
  traceId: string,
  projectId: string,
): Promise<any> => {
  const traces = await getTraces(traceId, projectId);
  const scores = await getScores(traceId, projectId);

  if (traces.length === 0) {
    return undefined;
  }

  if (traces.length > 1) {
    throw new Error("Multiple traces found");
  }

  return {
    ...traces[0],
    scores: scores,
  };
};

const queryObservationsFromClickhouse = async (
  traceId: string,
  projectId: string,
) => {
  return getObservations(traceId, projectId);
};
