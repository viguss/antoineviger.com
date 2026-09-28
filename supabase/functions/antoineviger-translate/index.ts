// PERSO Antoine Viger : relais Claude pour https://antoineviger.com/translate
// Hébergé dans le projet Supabase Autopilote mais sans lien avec lui.
// - La clé API Anthropic reste ici (secret ANTOINEVIGER_ANTHROPIC_API_KEY), jamais sur les téléphones.
// - Chaque appel doit porter le code famille (secret ANTOINEVIGER_TRANSLATE_CODE).
// - Plafond d'appels par jour, compté dans antoineviger.translate_usage.
// - Les prompts sont construits ici : le relais ne sert qu'à traduire, pas de prompt libre.
import Anthropic from 'npm:@anthropic-ai/sdk@0.126.0';
import postgres from 'npm:postgres@3.4.5';

const ALLOWED_ORIGINS = ['https://antoineviger.com', 'https://www.antoineviger.com', 'http://localhost:5288'];
const MODEL = 'claude-opus-5';
const DAILY_LIMIT = Number(Deno.env.get('ANTOINEVIGER_TRANSLATE_DAILY_LIMIT') ?? 200);
const MAX_TEXT = 400;
const CODES = ['fr', 'en', 'ro'];
const NAMES: Record<string, string> = { fr: 'French', en: 'English', ro: 'Romanian' };

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1 });

let client: Anthropic | null = null;
function anthropic(): Anthropic | null {
  const apiKey = Deno.env.get('ANTOINEVIGER_ANTHROPIC_API_KEY');
  if (!apiKey) return null;
  if (!client) {
    // Keys that aren't attached to a workspace need the anthropic-workspace-id header
    const ws = Deno.env.get('ANTOINEVIGER_ANTHROPIC_WORKSPACE_ID');
    client = new Anthropic({ apiKey, maxRetries: 1, defaultHeaders: ws ? { 'anthropic-workspace-id': ws } : {} });
  }
  return client;
}

const translatePrompt = (src: string, text: string) =>
`You are the translation helper of a couple learning English together: Antoine speaks French, Bianca speaks Romanian.
Text typed in the ${NAMES[src]} box:
"""
${text}
"""
Give it in French, English and Romanian. Keep the meaning, tone and register. For a single word, give the most natural everyday equivalent (verbs in the infinitive, e.g. "to miss"). Use correct Romanian diacritics (ă â î ș ț).
If the text is clearly written in one of the other two languages rather than ${NAMES[src]}, set "detected" to that language's code and translate from it.`;

const detailsPrompt = (src: string, t: Record<string, string>) =>
`You help two people learning English (one native French speaker, one native Romanian speaker) understand exactly what a word or phrase means.
French: "${t.fr}"
English: "${t.en}"
Romanian: "${t.ro}"
(first typed in ${NAMES[src]})

Rules:
- sense: one short sentence per language, written in that language, explaining what it means. Use simple English for "en".
- alternatives: 2 to 4 per language, written in that language: synonyms or close words. Each nuance is at most 8 words, in the same language, saying how it differs (more formal, stronger, slang, only for places…). If the text is a whole sentence, give other natural ways to say it.
- examples: 3 short everyday sentences that say the same thing in the three languages. In each sentence, wrap the word (or its equivalent) in **double asterisks**.
- tip: one short sentence in simple English about a trap for French or Romanian speakers (false friend, word order, common mistake), or "" if there is none.
Use correct Romanian diacritics.`;

const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const S = { type: 'string' };
const ALTS = { type: 'array', items: obj({ word: S, nuance: S }) };
const TRANSLATION_SCHEMA = obj({ detected: { type: 'string', enum: CODES }, fr: S, en: S, ro: S });
const DETAILS_SCHEMA = obj({
  sense: obj({ fr: S, en: S, ro: S }),
  alternatives: obj({ fr: ALTS, en: ALTS, ro: ALTS }),
  examples: { type: 'array', items: obj({ fr: S, en: S, ro: S }) },
  tip: S,
});

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}
const reply = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

// Constant-time comparison so the code can't be guessed character by character
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'method' });

  let body: any;
  try { body = await req.json(); } catch { return reply(req, 400, { error: 'bad_request' }); }

  const expected = Deno.env.get('ANTOINEVIGER_TRANSLATE_CODE') ?? '';
  if (!expected || !sameSecret(str(body?.code), expected)) return reply(req, 401, { error: 'bad_code' });
  if (body.kind === 'check') return reply(req, 200, { ok: true });

  const api = anthropic();
  if (!api) return reply(req, 503, { error: 'server_key' });

  let prompt: string, schema: unknown, effort: string;
  const src = body.src;
  if (body.kind === 'translate') {
    const text = str(body.text);
    if (!CODES.includes(src) || !text || text.length > MAX_TEXT) return reply(req, 400, { error: 'bad_request' });
    prompt = translatePrompt(src, text);
    schema = TRANSLATION_SCHEMA;
    effort = 'low';
  } else if (body.kind === 'details') {
    const t: Record<string, string> = {};
    for (const l of CODES) t[l] = str(body.t?.[l]);
    if (!CODES.includes(src) || CODES.some((l) => t[l].length > MAX_TEXT) || !CODES.some((l) => t[l])) {
      return reply(req, 400, { error: 'bad_request' });
    }
    prompt = detailsPrompt(src, t);
    schema = DETAILS_SCHEMA;
    effort = 'medium';
  } else {
    return reply(req, 400, { error: 'bad_request' });
  }

  try {
    const [{ calls }] = await sql`
      insert into antoineviger.translate_usage (day, calls) values (current_date, 1)
      on conflict (day) do update set calls = antoineviger.translate_usage.calls + 1, updated_at = now()
      returning calls`;
    if (calls > DAILY_LIMIT) return reply(req, 429, { error: 'daily_limit' });
  } catch (e) {
    console.error('usage counter', e);
    return reply(req, 503, { error: 'upstream_error' });
  }

  try {
    const res: any = await api.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    } as any, { signal: req.signal });
    if (res.stop_reason === 'refusal') return reply(req, 422, { error: 'refused' });
    const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return reply(req, 200, { result: JSON.parse(text) });
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) return reply(req, 499, { error: 'cancelled' });
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      console.error('anthropic auth', e.message);
      return reply(req, 503, { error: 'server_key' });
    }
    if (e instanceof Anthropic.RateLimitError) return reply(req, 429, { error: 'rate_limited' });
    if (e instanceof Anthropic.BadRequestError) {
      const m = String(e.message || '');
      console.error('anthropic 400', m);
      return reply(req, 502, { error: /credit/i.test(m) ? 'no_credit' : /workspace/i.test(m) ? 'server_key' : 'upstream_error' });
    }
    if (e instanceof SyntaxError) return reply(req, 502, { error: 'invalid_json' });
    console.error('anthropic', e);
    return reply(req, 502, { error: 'upstream_error' });
  }
});
