import { prisma } from "./db";
import { generateInviteCode, generateToken } from "@/lib/invite-codes";
import type {
  CreateSessionInput,
  JoinSessionInput,
} from "@/lib/validators";
import type { ParticipantRole } from "@/generated/prisma";

export async function createSession(input: CreateSessionInput) {
  const code = generateInviteCode();
  const hostToken = generateToken();

  const session = await prisma.session.create({
    data: {
      code,
      name: input.name,
      hostName: input.hostName,
      hostToken,
      budgetPerBidder: input.budgetPerBidder,
      timePerItem: input.timePerItem,
    },
  });

  return { session, hostToken };
}

export async function getSessionByCode(code: string) {
  return prisma.session.findUnique({
    where: { code },
    include: {
      items: { orderBy: { order: "asc" } },
      participants: {
        select: {
          id: true,
          name: true,
          role: true,
          budget: true,
          connected: true,
          joinedAt: true,
        },
      },
    },
  });
}

export async function joinSession(
  code: string,
  input: JoinSessionInput
) {
  const session = await prisma.session.findUnique({ where: { code } });

  if (!session) {
    return { error: "Session not found" } as const;
  }

  if (session.status === "COMPLETED") {
    return { error: "Session has already ended" } as const;
  }

  const existing = await prisma.participant.findUnique({
    where: { sessionId_name: { sessionId: session.id, name: input.name } },
  });

  if (existing) {
    return { error: "Name already taken in this session" } as const;
  }

  const token = generateToken();
  const participant = await prisma.participant.create({
    data: {
      sessionId: session.id,
      name: input.name,
      token,
      role: input.role as ParticipantRole,
      budget: input.role === "BIDDER" ? session.budgetPerBidder : null,
    },
  });

  return { participant, token };
}

export async function getParticipantByToken(token: string) {
  return prisma.participant.findUnique({
    where: { token },
    include: { session: true },
  });
}

export async function getSessionParticipants(sessionId: string) {
  return prisma.participant.findMany({
    where: { sessionId },
    select: {
      id: true,
      name: true,
      role: true,
      budget: true,
      connected: true,
      joinedAt: true,
    },
    orderBy: { joinedAt: "asc" },
  });
}
