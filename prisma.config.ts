import { defineConfig } from 'prisma/config';

// Prisma 7: connection URLs live here, not in schema.prisma.
// DATABASE_URL is the application database. SHADOW_DATABASE_URL is a throwaway database that
// `prisma migrate diff --from-migrations` uses. It is only needed in CI and is never written to
// by the application.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
