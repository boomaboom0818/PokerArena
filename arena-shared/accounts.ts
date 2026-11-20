import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { verifiedEmail } from './login-claims.ts';

// Private organizer records. The login identity is stable across the three games;
// the bot's runtime identity stays on its machine and never needs a user's ID token.
export const accountTables = {
  botAccount: table({ name: 'bot_account' }, {
    name: t.string().primaryKey(), account: t.identity().unique(), runtime: t.identity().unique(), email: t.string(),
  }),
  deployGrant: table({ name: 'deploy_grant' }, {
    account: t.identity().primaryKey(), digest: t.string().unique(), name: t.string(), email: t.string(), expiresMs: t.f64(),
  }),
  accountBan: table({ name: 'account_ban' }, { account: t.identity().primaryKey() }),
};
export const accountEnv = { ARENA_AUTH_CLIENT_ID: t.string() };
// Type the shared subset without constructing a second runtime schema.
const accountSchema = () => schema(accountTables, { env: accountEnv });
type Ctx = Pick<ReducerCtx<InferSchema<ReturnType<typeof accountSchema>>>, 'db' | 'sender' | 'senderAuth' | 'env' | 'timestamp'>;
const now = (ctx: Ctx) => Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);

export function issueCode(ctx: Ctx, { name, digest }: { name: string; digest: string }) {
  const email = verifiedEmail(ctx.senderAuth.jwt, ctx.env.ARENA_AUTH_CLIENT_ID, now(ctx));
  if (!email) throw new SenderError('Sign in to PokerArena with a verified email to link a bot.');
  if (ctx.db.accountBan.account.find(ctx.sender)) throw new SenderError('This account is banned.');
  if (!/^[a-z0-9_]{1,24}$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new SenderError('Invalid bot name or deployment code.');
  const mine = ctx.db.botAccount.account.find(ctx.sender);
  if (mine && mine.name !== name) throw new SenderError(`Your bot in this arena is ${mine.name}.`);
  if (!mine && ctx.db.botAccount.name.find(name)) throw new SenderError('Name already reserved.');
  const grant = { account: ctx.sender, digest, name, email, expiresMs: now(ctx) + 600_000 };
  if (ctx.db.deployGrant.account.find(ctx.sender)) ctx.db.deployGrant.account.update(grant);
  else ctx.db.deployGrant.insert(grant);
}

// Run inside the same reducer transaction as registration: a name conflict or a
// failed legacy ownership check rolls back both redemption and the new binding.
export function redeemCode(ctx: Ctx, name: string, code: string) {
  const digest = /^[0-9a-f]{32}$/.test(code) ? bytesToHex(sha256(utf8ToBytes(code))) : '';
  const grant = ctx.db.deployGrant.digest.find(digest);
  if (!grant || grant.name !== name || grant.expiresMs <= now(ctx)) throw new SenderError('Invalid or expired code for this bot and game.');
  if (ctx.db.accountBan.account.find(grant.account)) throw new SenderError('This account is banned.');
  const old = ctx.db.botAccount.name.find(name);
  if (old && !old.account.isEqual(grant.account)) throw new SenderError('Name already reserved.');
  const link = { name, account: grant.account, runtime: ctx.sender, email: grant.email };
  if (old) ctx.db.botAccount.name.update(link);
  else ctx.db.botAccount.insert(link);
  ctx.db.deployGrant.account.delete(grant.account);
  return old;
}

export function eligibleAccount(ctx: Ctx, name: string) {
  const row = ctx.db.botAccount.name.find(name);
  return !!row && !ctx.db.accountBan.account.find(row.account);
}

export function requireLinked(ctx: Ctx, name: string) {
  const link = ctx.db.botAccount.name.find(name);
  if (!link || !link.runtime.isEqual(ctx.sender)) throw new SenderError('LINK_REQUIRED: sign in on the PokerArena Account page to link this bot.');
  if (ctx.db.accountBan.account.find(link.account)) throw new SenderError('This account is banned.');
}

export function setBan(ctx: Ctx, isAdmin: boolean, accountId: string, banned: boolean) {
  if (!isAdmin) throw new SenderError('Arena admin required.');
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new SenderError('Expected a 64-character account identity.');
  const account = Identity.fromString(accountId);
  if (banned) {
    if (!ctx.db.accountBan.account.find(account)) ctx.db.accountBan.insert({ account });
    ctx.db.deployGrant.account.delete(account);
  } else ctx.db.accountBan.account.delete(account);
  return ctx.db.botAccount.account.find(account)?.name;
}
