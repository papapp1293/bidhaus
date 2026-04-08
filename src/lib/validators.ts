import { z } from "zod/v4";
import {
  DEFAULT_BUDGET,
  DEFAULT_TIME_PER_ITEM,
  DEFAULT_RESET_TIME,
  MAX_ITEMS_PER_SESSION,
  MAX_BIDDERS_PER_SESSION,
} from "./constants";

export const createSessionSchema = z.object({
  name: z.string().min(1).max(100),
  hostName: z.string().min(1).max(50),
  budgetPerBidder: z.number().int().min(1).max(10_000).default(DEFAULT_BUDGET),
  timePerItem: z
    .number()
    .int()
    .min(5)
    .max(300)
    .default(DEFAULT_TIME_PER_ITEM),
  resetTime: z.number().int().min(0).max(300).default(DEFAULT_RESET_TIME),
  enforceEvenTeams: z.boolean().default(false),
});

export const addItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().optional(),
  minBid: z.number().int().min(1).default(1),
});

export const addItemsBulkSchema = z.object({
  items: z.array(addItemSchema).min(1).max(MAX_ITEMS_PER_SESSION),
});

export const joinSessionSchema = z.object({
  name: z.string().min(1).max(50),
  role: z.enum(["BIDDER", "SPECTATOR"]),
});

export const placeBidSchema = z.object({
  itemId: z.string().min(1),
  amount: z.number().int().min(1),
  token: z.string().min(1),
});

export const hostControlSchema = z.object({
  token: z.string().min(1),
  action: z.enum(["start", "pause", "resume", "skip", "close-item"]),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type AddItemInput = z.infer<typeof addItemSchema>;
export type JoinSessionInput = z.infer<typeof joinSessionSchema>;
export type PlaceBidInput = z.infer<typeof placeBidSchema>;
export type HostControlInput = z.infer<typeof hostControlSchema>;
