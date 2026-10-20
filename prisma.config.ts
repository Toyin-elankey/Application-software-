import { defineConfig } from 'prisma/config';

// Prisma 7: connection URLs live here, not in schema.prisma.
// The data model is not migrated yet (Stage 2). `prisma validate` does not connect.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
