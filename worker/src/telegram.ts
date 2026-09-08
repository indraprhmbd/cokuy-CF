/** Fail-closed: no configured secret means reject. */
export function webhookAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}
