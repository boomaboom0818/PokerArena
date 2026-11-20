import type { JwtClaims } from 'spacetimedb/server';

// Signature verification is done by SpacetimeDB. An otherwise valid token from
// another application, or a plain SpacetimeDB bot identity, isn't a player login.
export function verifiedEmail(jwt: JwtClaims | null, clientId: string, nowMs: number): string | null {
  if (!clientId || !jwt || jwt.issuer !== 'https://auth.spacetimedb.com/oidc' || !jwt.subject ||
      !jwt.audience.includes(clientId)) return null;
  const { email, email_verified, exp, azp } = jwt.fullPayload;
  if (azp !== undefined && azp !== clientId) return null;
  return typeof exp === 'number' && exp * 1000 > nowMs && email_verified === true &&
    typeof email === 'string' && email.length > 0 ? email : null;
}
