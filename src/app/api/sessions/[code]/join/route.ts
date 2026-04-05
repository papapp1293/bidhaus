import { NextResponse } from "next/server";
import { joinSessionSchema } from "@/lib/validators";
import { joinSession } from "@/server/session-service";
import { logger } from "@/lib/logger";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const body = await request.json();
    const parsed = joinSessionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const result = await joinSession(code, parsed.data);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    logger.info(
      { sessionCode: code, participant: result.participant.name },
      "Participant joined"
    );

    return NextResponse.json(
      {
        participantId: result.participant.id,
        token: result.token,
        name: result.participant.name,
        role: result.participant.role,
        budget: result.participant.budget,
      },
      { status: 201 }
    );
  } catch (error) {
    logger.error({ error }, "Failed to join session");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
