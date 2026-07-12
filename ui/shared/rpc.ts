/** UI -> backend RPC over the local HTTP server (POST /api/<name> with JSON args array). */
export async function rpc<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.result as T;
}
