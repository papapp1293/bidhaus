import path from "node:path";
import type { PrismaConfig } from "prisma";

export default {
  earlyAccess: true,
  schema: path.join(__dirname, "schema.prisma"),
  migrate: {
    adapter: async () => {
      const pg = await import("pg");
      const pool = new pg.default.Pool({
        connectionString:
          process.env.DATABASE_URL ??
          "postgresql://bidhaus:bidhaus@localhost:5432/bidhaus",
      });
      const { PrismaPg } = await import("@prisma/adapter-pg");
      return new PrismaPg(pool);
    },
  },
} satisfies PrismaConfig;
