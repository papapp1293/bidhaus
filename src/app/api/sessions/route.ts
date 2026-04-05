import { NextResponse } from "next/server";
import { createSessionSchema } from "@/lib/validators";
import { createSession } from "@/server/session-service";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = createSessionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { session, hostToken } = await createSession(parsed.data);

    logger.info({ sessionCode: session.code }, "Session created");

    return NextResponse.json(
      {
        code: session.code,
        hostToken,
        name: session.name,
        budgetPerBidder: session.budgetPerBidder,
        timePerItem: session.timePerItem,
      },
      { status: 201 }
    );
  } catch (error) {
    logger.error({ error }, "Failed to create session");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
