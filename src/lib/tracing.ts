import { nanoid } from "nanoid";
import { logger } from "./logger";

const CORRELATION_HEADER = "x-correlation-id";

export function createCorrelationId(): string {
  return nanoid(16);
}

export function createRequestLogger(correlationId: string) {
  return logger.child({ correlationId });
}

/**
 * Extract correlation ID from a Request and return a child logger bound to it.
 */
export function getRequestLogger(request: Request) {
  const correlationId =
    request.headers.get(CORRELATION_HEADER) ?? createCorrelationId();
  return { correlationId, log: logger.child({ correlationId }) };
}
