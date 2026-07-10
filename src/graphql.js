// A compact, dependency-free GraphQL query engine for the explorer's schema.
//
// Supports queries with field arguments (string / int / boolean / enum / null),
// bounded nested selection sets, and aliases. It deliberately does NOT
// implement mutations, variables, fragments, or directives — the explorer is
// read-only, and those features are documented as out of scope rather than faked.

const MAX_SOURCE_CHARS = 64 * 1024;
const MAX_TOKENS = 4096;
const MAX_DEPTH = 12;
const MAX_SELECTIONS = 200;
const MAX_ROOT_FIELDS = 25;
const MAX_RESULT_CHARS = 4 * 1024 * 1024;

// ---- lexer ----------------------------------------------------------------

function lex(src) {
  if (typeof src !== 'string') throw new Error('query must be a string');
  if (src.length > MAX_SOURCE_CHARS) throw new Error('query exceeds 64 KiB limit');
  const toks = [];
  let i = 0;
  const punct = '{}():!,[]';
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/\s|,/.test(c)) {
      i++;
      continue;
    }
    if (punct.includes(c)) {
      if (c !== ',' && c !== '!') toks.push({ t: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      let s = '';
      while (j < src.length && /[-0-9.]/.test(src[j])) {
        s += src[j];
        j++;
      }
      const value = Number(s);
      if (!Number.isFinite(value)) throw new Error('number is not finite');
      toks.push({ t: 'num', v: value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      let s = '';
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) {
        s += src[j];
        j++;
      }
      toks.push({ t: 'name', v: s });
      i = j;
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
  if (toks.length > MAX_TOKENS) {
    throw new Error(`query exceeds ${MAX_TOKENS} token limit`);
  }
  return toks;
}

// ---- parser ---------------------------------------------------------------

function parse(src) {
  const toks = lex(src);
  let p = 0;
  let selectionsSeen = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    const tok = toks[p];
    if (!tok || (t && tok.t !== t)) throw new Error(`expected ${t || 'token'}, got ${tok ? tok.t : 'EOF'}`);
    p++;
    return tok;
  };

  function parseValue() {
    const tok = eat();
    if (tok.t === 'str' || tok.t === 'num') return tok.v;
    if (tok.t === 'name') {
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return tok.v; // bare enum value
    }
    throw new Error(`bad argument value '${tok.t}'`);
  }

  function parseArgs() {
    const args = {};
    if (peek() && peek().t === '(') {
      eat('(');
      while (peek() && peek().t !== ')') {
        const name = eat('name').v;
        eat(':');
        args[name] = parseValue();
      }
      eat(')');
    }
    return args;
  }

  function parseSelectionSet(depth = 1) {
    if (depth > MAX_DEPTH) throw new Error(`query exceeds maximum depth ${MAX_DEPTH}`);
    eat('{');
    const sels = [];
    while (peek() && peek().t !== '}') {
      selectionsSeen += 1;
      if (selectionsSeen > MAX_SELECTIONS) {
        throw new Error(`query exceeds ${MAX_SELECTIONS} selected fields`);
      }
      let name = eat('name').v;
      let alias = name;
      if (peek() && peek().t === ':') {
        eat(':');
        alias = name;
        name = eat('name').v;
      }
      const args = parseArgs();
      let selectionSet = null;
      if (peek() && peek().t === '{') selectionSet = parseSelectionSet(depth + 1);
      sels.push({ name, alias, args, selectionSet });
    }
    eat('}');
    return sels;
  }

  // Optional `query` keyword + optional operation name, then the selection set.
  if (peek() && peek().t === 'name' && peek().v === 'query') {
    eat('name');
    if (peek() && peek().t === 'name') eat('name');
  }
  const set = parseSelectionSet();
  if (set.length > MAX_ROOT_FIELDS) throw new Error(`query exceeds ${MAX_ROOT_FIELDS} root fields`);
  if (p !== toks.length) throw new Error(`unexpected token '${toks[p]?.t ?? 'EOF'}'`);
  return set;
}

// ---- executor -------------------------------------------------------------

async function project(value, selectionSet) {
  if (value === null || value === undefined) return null;
  if (!selectionSet) return value; // leaf: a scalar, or a raw JSON object
  if (Array.isArray(value)) return Promise.all(value.map((v) => project(v, selectionSet)));
  const out = {};
  for (const sel of selectionSet) {
    out[sel.alias] = await project(value[sel.name], sel.selectionSet);
  }
  return out;
}

export async function executeGraphql(source, ctx, roots) {
  let selections;
  try {
    selections = parse(source || '');
  } catch (e) {
    return { errors: [{ message: `Syntax error: ${e.message}` }] };
  }
  const data = {};
  const errors = [];
  let resultChars = 0;
  for (const sel of selections) {
    const resolver = roots[sel.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field '${sel.name}' on Query` });
      data[sel.alias] = null;
      continue;
    }
    try {
      const value = await resolver(sel.args, ctx);
      const projected = await project(value, sel.selectionSet);
      const encoded = JSON.stringify(projected);
      if (resultChars + encoded.length > MAX_RESULT_CHARS) {
        throw new Error('query result exceeds 4 MiB limit; request fewer fields');
      }
      resultChars += encoded.length;
      data[sel.alias] = projected;
    } catch (e) {
      errors.push({ message: `${sel.name}: ${e.message}` });
      data[sel.alias] = null;
    }
  }
  return errors.length ? { data, errors } : { data };
}

// ---- root resolvers over the explorer store -------------------------------

export const schemaRoots = {
  head: (_a, { store }) => store.block(store.tipHeight),
  block: (a, { store }) =>
    store.block(a.hash !== undefined ? String(a.hash).toLowerCase() : Number(a.height)),
  transaction: (a, { store }) => store.tx(String(a.id).toLowerCase()),
  account: async (a, { rpc, store }) => {
    const acc = await rpc.account(a.id).catch(() => null);
    if (!acc) return null;
    return {
      id: a.id,
      balance: acc.balance,
      locked: acc.locked,
      nonce: acc.nonce,
      unlockHeight: acc.unlock_height,
      key: acc.key,
      isContract: !!acc.code,
      transactions: store.accountTxs(
        a.id,
        Math.max(0, Math.min(100, Number.isFinite(Number(a.limit)) ? Math.trunc(Number(a.limit)) : 25)),
      ),
    };
  },
  supply: (_a, { store }) => store.supply,
  stats: (_a, { store }) => store.stats(),
  validators: (_a, { store }) => store.validators(),
  observedMiners: (_a, { store }) => store.observedMiners(),
  miners: (_a, { store }) => store.miners,
  search: (a, { store }) => store.search(a.q),
};
