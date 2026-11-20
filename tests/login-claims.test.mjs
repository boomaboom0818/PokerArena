import assert from 'node:assert/strict';
import test from 'node:test';
import { verifiedEmail } from '../arena-shared/login-claims.ts';

test('deployment requires a current player login issued for this app with verified contact info', () => {
  const fullPayload = { email: 'winner@example.org', email_verified: true, exp: 600 };
  const login = { issuer: 'https://auth.spacetimedb.com/oidc', subject: 'player', audience: ['arena'], fullPayload };
  const contact = jwt => verifiedEmail(jwt, 'arena', 500_000);
  assert.equal(contact(login), fullPayload.email);
  for (const jwt of [null, {...login, issuer: 'other'}, {...login, audience: ['other']}, {...login, subject: ''},
    ...[{exp: 500}, {exp: undefined}, {email_verified: 'false'}, {email_verified: false}, {email: ''}, {azp: 'other'}]
      .map(override => ({...login, fullPayload: {...fullPayload, ...override}}))]) {
    assert.equal(contact(jwt), null);
  }
  assert.equal(verifiedEmail(login, '', 500_000), null);
});
