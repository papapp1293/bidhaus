import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { hostControlSchema } from "@/lib/validators";
import { advanceToNextItem, awardItem } from "@/server/bid-service";
import { logger } from "@/lib/logger";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const body = await request.json();
    const parsed = hostControlSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { token, action } = parsed.data;

    const session = await prisma.session.findUnique({
      where: { code },
      include: { items: { orderBy: { order: "asc" } } },
    });

    if (!session || session.hostToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    switch (action) {
      case "start": {
        if (session.status !== "LOBBY" && session.status !== "PAUSED") {
          return NextResponse.json(
            { error: "Session cannot be started from current state" },
            { status: 400 }
          );
        }

        if (session.items.length === 0) {
          return NextResponse.json(
            { error: "Add items before starting" },
            { status: 400 }
          );
        }

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "LIVE" },
        });

        // Advance to first item
        const result = await advanceToNextItem(session.id);

        logger.info({ sessionCode: code }, "Session started");

        return NextResponse.json({
          status: "LIVE",
          currentItem: result.item,
        });
      }

      case "pause": {
        if (session.status !== "LIVE") {
          return NextResponse.json(
            { error: "Can only pause a live session" },
            { status: 400 }
          );
        }

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "PAUSED" },
        });

        logger.info({ sessionCode: code }, "Session paused");
        return NextResponse.json({ status: "PAUSED" });
      }

      case "resume": {
        if (session.status !== "PAUSED") {
          return NextResponse.json(
            { error: "Can only resume a paused session" },
            { status: 400 }
          );
        }

        await prisma.session.update({
          where: { id: session.id },
          data: { status: "LIVE" },
        });

        logger.info({ sessionCode: code }, "Session resumed");
        return NextResponse.json({ status: "LIVE" });
      }

      case "skip": {
        if (session.status !== "LIVE") {
          return NextResponse.json(
            { error: "Can only skip during live session" },
            { status: 400 }
          );
        }

        const currentItem = session.items[session.currentItemIdx ?? 0];
        if (currentItem) {
          await prisma.item.update({
            where: { id: currentItem.id },
            data: { status: "UNSOLD" },
          });
        }

        const result = await advanceToNextItem(session.id);

        logger.info({ sessionCode: code }, "Item skipped");

        return NextResponse.json({
          status: result.completed ? "COMPLETED" : "LIVE",
          currentItem: result.item,
          completed: result.completed,
        });
      }

      case "close-item": {
        if (session.status !== "LIVE") {
          return NextResponse.json(
            { error: "Can only close item during live session" },
            { status: 400 }
          );
        }

        const activeItem = session.items[session.currentItemIdx ?? 0];
        if (!activeItem) {
          return NextResponse.json(
            { error: "No active item" },
            { status: 400 }
          );
        }

        const award = await awardItem(activeItem.id);
        const next = await advanceToNextItem(session.id);

        logger.info(
          { sessionCode: code, sold: award.sold, winner: award.winner },
          "Item closed"
        );

        return NextResponse.json({
          award,
          status: next.completed ? "COMPLETED" : "LIVE",
          currentItem: next.item,
          completed: next.completed,
        });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action" },
          { status: 400 }
        );
    }
  } catch (error) {
    logger.error({ error }, "Host control failed");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
