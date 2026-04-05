import { NextResponse } from "next/server";
import { getSessionByCode } from "@/server/session-service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  const session = await getSessionByCode(code);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const { hostToken: _, ...safeSession } = session;

  return NextResponse.json(safeSession);
}
