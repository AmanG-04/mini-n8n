import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;

export function database(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required in the server function environment");
    pool = new Pool({ connectionString, max: 8, ssl: process.env.DATABASE_SSL === "false" ? false : undefined });
  }
  return pool;
}

export type DbClient = Pick<PoolClient, "query">;

export async function one<T extends QueryResultRow>(client: DbClient, sql: string, values: unknown[] = []): Promise<T | null> {
  const result = await client.query<T>(sql, values);
  return result.rows[0] ?? null;
}
