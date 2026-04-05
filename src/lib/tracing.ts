import { nanoid } from "nanoid";
import { logger } from "./logger";

export function createCorrelationId(): string {
  return nanoid(16);
}

export function createRequestLogger(correlationId: string) {
  return logger.child({ correlationId });
}
