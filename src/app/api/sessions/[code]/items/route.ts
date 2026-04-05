import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { addItemSchema, addItemsBulkSchema } from "@/lib/validators";
import { logger } from "@/lib/logger";

async function verifyHost(code: string, request: Request) {
  const token = request.headers.get("x-host-token");
  if (!token) return null;

  const session = await prisma.session.findUnique({ where: { code } });
  if (!session || session.hostToken !== token) return null;

  return session;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await prisma.session.findUnique({ where: { code } });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const items = await prisma.item.findMany({
    where: { sessionId: session.id },
    orderBy: { order: "asc" },
  });

  return NextResponse.json(items);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const session = await verifyHost(code, request);

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.status !== "LOBBY") {
      return NextResponse.json(
        { error: "Can only add items in lobby" },
        { status: 400 }
      );
    }

    const body = await request.json();

    // Support both single item and bulk add
    if (body.items) {
      const parsed = addItemsBulkSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid input", details: parsed.error.issues },
          { status: 400 }
        );
      }

      const currentMax = await prisma.item.aggregate({
        where: { sessionId: session.id },
        _max: { order: true },
      });
      const startOrder = (currentMax._max.order ?? -1) + 1;

      const items = await prisma.item.createManyAndReturn({
        data: parsed.data.items.map((item, i) => ({
          sessionId: session.id,
          name: item.name,
          description: item.description,
          imageUrl: item.imageUrl,
          minBid: item.minBid,
          order: startOrder + i,
        })),
      });

      logger.info(
        { sessionCode: code, count: items.length },
        "Bulk items added"
      );

      return NextResponse.json(items, { status: 201 });
    }

    const parsed = addItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const currentMax = await prisma.item.aggregate({
      where: { sessionId: session.id },
      _max: { order: true },
    });
    const order = (currentMax._max.order ?? -1) + 1;

    const item = await prisma.item.create({
      data: {
        sessionId: session.id,
        name: parsed.data.name,
        description: parsed.data.description,
        imageUrl: parsed.data.imageUrl,
        minBid: parsed.data.minBid,
        order,
      },
    });

    logger.info({ sessionCode: code, item: item.name }, "Item added");

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    logger.error({ error }, "Failed to add items");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const session = await verifyHost(code, request);

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.status !== "LOBBY") {
      return NextResponse.json(
        { error: "Can only reorder items in lobby" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { orderedIds } = body as { orderedIds: string[] };

    if (!Array.isArray(orderedIds)) {
      return NextResponse.json(
        { error: "orderedIds must be an array" },
        { status: 400 }
      );
    }

    // Update each item's order in a transaction
    await prisma.$transaction(
      orderedIds.map((id, index) =>
        prisma.item.update({
          where: { id },
          data: { order: index },
        })
      )
    );

    logger.info({ sessionCode: code }, "Items reordered");

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Failed to reorder items");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const session = await verifyHost(code, request);

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.status !== "LOBBY") {
      return NextResponse.json(
        { error: "Can only remove items in lobby" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get("itemId");

    if (!itemId) {
      return NextResponse.json(
        { error: "itemId is required" },
        { status: 400 }
      );
    }

    await prisma.item.delete({ where: { id: itemId } });

    // Re-order remaining items
    const remaining = await prisma.item.findMany({
      where: { sessionId: session.id },
      orderBy: { order: "asc" },
    });

    await prisma.$transaction(
      remaining.map((item, index) =>
        prisma.item.update({
          where: { id: item.id },
          data: { order: index },
        })
      )
    );

    logger.info({ sessionCode: code, itemId }, "Item removed");

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Failed to remove item");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
