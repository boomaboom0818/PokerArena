import { UserManager, WebStorageStateStore } from './vendor/oidc-client-ts-3.5.0.js';

const $ = id => document.getElementById(id);
const authority = 'https://auth.spacetimedb.com/oidc';
const redirect = `${location.origin}/auth/callback`;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
let initialized;

export function openAccount() {
  return initialized ??= initialize().catch(error => {
    $('account-status').textContent = error.message;
    initialized = null;
  });
}

async function initialize() {
  const callback = location.pathname === '/auth/callback' ? location.href : null;
  if (callback) history.replaceState(null, '', '/#account');
  const response = await fetch('/api/auth/config');
  if (!response.ok) throw new Error('Sign-in is unavailable. Try again later.');
  const { client_id } = await response.json();
  if (!client_id) throw new Error('Player sign-in has not been enabled yet. You can still watch every game.');
  const store = new WebStorageStateStore({ store: sessionStorage });
  const auth = new UserManager({ authority, client_id, redirect_uri: redirect,
    post_logout_redirect_uri: `${location.origin}/`, response_type: 'code', scope: 'openid email',
    userStore: store, stateStore: store, automaticSilentRenew: false, monitorSession: false });
  const status = text => { $('account-status').textContent = text; };
  let user, expiryTimer, codeTimer;
  function clearCode() {
    clearTimeout(codeTimer);
    $('deploy-code').value = '';
    $('deploy-result').hidden = true;
  }
  function render() {
    clearTimeout(expiryTimer);
    clearCode();
    if (user && !(user.profile.exp * 1000 > Date.now())) user = null;
    $('account-title').textContent = user ? 'Link a bot' : 'Sign in to link your bot';
    $('account-info').textContent = user ? `Signed in as ${user.profile.email || 'a player'}.` :
      'Your bot name is public. Only organizers can see your verified email for prize notifications and rule enforcement.';
    $('account-login').disabled = false;
    $('account-login').hidden = !!user;
    $('account-logout').hidden = !user;
    $('account-deploy').hidden = !user || user.profile.email_verified !== true;
    if (user) {
      if (user.profile.email_verified !== true) status('Verify your email with your sign-in provider, then sign in again.');
      expiryTimer = setTimeout(() => { user = null; render(); status('Your session expired. Sign in again to link a bot.'); }, user.profile.exp * 1000 - Date.now());
    }
  }

  let selection = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]));
  if (callback) {
    try {
      user = await auth.signinRedirectCallback(callback);
      selection = user.state || {};
    }
    catch { status('Sign-in did not finish. Try signing in again.'); }
  } else user = await auth.getUser();
  if (['poker-arena', 'poker-heads-up', 'figgie-arena'].includes(selection.game)) $('deploy-game').value = selection.game;
  if (selection.name && /^[a-z0-9_]{1,24}$/.test(selection.name)) $('deploy-name').value = selection.name;
  render();
  $('account-login').onclick = () => auth.signinRedirect({nonce: crypto.randomUUID(), state: {
    game: $('deploy-game').value, name: $('deploy-name').value,
  }}).catch(() => status('Could not start sign-in. Try again.'));
  $('account-logout').onclick = async () => {
    const id_token_hint = user?.id_token;
    await auth.removeUser();
    user = null; render(); status('Signed out of PokerArena.');
    await auth.signoutRedirect({id_token_hint}).catch(() => status('Signed out of PokerArena.'));
  };
  $('account-deploy').oninput = () => { clearCode(); status(''); };
  $('account-deploy').onsubmit = async e => {
    e.preventDefault();
    const session = user, name = $('deploy-name').value, game = $('deploy-game').value;
    if (!session) return;
    clearCode(); status('Creating your code…');
    const button = e.submitter || $('account-deploy').querySelector('button');
    button.disabled = true;
    try {
      const code = hex(crypto.getRandomValues(new Uint8Array(16)));
      const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))));
      const res = await fetch(`https://maincloud.spacetimedb.com/v1/database/${game}/call/issue_deploy_code`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${session.id_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([name, digest]),
      });
      if (!res.ok) throw new Error(res.status === 530 ? await res.text() : 'The arena could not issue a code. Try signing in again.');
      if (user !== session || name !== $('deploy-name').value || game !== $('deploy-game').value) return;
      $('deploy-code').value = code;
      $('deploy-result').hidden = false;
      status(`Code ready for ${name}. It expires in 10 minutes.`);
      codeTimer = setTimeout(() => { clearCode(); status('Code expired. Get a new one if you still need to link.'); }, 600_000);
    } catch (error) { if (user === session) status(error.message); }
    finally { button.disabled = false; }
  };
  $('copy-deploy-code').onclick = async () => {
    try { await navigator.clipboard.writeText($('deploy-code').value); status('Code copied. Paste it at the bot’s terminal prompt.'); }
    catch { $('deploy-code').select(); status('Copy the selected code.'); }
  };
}
