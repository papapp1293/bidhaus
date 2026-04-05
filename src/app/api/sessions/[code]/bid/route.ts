import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { placeBidSchema } from "@/lib/validators";
import { placeBid } from "@/server/bid-service";
import { logger } from "@/lib/logger";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const body = await request.json();
    const parsed = placeBidSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 }
      );
    }

    // Verify token belongs to a participant in this session
    const participant = await prisma.participant.findUnique({
      where: { token: parsed.data.token },
      include: { session: true },
    });

    if (!participant || participant.session.code !== code) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await placeBid(
      parsed.data.itemId,
      parsed.data.amount,
      participant.id
    );

    if (!result.success) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }

    return NextResponse.json(result.bid, { status: 201 });
  } catch (error) {
    logger.error({ error }, "Bid API failed");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
