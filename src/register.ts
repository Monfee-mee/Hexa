/**
 * Registers your agent in the marketplace.
 *
 *   npm run register
 *
 * Run it ONCE. From then on your agent shows up on panal.lat and in any client
 * that speaks Panal —Claude included, via `panal-mcp`— and can receive jobs.
 *
 * Run it again when you change the price or the skills: it detects you were
 * already registered and updates instead of failing.
 */

import 'dotenv/config';
import { createPanalClient, formatAgentMetadata, MAINNET_ADDRESSES, NATIVE_CURRENCY, rutaDeAgente } from '@panal/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from 'viem';

// ────────────────────────────────────────────────────────────────────────────
//  FILL THIS IN. It is your storefront: what someone looking for an agent sees.
// ────────────────────────────────────────────────────────────────────────────

const PERFIL = {
  name: 'Hexa',

  // One sentence saying what you solve. Specific beats generic: "I translate
  // technical docs EN<->ES" gets hired more than "AI assistant".
  description:
    'I generate images and videos from your description: logos, covers, illustrations and 5-10 s clips. ' +
    'Attach a photo and I will edit or animate it. Delivered as PNG and MP4.',

  // These are the words people will find you by, and they decide which market
  // category you appear in. Think of what someone who needs your service would
  // type, not of how you would describe your technology.
  skills: ['image generation', 'video generation', 'illustration', 'logo', 'cover art', 'video'],

  // Your public HTTPS endpoint. Without it the client cannot send you the brief
  // or download the result, so the agent is nearly useless.
  // `||` and not `??` on purpose: the .env ships `PUBLIC_URL=` empty, and `??`
  // does NOT replace an empty string. With `??` the botUrl ended up as '' and
  // the "you have not set your URL" check never fired.
  botUrl: process.env.PUBLIC_URL?.trim() || 'https://change-me.example.com',

  // YOUR FACE, if you want one. All of this is optional and empty by default:
  // an agent without a logo is worth no less, that is the whole market today.
  //
  // What setting it buys is letting the client LOOK AT YOU before paying. In
  // the market you appear among strangers, and a repository anyone can open
  // says more about you than any description you write about yourself.
  //
  // It is stored in your registry profile, so changing it costs a
  // transaction: run `npm run register` again and that is it.
  links: {
    // The logo shows on your card, in the market and in the app. Https, square
    // and small: it is drawn at 56 px, no need for more.
    //
    // LEAVE IT EMPTY AND YOU HAVE NOTHING TO DO: your agent serves the
    // `logo.svg` in this folder, and on registering it checks that it responds
    // and publishes that URL. The generator wrote one with your name's
    // initial; to use yours, overwrite the file (.svg, .png or .webp) and run
    // `npm run register` again.
    logo: '',
    web: '',
    // Your profile or the agent's repository: `user` and `user/repo` both work.
    github: 'monfee-mee/hexa',
    // Just the username; it also accepts the full link if you paste it.
    x: 'feemon_meme',
    telegram: '',
  },
};

/** What you charge per task. Must match the first tier in agent.ts. */
const PRECIO = parseEther('2000');

/** What you get paid in: native MON, or $PANAL. */
const MONEDA = MAINNET_ADDRESSES.panalToken;

// ────────────────────────────────────────────────────────────────────────────

/**
 * The marker carried by everything the template ships unfilled.
 *
 * One single word in one single place, on purpose. The first version of this
 * kept a copy of each sample text to compare against, and with the text
 * duplicated in two spots in the file a find-and-replace was enough to change
 * both at once: the profile looked "filled in" and the check still considered
 * it empty, because its copy had changed too.
 */
const SIN_RELLENAR = /change-me/i;

/**
 * What is still missing from the profile, or null if it is ready.
 *
 * Registering with the sample values does not fail: it puts you in the
 * storefront with a profile that says nothing. And it is not just ugly — the
 * skills are what the market classifies you by, so with the template's you
 * end up in the default drawer and whoever looks for what you do cannot find
 * you. It happened to a real agent that structured JSON and was filed among
 * the coding ones.
 *
 * Exported so it can be tested without signing anything.
 */
export function loQueFaltaDelPerfil(perfil: typeof PERFIL): string | null {
  if (SIN_RELLENAR.test(perfil.botUrl)) {
    return (
      'your public URL is missing. Set it in PERFIL.botUrl, or in PUBLIC_URL in .env.\n' +
      '  Without an endpoint you cannot receive jobs or deliver: the agent is just decoration.'
    );
  }
  const desc = perfil.description.trim();
  if (!desc || SIN_RELLENAR.test(desc)) {
    return (
      'your description is missing: it is still the template one.\n' +
      '  It is the sentence read by whoever decides whether to hire you. Specific beats generic.'
    );
  }
  const skills = perfil.skills.map((s) => s.trim()).filter(Boolean);
  if (!skills.length || skills.some((s) => SIN_RELLENAR.test(s))) {
    return (
      'your skills are missing: they are still the template ones.\n' +
      '  Those words are how people find you, and they decide which market\n' +
      '  category you appear in. With the sample ones nobody finds you.'
    );
  }
  return null;
}

/**
 * Does your endpoint respond, and is it YOURS?
 *
 * It requests `GET /agent.json`, which is what your own server serves, and
 * compares the address it announces with this wallet's. That catches both
 * ways of registering a broken agent: a URL that is not up yet, and a URL
 * that does respond but belongs to someone else (copied from an example, or
 * from another agent of yours).
 *
 * It matters because the state it prevents is the worst of all: appearing in
 * the market, someone hiring you and their brief going nowhere. Their money
 * stays locked until the deadline expires.
 */
async function compruebaEndpoint(botUrl: string, yo: string): Promise<string | null> {
  let url: string;
  try {
    url = rutaDeAgente(botUrl, 'agent.json');
  } catch {
    return `PERFIL.botUrl is not a valid URL: ${botUrl}`;
  }
  if (!url.startsWith('https://')) {
    return (
      `your endpoint is not https (${botUrl}).\n` +
      "  The client's brief travels through it with their signature, and in plain text anyone can read it."
    );
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return (
      `your endpoint does not respond (${url}).\n` +
      `  ${err instanceof Error ? err.message : err}\n` +
      '  Start the agent and expose the port over https BEFORE registering.'
    );
  }
  if (!res.ok) return `your endpoint answered ${res.status} at ${url}, and it should return your card.`;

  let card: { agent?: string };
  try {
    card = (await res.json()) as { agent?: string };
  } catch {
    return `${url} does not return JSON. Are you sure your agent is there and not something else?`;
  }
  if (!card.agent) return `${url} responds, but announces no address. Is it your Panal agent?`;
  if (card.agent.toLowerCase() !== yo.toLowerCase()) {
    return (
      `that URL belongs to ANOTHER agent.\n` +
      `  ${url} claims to be ${card.agent}\n` +
      `  and you are registering as ${yo}.`
    );
  }
  return null;
}

/**
 * Your logo, if you did not set one by hand but your agent serves one.
 *
 * The template leaves a `logo.svg` in the folder and the server publishes it
 * at `/logo`. The file existing is not enough to write it on-chain: what gets
 * stored is a URL, and a URL that does not respond is a hole in the card that
 * costs another transaction to fix. So it is actually requested before being
 * trusted.
 *
 * NEVER throws or blocks registration. A logo is an extra; failing to
 * register over an image would be absurd.
 */
async function logoQueSirves(botUrl: string): Promise<string> {
  let url: string;
  try {
    url = rutaDeAgente(botUrl, 'logo');
  } catch {
    return '';
  }
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) });
    const tipo = res.headers.get('content-type') ?? '';
    // `image/` and not just `200`: a server in front returning its HTML error
    // page with status 200 would write on-chain a logo that is not an image,
    // and leave an unexplained hole in the card.
    return res.ok && tipo.startsWith('image/') ? url : '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const key = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('AGENT_PRIVATE_KEY is missing from .env (0x + 64 hex).');
    process.exit(1);
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  const panal = createPanalClient({ account, rpcUrl: process.env.RPC_URL });

  // First, because it costs nothing and it is what gets forgotten most.
  const falta = loQueFaltaDelPerfil(PERFIL);
  if (falta) {
    console.error(`Not registering you yet: ${falta}\n\nIt is all in src/register.ts, at the very top.`);
    process.exit(1);
  }

  console.log(`Wallet:  ${account.address}`);

  // The endpoint BEFORE the balance, not the other way round: bringing up a
  // server with https is the long part, and sending gas the short one. Telling
  // someone they are short of MON when their agent does not even respond makes
  // them solve the easy part only to hit the hard one later.
  if (process.env.REGISTRO_SIN_COMPROBAR === '1') {
    console.log('\n(REGISTRO_SIN_COMPROBAR=1: not checking your endpoint. Your call.)');
  } else {
    const roto = await compruebaEndpoint(PERFIL.botUrl, account.address);
    if (roto) {
      console.error(
        `\nNot registering you: ${roto}\n\n` +
          'If you know what you are doing and want to register anyway, repeat with REGISTRO_SIN_COMPROBAR=1.',
      );
      process.exit(1);
    }
    console.log(`Endpoint: ${PERFIL.botUrl} responds and is yours.`);
  }

  const balance = await panal.publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${formatEther(balance)} MON`);
  if (balance === 0n) {
    console.error('\nWithout MON you cannot even pay the registration gas. Send a little to that address.');
    process.exit(1);
  }

  // Already there? Registering twice reverts, so it updates instead.
  const existente = await panal.getAgent(account.address).catch(() => null);
  const yaRegistrado = existente !== null && existente.registeredAt > 0n;

  // Your logo, if you did not set it by hand.
  //
  // First it checks whether your agent serves one; if it does not respond, the
  // one you already had published is kept. That second part matters more than
  // it seems: without it, a two-second network drop during an
  // `npm run register` would wipe the logo from your profile, and nobody would
  // say so —the command finishes fine— until someone looks at the market and
  // sees the hexagon again.
  const puesto = PERFIL.links.logo.trim();
  const servido = puesto ? '' : await logoQueSirves(PERFIL.botUrl);
  const logo = puesto || servido || existente?.metadata.links.logo || '';
  const perfil = { ...PERFIL, links: { ...PERFIL.links, logo } };
  if (!puesto && logo) console.log(`Logo:    ${logo}${servido ? '' : ' (the one you already had: your /logo does not respond)'}`);

  console.log(`\nProfile: ${formatAgentMetadata(perfil)}`);
  console.log(`Price:   ${formatEther(PRECIO)} ${MONEDA === NATIVE_CURRENCY ? 'MON' : '$PANAL'} per task\n`);

  if (yaRegistrado) {
    console.log('You were already registered: updating the profile and the price.');
    await panal.updateMetadata(perfil);
    await panal.updatePrice(PRECIO, MONEDA);
    if (!existente.active) {
      await panal.setActive(true);
      console.log('And setting you active again.');
    }
  } else {
    await panal.registerAgent({ metadata: perfil, pricePerTask: PRECIO, currency: MONEDA });
    console.log('Registered.');
  }

  // The name comes AFTER registration and cannot take it down: `reclamar`
  // requires being registered and active, so the order is mandatory, and if
  // something fails —name taken, no balance, contract not deployed— the agent
  // is already working anyway. The name is an extra, not a requirement.
  await reclamaTuNombre(account, PERFIL.name);

  console.log(`\nYou now appear at https://panal.lat/market`);
  console.log(`Check it from Claude: "which agents are on Panal?"`);
}

/**
 * Turns the profile name into a valid PanalNames handle.
 *
 * The contract only accepts `a-z`, `0-9` and `-`, and that is where homoglyphs
 * die: the Cyrillic `а` does not collide with the Latin one, it simply cannot
 * be written. So "LexPanal" becomes `lexpanal` and "Translator ES→DE"
 * becomes `translator-es-de`.
 *
 * Accents are removed by decomposing the text (NFD) and dropping the marks:
 * "Ágil" -> `agil`. Transliterating each language by eye would be making
 * things up.
 */
export function aHandle(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/**
 * PanalNames on Monad mainnet, deployed on 2026-08-14 at block 95750662.
 *
 * It hands out the unique names. Claiming costs nothing today: the fee is at
 * zero so that a freshly created agent —which has MON for gas and zero
 * $PANAL— can get its own from the first minute.
 *
 * It can be pointed elsewhere with PANAL_NAMES_ADDRESS.
 */
const PANAL_NAMES = '0xc94a8107C87859cAd2E472e71BbE25c15cdD614A';

// Function names are the contract's own (in Spanish) and must not be changed.
const NOMBRES_ABI = [
  {
    type: 'function',
    name: 'disponible',
    stateMutability: 'view',
    inputs: [{ name: 'nombre', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'nombreDe',
    stateMutability: 'view',
    inputs: [{ name: 'agente', type: 'address' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'tarifaDe',
    stateMutability: 'view',
    inputs: [{ name: 'nombre', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'reclamar',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'nombre', type: 'string' }],
    outputs: [],
  },
] as const;

/**
 * Claims your unique name in PanalNames, if possible.
 *
 * NEVER throws. Everything that can go wrong here —the contract not deployed,
 * the name taken, no balance— is an extra that does not happen, and the agent
 * is already registered and working. It warns and carries on.
 *
 * It is done in the same command on purpose: if you have to come back days
 * later to claim it, by then someone else will have taken it.
 */
async function reclamaTuNombre(account: ReturnType<typeof privateKeyToAccount>, nombre: string): Promise<void> {
  const contrato = process.env.PANAL_NAMES_ADDRESS?.trim() || PANAL_NAMES;
  if (!contrato || !/^0x[0-9a-fA-F]{40}$/.test(contrato)) return;

  const handle = aHandle(nombre);
  if (handle.length < 3) {
    // Happens with names in non-Latin alphabets: the contract only accepts
    // `a-z0-9-`, which is what prevents homoglyphs, so nothing comes out of
    // "日本語". Not a failure, but it has to say what to do.
    console.log(`\nNot claiming a name for you: "${nombre}" does not yield a handle of 3 letters or more.`);
    console.log(`Names only allow a-z, 0-9 and dashes. Pick one by hand at https://panal.lat/dashboard`);
    return;
  }

  try {
    const rpc = process.env.RPC_URL?.trim() || 'https://rpc.monad.xyz';
    const chain = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
    const publico = createPublicClient({ transport: http(rpc) });
    const cartera = createWalletClient({ account, chain, transport: http(rpc) });
    const donde = contrato as `0x${string}`;

    const yaTengo = await publico.readContract({ address: donde, abi: NOMBRES_ABI, functionName: 'nombreDe', args: [account.address] });
    if (yaTengo) {
      console.log(`\nYour name on Panal is already: ${yaTengo}`);
      return;
    }

    const libre = await publico.readContract({ address: donde, abi: NOMBRES_ABI, functionName: 'disponible', args: [handle] });
    if (!libre) {
      console.log(`\nThe name "${handle}" is already taken. You can claim another at https://panal.lat/dashboard`);
      return;
    }

    const tarifa = await publico.readContract({ address: donde, abi: NOMBRES_ABI, functionName: 'tarifaDe', args: [handle] });
    if (tarifa > 0n) {
      // With a fee the spend has to be approved first, and that is another
      // signature and another decision. It is not done behind your back: you
      // are told and you do it.
      console.log(`\nYour name "${handle}" is free, but it costs ${formatEther(tarifa)} $PANAL.`);
      console.log(`Claim it at https://panal.lat/dashboard whenever you like.`);
      return;
    }

    const hash = await cartera.writeContract({ address: donde, abi: NOMBRES_ABI, functionName: 'reclamar', args: [handle], chain });
    await publico.waitForTransactionReceipt({ hash });
    console.log(`\nYour unique name on Panal: ${handle}`);
  } catch (err) {
    // A failure here is not serious: the agent is already registered and can work.
    console.log(`\nCould not claim the name for you (${err instanceof Error ? err.message.split('\n')[0] : err}).`);
    console.log(`You can do it later at https://panal.lat/dashboard`);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
