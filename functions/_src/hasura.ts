export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type GraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

function endpoint(): string {
  const url = process.env.NHOST_GRAPHQL_URL;
  if (!url) throw new Error("NHOST_GRAPHQL_URL is required in the Nhost Function environment");
  return url;
}

/** Server-only Hasura access. The admin secret never reaches the Next.js app. */
export async function hasura<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? process.env.NHOST_ADMIN_SECRET;
  if (!secret) throw new Error("NHOST_ADMIN_SECRET (or HASURA_GRAPHQL_ADMIN_SECRET) is required in the Nhost Function environment");
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": secret },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json() as GraphqlResponse<T>;
  if (!response.ok || body.errors?.length || !body.data) throw new Error(body.errors?.map((error) => error.message).join("; ") || `Hasura request failed (${response.status})`);
  return body.data;
}
